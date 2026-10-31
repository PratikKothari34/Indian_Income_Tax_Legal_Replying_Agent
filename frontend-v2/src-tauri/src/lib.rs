//! Tauri host for the Indian Income Tax Legal Reply Agent (v2).
//!
//! Replaces the v1 Electron main process. Every `window.localAgent` method the
//! renderer calls lands in [`commands`]; the renderer-facing names are frozen
//! (see `docs/API.md`) even though the transport changed.

mod backend;
mod commands;
mod config;
mod paths;
mod sessions;

use std::time::Duration;

use backend::BackendState;
use tauri::{Emitter, Manager};

/// Breathing room left on each side when the window has to shrink to fit.
/// CSS pixels; scaled to physical at the point of use.
const WINDOW_FIT_MARGIN_CSS_PX: f64 = 16.0;

/// The size a window should take, given what it wants and what it can have.
///
/// Pure arithmetic, split out from [`fit_window_to_work_area`] so the part
/// that actually caused the bug is testable without a window or a monitor.
/// All three inputs are physical pixels except `scale`, which converts the
/// margin from CSS px.
///
/// Only ever shrinks. A window smaller than the work area is returned
/// untouched -- a large monitor is not a reason to inflate the app.
fn fitted_size(wanted: (u32, u32), work_area: (u32, u32), scale: f64) -> (u32, u32) {
    let margin = (WINDOW_FIT_MARGIN_CSS_PX * scale).round() as u32;
    let max_w = work_area.0.saturating_sub(margin * 2);
    let max_h = work_area.1.saturating_sub(margin * 2);
    (wanted.0.min(max_w), wanted.1.min(max_h))
}

/// Clamps the main window to the monitor's work area, keeping it centred.
///
/// Work area, not screen size: it is the rectangle excluding the taskbar and
/// any other appbars, which is the space a window may actually occupy.
///
/// Everything from Tauri here is in **physical** pixels while the configured
/// size is in CSS pixels, so the comparison is done physical-side after
/// scaling the margin. Mixing the two is the classic way to get a window that
/// is correct at 100% and wrong everywhere else -- which is the bug this
/// function exists to fix.
fn fit_window_to_work_area(win: &tauri::WebviewWindow) -> tauri::Result<()> {
    let Some(monitor) = win.current_monitor()? else {
        // No monitor reported (RDP, a display hot-unplugged mid-start).
        // Leave the configured size alone rather than guessing.
        return Ok(());
    };

    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let outer = win.outer_size()?;

    let (width, height) = fitted_size(
        (outer.width, outer.height),
        (area.size.width, area.size.height),
        scale,
    );

    if width == outer.width && height == outer.height {
        // Fits as configured. Leave it, and leave `center: true` to place it.
        return Ok(());
    }

    win.set_size(tauri::PhysicalSize::new(width, height))?;

    // Correct for the frame Windows adds on top of what we asked for.
    //
    // `set_size` on an undecorated window sets the *client* size, and Windows
    // then adds the whole non-client frame around it: the invisible resize
    // border on all four sides, plus -- despite `decorations: false` -- the
    // caption height. Measured here: a 974px request produced a 1021px
    // window, 18px of border and 29px of caption that nothing in the app
    // draws. Asking for exactly the work area therefore still overflows it.
    //
    // Measured rather than computed from `SM_CYCAPTION` and friends: those
    // are per-monitor-DPI values, and a second display at another scale
    // reports different ones. One extra round trip is cheaper than being
    // subtly wrong on somebody else's setup.
    let (width, height) = match win.outer_size() {
        Ok(actual) => {
            let grew_w = actual.width.saturating_sub(width);
            let grew_h = actual.height.saturating_sub(height);
            if grew_w == 0 && grew_h == 0 {
                (width, height)
            } else {
                let corrected = (
                    width.saturating_sub(grew_w),
                    height.saturating_sub(grew_h),
                );
                win.set_size(tauri::PhysicalSize::new(corrected.0, corrected.1))?;
                paths::log_line(&format!(
                    "window frame adds {grew_w}x{grew_h}; asked for {}x{} instead",
                    corrected.0, corrected.1
                ));
                corrected
            }
        }
        Err(_) => (width, height),
    };

    // Re-centre by hand, against the *outer* size including that frame, so
    // the visible window is centred rather than the client area.
    //
    // `center: true` already ran against the original size, so without this
    // the window keeps its old top-left and the shrink comes off the
    // bottom-right only.
    let outer_w = win.outer_size().map(|o| o.width).unwrap_or(width);
    let outer_h = win.outer_size().map(|o| o.height).unwrap_or(height);
    let x = area.position.x + ((area.size.width.saturating_sub(outer_w)) / 2) as i32;
    let y = area.position.y + ((area.size.height.saturating_sub(outer_h)) / 2) as i32;
    win.set_position(tauri::PhysicalPosition::new(x, y))?;

    paths::log_line(&format!(
        "window fitted to work area: {}x{} -> {outer_w}x{outer_h} outer (scale {scale})",
        outer.width, outer.height
    ));

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(BackendState::default())
        .invoke_handler(tauri::generate_handler![
            commands::open_output_folder,
            commands::open_logs_folder,
            commands::list_sessions,
            commands::read_session,
            commands::delete_session,
            commands::get_config,
            commands::save_config,
            commands::get_backend_port,
            commands::get_backend_auth,
            commands::apply_desktop_settings,
            commands::backend_status,
            commands::retry_backend,
            commands::open_path_in_base,
            commands::show_main_window,
        ])
        .setup(|app| {
            // Production only: the backend expects its tree to exist before
            // first boot.
            if paths::is_packaged() {
                paths::ensure_appdata_dirs();
            }
            paths::log_line("host starting");

            // Shrink to fit the monitor before the window is ever shown.
            //
            // `tauri.conf.json` asks for 1440x920, which is a comfortable
            // size on a 1080p display at 100% scaling and too tall at
            // anything above it. At 125% the usable height on a 1920x1080
            // screen is 811 CSS px, so a 920px window hangs 109px below the
            // work area and the bottom of the app sits behind the taskbar.
            // `center: true` does not save it -- centering an oversized
            // window just splits the overflow between top and bottom.
            //
            // The configured size stays the *preferred* size and is used
            // whole wherever it fits. This only ever shrinks, never grows:
            // a large monitor should not get a window scaled up to fill it.
            //
            // Done here rather than in the renderer because it has to happen
            // while `visible: false`. A resize after paint is a visible jump.
            if let Some(win) = app.get_webview_window("main") {
                if let Err(e) = fit_window_to_work_area(&win) {
                    // Never fatal. A window that is too tall is a bad
                    // first impression; no window at all is a broken app.
                    paths::log_line(&format!("could not fit window to screen: {e}"));
                }
            }

            // Bring the backend up off-thread. A 120 s wait on the main thread
            // would block the window from ever painting; the renderer shows a
            // starting state and listens for `backend-ready` /
            // `backend-failed`.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let cfg = config::read_config();
                let state = handle.state::<BackendState>();
                match backend::ensure_running(&state, &cfg) {
                    Ok(port) => {
                        paths::log_line(&format!("backend ready on :{port}"));
                        let _ = handle.emit("backend-ready", port);
                    }
                    Err(e) => {
                        paths::log_line(&format!("backend failed: {e}"));
                        let _ = handle.emit("backend-failed", e);
                    }
                }
            });

            // Safety net: if the renderer never calls show_main_window (a JS
            // error before mount, say), show the window anyway rather than
            // leaving the user with no UI at all.
            let show_handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(5));
                if let Some(win) = show_handle.get_webview_window("main") {
                    if !win.is_visible().unwrap_or(true) {
                        paths::log_line("renderer did not signal ready; showing window");
                        let _ = win.show();
                    }
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                // Only ever kills a child we spawned ourselves; a backend the
                // developer started by hand is left running.
                let state = window.state::<BackendState>();
                backend::kill(&state);
                paths::log_line("host stopped");
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::fitted_size;

    /// The exact display this shipped broken on.
    ///
    /// 1920x1080 at 125% scaling leaves a work area of 1920x1014 physical,
    /// which is 1536x811 in CSS px. The configured 1440x920 window is
    /// 1800x1150 physical -- 136px taller than the screen can show -- so the
    /// bottom of the app sat behind the taskbar, and `center: true` made it
    /// worse by splitting the overflow across both edges.
    #[test]
    fn a_window_taller_than_the_work_area_is_shrunk_to_fit() {
        let (w, h) = fitted_size((1800, 1150), (1920, 1014), 1.25);

        assert_eq!(w, 1800, "width fits at this scale and must not change");
        assert!(
            h <= 1014,
            "height {h} still exceeds the 1014px work area; the taskbar              would cover the bottom of the window"
        );
        // 1014 - 2 * round(16 * 1.25) = 1014 - 40
        assert_eq!(h, 974, "should fill the work area less the margin");
    }

    /// The case that must not regress into "resize everything".
    #[test]
    fn a_window_that_already_fits_is_left_exactly_as_configured() {
        // 1440x920 at 100% on a 2560x1400 work area.
        assert_eq!(fitted_size((1440, 920), (2560, 1400), 1.0), (1440, 920));
    }

    /// Both axes, and the margin tracking the scale factor.
    #[test]
    fn the_margin_is_in_css_pixels_not_physical_ones() {
        // At 200%, a 16 CSS px margin is 32 physical px per side.
        assert_eq!(fitted_size((4000, 4000), (1000, 800), 2.0), (936, 736));
    }

    /// A work area smaller than the margins must not underflow to a huge
    /// number. `saturating_sub` on u32 is what prevents it.
    #[test]
    fn an_absurdly_small_work_area_clamps_to_zero_not_to_u32_max() {
        assert_eq!(fitted_size((1440, 920), (10, 10), 1.0), (0, 0));
    }

    /// Every window command the caption calls must be granted in
    /// `capabilities/default.json`.
    ///
    /// Tauri gates each window command behind its own permission, and a
    /// missing one is not a build error or a panic -- the command is simply
    /// rejected at the IPC boundary and the button does nothing. That is
    /// invisible to `tsc`, to `cargo build` and to every other test here, and
    /// it shipped once already: `toggle-maximize` is a separate permission
    /// from `maximize`, so the maximize button and the caption double-click
    /// were both dead in the packaged app while `maximize` sat in the list
    /// looking correct.
    ///
    /// `internal-toggle-maximize` is the one that is easy to miss twice: it
    /// is what `data-tauri-drag-region` invokes on a double-click, and
    /// nothing in the renderer names it.
    #[test]
    fn the_caption_buttons_have_the_permissions_they_need() {
        let caps = include_str!("../capabilities/default.json");

        for permission in [
            "core:window:allow-minimize",
            "core:window:allow-unminimize",
            "core:window:allow-maximize",
            "core:window:allow-unmaximize",
            "core:window:allow-toggle-maximize",
            "core:window:allow-internal-toggle-maximize",
            "core:window:allow-is-maximized",
            "core:window:allow-close",
            "core:window:allow-start-dragging",
        ] {
            assert!(
                caps.contains(&format!("\"{permission}\"")),
                "capabilities/default.json is missing `{permission}`. The \
                 matching caption control will be silently inert in the \
                 packaged app -- the IPC call is rejected, not an error."
            );
        }
    }

    /// The window must be allowed to get narrow enough to half-snap.
    ///
    /// `minWidth` is in CSS pixels; Windows applies it in physical ones, so
    /// the floor a user actually hits is `minWidth * scale`. On the commonest
    /// Windows laptop setup -- 1920x1080 at 125% -- half the screen is 960
    /// physical px, which is 768 CSS px. A `minWidth` above that silently
    /// turns Win+Left into a window wider than the half it was snapped to,
    /// and the two halves overlap. It shipped that way once at 860, which
    /// made the overlap 115 physical px.
    ///
    /// The renderer is not the limit here: `App.tsx` swaps the 240px rail for
    /// a top bar below `RAIL_BREAKPOINT` (760 CSS px) and `useSplitPane`
    /// stacks the panes below `STACK_BREAKPOINT` (1100), so the layout is
    /// built for widths far below anything the window will allow. The floor
    /// exists to stop a window so small the compact layout has nowhere to go,
    /// not to defend a layout that cannot cope.
    #[test]
    fn the_window_can_be_narrowed_enough_to_half_snap_at_125_percent() {
        let conf = include_str!("../tauri.conf.json");
        let parsed: serde_json::Value =
            serde_json::from_str(conf).expect("tauri.conf.json parses");
        let min_width = parsed["app"]["windows"][0]["minWidth"]
            .as_f64()
            .expect("minWidth is a number");

        // 1920 physical / 2 halves / 1.25 scale.
        const HALF_SCREEN_CSS_PX: f64 = 768.0;
        assert!(
            min_width <= HALF_SCREEN_CSS_PX,
            "minWidth is {min_width} CSS px, wider than the {HALF_SCREEN_CSS_PX} \
             px half-screen on a 1920x1080 display at 125% scaling. Win+Left \
             would produce a window {} px wider than its half, overlapping the \
             other one.",
            (min_width - HALF_SCREEN_CSS_PX) * 1.25
        );

        // The other direction: low enough to snap, high enough that the
        // compact layout still has room for the content beside its chrome.
        assert!(
            min_width >= 640.0,
            "minWidth {min_width} is below 640 CSS px; the compact layout's \
             content area stops being usable before the window stops shrinking"
        );
    }
}
