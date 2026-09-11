import { useEffect, useRef, useState } from "react";
import { closeWidgetQuickActions, getFloatingWidgetVisible, getPreferences, getQuotaState, hideFloatingWidget, listenDesktopEvents, requestQuotaRefresh, setWidgetPositionLocked, showFloatingWidget } from "../lib/bridge";
import { panelAccentColor } from "../lib/skin";
import type { QuotaState, WidgetPreferences } from "../types";
import { WidgetQuickActions } from "./WidgetQuickActions";

export function WidgetQuickActionsWindow() {
  const [preferences, setPreferences] = useState<WidgetPreferences | null>(null);
  const [tokens, setTokens] = useState<number | null>(null);
  const [visible, setVisible] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const revision = useRef(-1);

  useEffect(() => {
    let disposed = false;
    let dispose = () => {};
    const applyQuota = (state: QuotaState) => {
      if (disposed || state.revision < revision.current) return;
      revision.current = state.revision;
      setTokens(state.snapshots[0]?.localUsage?.today.totalTokens ?? null);
    };
    const sync = () => {
      void getPreferences().then(value => { if (!disposed) setPreferences(value); }).catch(() => {});
      void getQuotaState().then(applyQuota).catch(() => {});
      void getFloatingWidgetVisible().then(value => { if (!disposed && !inFlight.current) setVisible(value); }).catch(() => {});
    };
    sync();
    void listenDesktopEvents({
      onPreferences: value => { if (!disposed) setPreferences(value); },
      onQuotaState: applyQuota,
      onUpdate: () => {},
    }).then(cleanup => { if (disposed) cleanup(); else dispose = cleanup; }).catch(() => {});
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") void closeWidgetQuickActions();
    };
    window.addEventListener("focus", sync);
    window.addEventListener("keydown", escape);
    return () => {
      disposed = true;
      dispose();
      window.removeEventListener("focus", sync);
      window.removeEventListener("keydown", escape);
    };
  }, []);

  const run = async (action: () => Promise<unknown>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
      await closeWidgetQuickActions();
    } catch {
      setError(preferences?.language === "en" ? "Action failed. Please retry." : "操作失败，请重试");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return <div className="widget-quick-window" onContextMenu={event => event.preventDefault()}>
    {preferences && <WidgetQuickActions
      language={preferences.language}
      accentColor={panelAccentColor(preferences)}
      widgetSize={preferences.widgetSize}
      positionLocked={preferences.positionLocked}
      todayTokens={tokens}
      visible={visible}
      busy={busy}
      onRefresh={() => void run(requestQuotaRefresh)}
      onHide={() => void run(async () => {
        if (visible) {
          const next = await hideFloatingWidget();
          if (next) throw new Error("widget remained visible");
          setVisible(false);
        } else {
          await showFloatingWidget();
          setVisible(true);
        }
      })}
      onTogglePositionLock={() => void run(async () => {
        const next = await setWidgetPositionLocked(!preferences.positionLocked);
        setPreferences(next);
      })}
    />}
    {error && <span className="widget-quick-window__error" role="alert">{error}</span>}
  </div>;
}
