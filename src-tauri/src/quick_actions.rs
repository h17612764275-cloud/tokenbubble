use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize};

// Clamp only the menu, leaving the orb's window and drag bounds unchanged.
fn menu_position(
    orb: PhysicalPosition<i32>,
    orb_size: PhysicalSize<u32>,
    menu: PhysicalSize<u32>,
    bounds: PhysicalPosition<i32>,
    bounds_size: PhysicalSize<u32>,
) -> PhysicalPosition<i32> {
    let right = bounds.x + bounds_size.width as i32;
    let bottom = bounds.y + bounds_size.height as i32;
    let x = orb.x + (orb_size.width as i32 - menu.width as i32) / 2;
    let below = orb.y + orb_size.height as i32;
    let y = if below + menu.height as i32 <= bottom {
        below
    } else {
        orb.y - menu.height as i32
    };
    PhysicalPosition::new(
        x.clamp(bounds.x, (right - menu.width as i32).max(bounds.x)),
        y.clamp(bounds.y, (bottom - menu.height as i32).max(bounds.y)),
    )
}

#[tauri::command]
pub(crate) fn show_widget_quick_actions(app: AppHandle) -> Result<(), String> {
    let orb = app.get_webview_window("widget").ok_or("widget window missing")?;
    if !orb.is_visible().map_err(|e| e.to_string())? { return Ok(()); }
    let menu = app.get_webview_window("quick-actions").ok_or("quick actions window missing")?;
    let position = orb.outer_position().map_err(|e| e.to_string())?;
    let size = orb.outer_size().map_err(|e| e.to_string())?;
    let scale = orb.scale_factor().map_err(|e| e.to_string())?;
    let menu_size = PhysicalSize::new((280.0 * scale).round() as u32, (90.0 * scale).round() as u32);
    let monitor = orb.current_monitor().map_err(|e| e.to_string())?;
    let (origin, bounds) = monitor.map(|m| (m.work_area().position, m.work_area().size))
        .unwrap_or((position, PhysicalSize::new(1920, 1080)));
    let target = menu_position(position, size, menu_size, origin, bounds);
    menu.set_size(menu_size).map_err(|e| e.to_string())?;
    menu.set_position(target).map_err(|e| e.to_string())?;
    menu.show().map_err(|e| e.to_string())?;
    menu.set_focus().map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn close_widget_quick_actions(app: AppHandle) -> Result<(), String> {
    if let Some(menu) = app.get_webview_window("quick-actions") {
        menu.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn menu_fits_at_all_edges_and_scales() {
        for scale in [1, 2] {
            let bounds = PhysicalPosition::new(-1920 * scale, 0);
            let bounds_size = PhysicalSize::new(1920 * scale as u32, 1040 * scale as u32);
            let size = PhysicalSize::new(88 * scale as u32, 88 * scale as u32);
            let menu = PhysicalSize::new(280 * scale as u32, 90 * scale as u32);
            for x in [-1920 * scale, -960 * scale, -88 * scale] {
                for y in [0, 500 * scale, 952 * scale] {
                    let target = menu_position(PhysicalPosition::new(x, y), size, menu, bounds, bounds_size);
                    assert!(target.x >= bounds.x && target.x + menu.width as i32 <= 0);
                    assert!(target.y >= 0 && target.y + menu.height as i32 <= 1040 * scale);
                }
            }
        }
    }

    #[test]
    fn menu_opens_above_an_orb_at_the_bottom() {
        assert_eq!(menu_position(
            PhysicalPosition::new(500, 952), PhysicalSize::new(88, 88),
            PhysicalSize::new(280, 90), PhysicalPosition::new(0, 0),
            PhysicalSize::new(1920, 1040),
        ), PhysicalPosition::new(404, 862));
    }
}
