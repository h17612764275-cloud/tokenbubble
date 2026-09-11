use crate::models::ProviderSnapshot;
use serde::Serialize;
use std::{
    future::Future,
    sync::{Arc, OnceLock},
    time::Duration,
};
use tokio::{
    sync::{broadcast, Mutex, Notify},
    time::Instant,
};

pub const HEALTHY_REFRESH_DELAY: Duration = Duration::from_secs(60);

pub fn retry_delay(failure_count: u32) -> Duration {
    let seconds = match failure_count {
        0 | 1 => 2,
        2 => 5,
        3 => 10,
        _ => 30,
    };
    Duration::from_secs(seconds)
}

pub fn next_refresh_delay(state: &QuotaState) -> Duration {
    if state.failure_count == 0 {
        HEALTHY_REFRESH_DELAY
    } else {
        retry_delay(state.failure_count)
    }
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QuotaState {
    pub snapshots: Vec<ProviderSnapshot>,
    pub revision: u64,
    pub refreshing: bool,
    pub failure_count: u32,
}

struct CoordinatorInner {
    state: Mutex<CoordinatorState>,
    changed: broadcast::Sender<QuotaState>,
}

#[derive(Default)]
struct CoordinatorState {
    public: QuotaState,
    next_generation: u64,
    active: Option<Arc<Flight>>,
    cached_expires_at: Option<Instant>,
}

struct Flight {
    generation: u64,
    terminal: OnceLock<QuotaState>,
    completed: Notify,
}

impl Flight {
    fn new(generation: u64) -> Self {
        Self {
            generation,
            terminal: OnceLock::new(),
            completed: Notify::new(),
        }
    }
}

#[derive(Clone)]
pub struct QuotaCoordinator {
    inner: Arc<CoordinatorInner>,
}

impl Default for QuotaCoordinator {
    fn default() -> Self {
        Self::new()
    }
}

impl QuotaCoordinator {
    pub fn new() -> Self {
        Self::from_initial_state(Vec::new(), None)
    }

    pub fn with_cached_snapshots(
        snapshots: Vec<ProviderSnapshot>,
        valid_for: Duration,
    ) -> Self {
        Self::from_initial_state(snapshots, Some(Instant::now() + valid_for))
    }

    fn from_initial_state(
        snapshots: Vec<ProviderSnapshot>,
        cached_expires_at: Option<Instant>,
    ) -> Self {
        let (changed, _) = broadcast::channel(16);
        Self {
            inner: Arc::new(CoordinatorInner {
                state: Mutex::new(CoordinatorState {
                    public: QuotaState {
                        snapshots,
                        ..QuotaState::default()
                    },
                    cached_expires_at,
                    ..CoordinatorState::default()
                }),
                changed,
            }),
        }
    }

    pub async fn current(&self) -> QuotaState {
        self.inner.state.lock().await.public.clone()
    }

    pub fn subscribe(&self) -> broadcast::Receiver<QuotaState> {
        self.inner.changed.subscribe()
    }

    pub async fn expire_cached_when_due(&self) {
        self.expire_cached_while(|| true).await;
    }

    pub async fn expire_cached_while(&self, auth_is_current: impl Fn() -> bool) {
        loop {
            let deadline = {
                let state = self.inner.state.lock().await;
                state.cached_expires_at
            };
            let Some(deadline) = deadline else { return; };
            if deadline <= Instant::now() || !auth_is_current() {
                let mut state = self.inner.state.lock().await;
                if state.cached_expires_at != Some(deadline) { continue; }
                state.cached_expires_at = None;
                state.public.snapshots = vec![ProviderSnapshot::failure(
                    "unavailable", "Cached quota expired or login changed. It will retry automatically.",
                )];
                state.public.revision = state.public.revision.saturating_add(1);
                let _ = self.inner.changed.send(state.public.clone());
                return;
            }
            tokio::time::sleep_until(deadline.min(Instant::now() + Duration::from_millis(250))).await;
        }
    }

    pub async fn refresh_with<F, Fut>(&self, fetch: F) -> QuotaState
    where
        F: FnOnce() -> Fut + Send + 'static,
        Fut: Future<Output = Vec<ProviderSnapshot>> + Send + 'static,
    {
        let (flight, starts_fetch) = {
            let mut state = self.inner.state.lock().await;
            if let Some(flight) = &state.active {
                (flight.clone(), false)
            } else {
                state.next_generation = state.next_generation.saturating_add(1);
                let flight = Arc::new(Flight::new(state.next_generation));
                state.public.refreshing = true;
                state.public.revision = state.public.revision.saturating_add(1);
                state.active = Some(flight.clone());
                let _ = self.inner.changed.send(state.public.clone());
                (flight, true)
            }
        };

        if starts_fetch {
            let coordinator = self.clone();
            let task_flight = flight.clone();
            tokio::spawn(async move {
                let fetched = match tokio::spawn(fetch()).await {
                    Ok(snapshots) => snapshots,
                    Err(_) => vec![ProviderSnapshot::failure(
                        "unavailable",
                        "Quota refresh failed. It will retry automatically.",
                    )],
                };
                coordinator.finish_refresh(task_flight, fetched).await;
            });
        }

        Self::wait_for_terminal_state(flight).await
    }

    async fn wait_for_terminal_state(flight: Arc<Flight>) -> QuotaState {
        loop {
            let notified = flight.completed.notified();
            if let Some(terminal) = flight.terminal.get() {
                return terminal.clone();
            }
            notified.await;
        }
    }

    async fn finish_refresh(&self, flight: Arc<Flight>, snapshots: Vec<ProviderSnapshot>) {
        let terminal = {
            let mut state = self.inner.state.lock().await;
            if state.active.as_ref().map(|active| active.generation) != Some(flight.generation) {
                return;
            }
            let had_transient_failure = snapshots
                .iter()
                .any(|snapshot| snapshot.status == "unavailable");
            let cached_snapshot_expired = state
                .cached_expires_at
                .is_some_and(|expires_at| expires_at <= Instant::now());
            let previous = if cached_snapshot_expired {
                Vec::new()
            } else {
                state.public.snapshots.clone()
            };
            state.public.snapshots = merge_snapshots(&previous, snapshots);
            if !had_transient_failure || cached_snapshot_expired {
                state.cached_expires_at = None;
            }
            state.public.refreshing = false;
            state.public.failure_count = if had_transient_failure {
                state.public.failure_count.saturating_add(1)
            } else {
                0
            };
            state.public.revision = state.public.revision.saturating_add(1);
            let terminal = state.public.clone();
            let _ = flight.terminal.set(terminal.clone());
            let _ = self.inner.changed.send(terminal.clone());
            state.active = None;
            terminal
        };
        debug_assert_eq!(flight.terminal.get(), Some(&terminal));
        flight.completed.notify_waiters();
    }
}

pub async fn recv_next_state(
    receiver: &mut broadcast::Receiver<QuotaState>,
) -> Option<QuotaState> {
    loop {
        match receiver.recv().await {
            Ok(state) => return Some(state),
            Err(broadcast::error::RecvError::Lagged(_)) => continue,
            Err(broadcast::error::RecvError::Closed) => return None,
        }
    }
}

pub async fn wait_for_refresh_due(
    receiver: &mut broadcast::Receiver<QuotaState>,
    completed: QuotaState,
) -> Option<QuotaState> {
    wait_for_refresh_due_with(receiver, completed, next_refresh_delay).await
}

async fn wait_for_refresh_due_with<F>(
    receiver: &mut broadcast::Receiver<QuotaState>,
    mut completed: QuotaState,
    delay_for: F,
) -> Option<QuotaState>
where
    F: Fn(&QuotaState) -> Duration,
{
    let mut deadline = Instant::now() + delay_for(&completed);
    loop {
        tokio::select! {
            _ = tokio::time::sleep_until(deadline) => return Some(completed),
            next = recv_next_state(receiver) => {
                let next = next?;
                if !next.refreshing && next.revision > completed.revision {
                    completed = next;
                    deadline = Instant::now() + delay_for(&completed);
                }
            }
        }
    }
}

fn merge_snapshots(
    previous: &[ProviderSnapshot],
    fetched: Vec<ProviderSnapshot>,
) -> Vec<ProviderSnapshot> {
    fetched
        .into_iter()
        .map(|failure| {
            if failure.status != "unavailable" {
                return failure;
            }
            let Some(last_good) = previous.iter().find(|snapshot| {
                snapshot.provider == failure.provider
                    && (snapshot.short_window.is_some() || snapshot.weekly_window.is_some())
                    && (snapshot.status == "ok" || snapshot.status == "stale")
            }) else {
                return failure;
            };
            last_good.clone()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{recv_next_state, retry_delay, wait_for_refresh_due_with, QuotaCoordinator, QuotaState};
    use crate::models::{ProviderSnapshot, UsageWindow};
    use std::{
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        },
        time::Duration,
    };
    use tokio::sync::Notify;

    fn successful_snapshot() -> ProviderSnapshot {
        ProviderSnapshot {
            provider: "codex".into(),
            display_name: "CODEX".into(),
            plan: Some("PLUS".into()),
            short_window: Some(UsageWindow {
                remaining_percent: 75.0,
                resets_at: Some("2026-08-12T12:00:00Z".into()),
                window_seconds: 18_000,
            }),
            weekly_window: None,
            spark_weekly_window: None,
            reset_credits: None,
            reset_credit_expires_at: Vec::new(),
            daily_token_usage: None,
            lifetime_tokens: None,
            peak_daily_tokens: None,
            local_usage: None,
            updated_at: "2026-08-12T07:00:00Z".into(),
            status: "ok".into(),
            message: None,
        }
    }

    #[tokio::test]
    async fn login_change_invalidates_startup_cache_before_ttl() {
        let coordinator = QuotaCoordinator::with_cached_snapshots(vec![successful_snapshot()], Duration::from_secs(900));
        coordinator.expire_cached_while(|| false).await;
        let state = coordinator.current().await;
        assert_eq!(state.snapshots[0].status, "unavailable");
        assert!(state.snapshots[0].short_window.is_none());
        assert_eq!(state.revision, 1);
    }

    #[tokio::test]
    async fn concurrent_refresh_callers_share_one_fetch_and_terminal_state() {
        let coordinator = QuotaCoordinator::new();
        let calls = Arc::new(AtomicUsize::new(0));
        let started = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());

        let first = {
            let coordinator = coordinator.clone();
            let calls = calls.clone();
            let started = started.clone();
            let release = release.clone();
            tokio::spawn(async move {
                coordinator
                    .refresh_with(move || async move {
                        calls.fetch_add(1, Ordering::SeqCst);
                        started.notify_one();
                        release.notified().await;
                        vec![successful_snapshot()]
                    })
                    .await
            })
        };
        started.notified().await;
        let second = {
            let coordinator = coordinator.clone();
            let calls = calls.clone();
            tokio::spawn(async move {
                coordinator
                    .refresh_with(move || async move {
                        calls.fetch_add(1, Ordering::SeqCst);
                        vec![ProviderSnapshot::failure("unavailable", "must not run")]
                    })
                    .await
            })
        };
        tokio::task::yield_now().await;
        release.notify_one();

        let first = first.await.unwrap();
        let second = second.await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(first.revision, second.revision);
        assert_eq!(first.snapshots[0].status, "ok");
        assert_eq!(second.snapshots[0].status, "ok");
    }

    #[tokio::test]
    async fn transient_failure_after_success_keeps_last_good_quota_visible() {
        let coordinator = QuotaCoordinator::new();
        let success = successful_snapshot();
        let successful_updated_at = success.updated_at.clone();
        coordinator
            .refresh_with(move || async move { vec![success] })
            .await;

        let state = coordinator
            .refresh_with(|| async {
                vec![ProviderSnapshot::failure(
                    "unavailable",
                    "temporary failure",
                )]
            })
            .await;

        assert_eq!(state.failure_count, 1);
        assert_eq!(state.snapshots[0].status, "ok");
        assert_eq!(state.snapshots[0].updated_at, successful_updated_at);
        assert_eq!(
            state.snapshots[0]
                .short_window
                .as_ref()
                .unwrap()
                .remaining_percent,
            75.0
        );
    }

    #[tokio::test]
    async fn cached_startup_snapshot_survives_initial_transient_failure() {
        let cached = successful_snapshot();
        let cached_updated_at = cached.updated_at.clone();
        let coordinator =
            QuotaCoordinator::with_cached_snapshots(vec![cached], Duration::from_secs(60));

        let state = coordinator
            .refresh_with(|| async {
                vec![ProviderSnapshot::failure(
                    "unavailable",
                    "temporary startup failure",
                )]
            })
            .await;

        assert_eq!(state.failure_count, 1);
        assert_eq!(state.snapshots[0].status, "ok");
        assert_eq!(state.snapshots[0].updated_at, cached_updated_at);
        assert_eq!(
            state.snapshots[0]
                .short_window
                .as_ref()
                .unwrap()
                .remaining_percent,
            75.0
        );
    }

    #[tokio::test]
    async fn expired_cached_startup_snapshot_is_not_retained() {
        let coordinator = QuotaCoordinator::with_cached_snapshots(
            vec![successful_snapshot()],
            Duration::ZERO,
        );

        let state = coordinator
            .refresh_with(|| async {
                vec![ProviderSnapshot::failure(
                    "unavailable",
                    "temporary startup failure",
                )]
            })
            .await;

        assert_eq!(state.failure_count, 1);
        assert_eq!(state.snapshots[0].status, "unavailable");
        assert!(state.snapshots[0].short_window.is_none());
    }

    #[tokio::test]
    async fn cached_startup_snapshot_expires_without_waiting_for_a_refresh() {
        let coordinator = QuotaCoordinator::with_cached_snapshots(
            vec![successful_snapshot()],
            Duration::from_millis(20),
        );
        let mut changed = coordinator.subscribe();
        let expiry_coordinator = coordinator.clone();
        tokio::spawn(async move {
            expiry_coordinator.expire_cached_when_due().await;
        });

        let state = tokio::time::timeout(Duration::from_secs(1), recv_next_state(&mut changed))
            .await
            .unwrap()
            .unwrap();

        assert_eq!(state.revision, 1);
        assert_eq!(state.snapshots[0].status, "unavailable");
        assert!(state.snapshots[0].short_window.is_none());
    }

    #[tokio::test]
    async fn live_success_cancels_cached_startup_expiry() {
        let coordinator = QuotaCoordinator::with_cached_snapshots(
            vec![successful_snapshot()],
            Duration::from_millis(20),
        );
        let expiry_coordinator = coordinator.clone();
        let expiry_task = tokio::spawn(async move {
            expiry_coordinator.expire_cached_when_due().await;
        });
        let mut fresh = successful_snapshot();
        fresh.short_window.as_mut().unwrap().remaining_percent = 42.0;

        coordinator
            .refresh_with(move || async move { vec![fresh] })
            .await;
        expiry_task.await.unwrap();

        let state = coordinator.current().await;
        assert_eq!(state.snapshots[0].status, "ok");
        assert_eq!(
            state.snapshots[0]
                .short_window
                .as_ref()
                .unwrap()
                .remaining_percent,
            42.0
        );
    }

    #[tokio::test]
    async fn signed_out_after_success_clears_prior_quota_authoritatively() {
        let coordinator = QuotaCoordinator::new();
        coordinator
            .refresh_with(|| async { vec![successful_snapshot()] })
            .await;

        let state = coordinator
            .refresh_with(|| async {
                vec![ProviderSnapshot::failure(
                    "signed_out",
                    "sign in required",
                )]
            })
            .await;

        assert_eq!(state.failure_count, 0);
        assert_eq!(state.snapshots[0].status, "signed_out");
        assert!(state.snapshots[0].short_window.is_none());
        assert!(state.snapshots[0].weekly_window.is_none());
    }

    #[test]
    fn retry_delay_sequence_is_bounded_exponential_schedule() {
        let seconds = (1..=5)
            .map(|failure_count| retry_delay(failure_count).as_secs())
            .collect::<Vec<_>>();
        assert_eq!(seconds, vec![2, 5, 10, 30, 30]);
        assert_eq!(retry_delay(6).as_secs(), 30);
    }

    #[tokio::test]
    async fn revision_changes_and_completed_state_is_broadcast_identically() {
        let coordinator = QuotaCoordinator::new();
        let initial = coordinator.current().await;
        let mut first_listener = coordinator.subscribe();
        let mut second_listener = coordinator.subscribe();

        let returned = coordinator
            .refresh_with(|| async { vec![successful_snapshot()] })
            .await;
        let first_refreshing = first_listener.recv().await.unwrap();
        let first_completed = first_listener.recv().await.unwrap();
        let second_refreshing = second_listener.recv().await.unwrap();
        let second_completed = second_listener.recv().await.unwrap();

        assert!(first_refreshing.refreshing);
        assert!(second_refreshing.refreshing);
        assert!(returned.revision > initial.revision);
        assert_eq!(first_completed, returned);
        assert_eq!(second_completed, returned);
    }

    #[tokio::test]
    async fn joined_waiter_returns_its_flight_terminal_after_next_flight_starts() {
        for _ in 0..100 {
            let coordinator = QuotaCoordinator::new();
            let first_started = Arc::new(Notify::new());
            let release_first = Arc::new(Notify::new());
            let second_started = Arc::new(Notify::new());
            let release_second = Arc::new(Notify::new());

            let leader = {
                let coordinator = coordinator.clone();
                let first_started = first_started.clone();
                let release_first = release_first.clone();
                tokio::spawn(async move {
                    coordinator
                        .refresh_with(move || async move {
                            first_started.notify_one();
                            release_first.notified().await;
                            vec![successful_snapshot()]
                        })
                        .await
                })
            };
            first_started.notified().await;
            let waiter = {
                let coordinator = coordinator.clone();
                tokio::spawn(async move {
                    coordinator
                        .refresh_with(|| async {
                            vec![ProviderSnapshot::failure("unavailable", "must not run")]
                        })
                        .await
                })
            };
            let mut events = coordinator.subscribe();
            let next_flight = {
                let coordinator = coordinator.clone();
                let second_started = second_started.clone();
                let release_second = release_second.clone();
                tokio::spawn(async move {
                    loop {
                        let state = events.recv().await.unwrap();
                        if !state.refreshing {
                            break;
                        }
                    }
                    coordinator
                        .refresh_with(move || async move {
                            second_started.notify_one();
                            release_second.notified().await;
                            let mut next = successful_snapshot();
                            next.plan = Some("PRO".into());
                            vec![next]
                        })
                        .await
                })
            };

            release_first.notify_one();
            second_started.notified().await;
            let joined = tokio::time::timeout(Duration::from_millis(50), waiter).await;
            release_second.notify_one();
            let first = leader.await.unwrap();
            let next = next_flight.await.unwrap();
            let joined = joined
                .expect("joined waiter followed the next generation")
                .unwrap();
            assert_eq!(joined, first);
            assert_ne!(joined.revision, next.revision);
        }
    }

    #[tokio::test]
    async fn panicking_fetch_finishes_without_hanging_and_keeps_last_good_snapshot() {
        let coordinator = QuotaCoordinator::new();
        coordinator
            .refresh_with(|| async { vec![successful_snapshot()] })
            .await;

        let terminal = tokio::time::timeout(
            Duration::from_millis(100),
            coordinator.refresh_with(|| async {
                panic!("fetch panic");
            }),
        )
        .await
        .expect("panicking fetch left refreshing stuck");

        assert!(!terminal.refreshing);
        assert_eq!(terminal.failure_count, 1);
        assert_eq!(terminal.snapshots[0].status, "ok");
    }

    #[tokio::test]
    async fn scheduler_deadline_resets_after_newer_manual_completion() {
        let (sender, mut receiver) = tokio::sync::broadcast::channel(8);
        let initial = QuotaState {
            revision: 2,
            failure_count: 1,
            ..QuotaState::default()
        };
        let scheduled = tokio::spawn(async move {
            wait_for_refresh_due_with(&mut receiver, initial, |_| Duration::from_millis(60)).await
        });

        tokio::time::sleep(Duration::from_millis(40)).await;
        sender
            .send(QuotaState {
                revision: 4,
                failure_count: 0,
                ..QuotaState::default()
            })
            .unwrap();
        assert!(tokio::time::timeout(Duration::from_millis(35), scheduled)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn lagged_receiver_skips_gap_and_continues_to_latest_state() {
        let (sender, mut receiver) = tokio::sync::broadcast::channel(1);
        sender
            .send(QuotaState {
                revision: 1,
                ..QuotaState::default()
            })
            .unwrap();
        sender
            .send(QuotaState {
                revision: 2,
                ..QuotaState::default()
            })
            .unwrap();

        let received = recv_next_state(&mut receiver).await.unwrap();
        assert_eq!(received.revision, 2);
    }

    #[tokio::test]
    async fn subscription_revisions_never_decrease_when_next_flight_starts_immediately() {
        let coordinator = QuotaCoordinator::new();
        let mut events = coordinator.subscribe();
        let first = {
            let coordinator = coordinator.clone();
            tokio::spawn(async move {
                coordinator
                    .refresh_with(|| async { vec![successful_snapshot()] })
                    .await
            })
        };
        let second = {
            let coordinator = coordinator.clone();
            tokio::spawn(async move {
                loop {
                    let state = coordinator.current().await;
                    if state.revision == 2 && !state.refreshing {
                        break;
                    }
                    tokio::task::yield_now().await;
                }
                coordinator
                    .refresh_with(|| async {
                        let mut next = successful_snapshot();
                        next.plan = Some("PRO".into());
                        vec![next]
                    })
                    .await
            })
        };

        first.await.unwrap();
        second.await.unwrap();
        let mut revisions = Vec::new();
        for _ in 0..4 {
            revisions.push(events.recv().await.unwrap().revision);
        }
        assert_eq!(revisions, vec![1, 2, 3, 4]);
    }
}
