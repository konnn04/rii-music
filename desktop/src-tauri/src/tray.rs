use crate::{config, sidecar, AppState};
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Wry,
};
use tauri_plugin_opener::OpenerExt;

pub const TRAY_ID: &str = "main-tray";

pub struct TrayState {
    pub open_music_item: Mutex<Option<MenuItem<Wry>>>,
    /// Every labelled item, to relabel them when the language changes.
    pub items: Mutex<Vec<MenuItem<Wry>>>,
}

impl TrayState {
    pub fn new() -> Self {
        Self {
            open_music_item: Mutex::new(None),
            items: Mutex::new(Vec::new()),
        }
    }
}

pub fn init_tray(app: &AppHandle, is_local_mode: bool) -> tauri::Result<()> {
    let item_open = MenuItem::with_id(app, "open", crate::lang::tr("open"), true, None::<&str>)?;
    let item_mini = MenuItem::with_id(app, "mini", crate::lang::tr("mini"), true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let item_toggle = MenuItem::with_id(app, "toggle", crate::lang::tr("toggle"), true, None::<&str>)?;
    let item_prev = MenuItem::with_id(app, "prev", crate::lang::tr("prev"), true, None::<&str>)?;
    let item_next = MenuItem::with_id(app, "next", crate::lang::tr("next"), true, None::<&str>)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let item_switch = MenuItem::with_id(app, "switch_mode", crate::lang::tr("switch_mode"), true, None::<&str>)?;
    let item_music_dir = MenuItem::with_id(
        app,
        "open_music_dir",
        crate::lang::tr("open_music_dir"),
        is_local_mode,
        None::<&str>,
    )?;
    let item_quit = MenuItem::with_id(app, "quit", crate::lang::tr("quit"), true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &item_open,
            &item_mini,
            &sep1,
            &item_toggle,
            &item_prev,
            &item_next,
            &sep2,
            &item_switch,
            &item_music_dir,
            &item_quit,
        ],
    )?;

    if let Some(tray_state) = app.try_state::<TrayState>() {
        if let Ok(mut items) = tray_state.items.lock() {
            *items = vec![
                item_open.clone(),
                item_mini.clone(),
                item_toggle.clone(),
                item_prev.clone(),
                item_next.clone(),
                item_switch.clone(),
                item_music_dir.clone(),
                item_quit.clone(),
            ];
        }
        if let Ok(mut guard) = tray_state.open_music_item.lock() {
            *guard = Some(item_music_dir);
        }
    }

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("RiiMusic")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main_window(app),
            "mini" => {
                // Off the event loop thread, like the command (see toggle_mini_player).
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = crate::toggle_mini(&app) {
                        dlog!("mini player toggle failed: {e}");
                    }
                });
            }
            "toggle" => dispatch_player_cmd(app, "toggle"),
            "prev" => dispatch_player_cmd(app, "prev"),
            "next" => dispatch_player_cmd(app, "next"),
            "switch_mode" => handle_switch_mode(app),
            "open_music_dir" => {
                let music_dir = app
                    .try_state::<AppState>()
                    .and_then(|s| s.config.lock().ok().map(|c| c.music_dir.clone()))
                    .unwrap_or_else(|| config::default_music_dir(app));
                if !music_dir.is_empty() {
                    let _ = std::fs::create_dir_all(&music_dir);
                    let _ = app.opener().open_path(music_dir, None::<&str>);
                }
            }
            "quit" => {
                if let Some(state) = app.try_state::<AppState>() {
                    state.sidecar.stop();
                }
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    Ok(())
}

/// Relabel the tray menu in the current language (see lang.rs).
pub fn relabel(app: &AppHandle) {
    if let Some(tray_state) = app.try_state::<TrayState>() {
        if let Ok(items) = tray_state.items.lock() {
            for item in items.iter() {
                let _ = item.set_text(crate::lang::tr(item.id().as_ref()));
            }
        }
    }
}

pub fn update_local_mode(app: &AppHandle, is_local: bool) {
    if let Some(tray_state) = app.try_state::<TrayState>() {
        if let Ok(guard) = tray_state.open_music_item.lock() {
            if let Some(ref item) = *guard {
                let _ = item.set_enabled(is_local);
            }
        }
    }
}

pub fn update_tooltip(app: &AppHandle, title: &str, artist: &str, playing: bool) {
    let title = title.trim();
    let artist = artist.trim();
    let text = if title.is_empty() {
        "RiiMusic".to_string()
    } else {
        let icon = if playing { "▶" } else { "⏸" };
        if artist.is_empty() {
            format!("{icon} {title}")
        } else {
            format!("{icon} {title} — {artist}")
        }
    };

    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(&text));
    }
}

pub fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn dispatch_player_cmd(app: &AppHandle, cmd: &str) {
    let detail = match cmd {
        "toggle" | "prev" | "next" => cmd,
        _ => return,
    };
    if let Some(window) = app.get_webview_window("main") {
        let script = format!(
            "window.dispatchEvent(new CustomEvent('rii:cmd',{{detail:'{detail}'}}))"
        );
        let _ = window.eval(&script);
    }
}

pub fn handle_switch_mode(app: &AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(mut err) = state.last_error.lock() {
            *err = None;
        }
        if let Ok(mut cfg) = state.config.lock() {
            cfg.mode = None;
            let _ = config::save_config(app, &cfg);
        }
    }
    update_local_mode(app, false);
    update_tooltip(app, "", "", false);
    #[cfg(windows)]
    crate::thumbbar::update_playing(app, false);
    if let Some(mini) = app.get_webview_window("mini") {
        let _ = mini.close();
    }
    // Show the setup screen at once; stop the sidecar off the UI thread (a
    // clean local shutdown takes a few seconds and would freeze the window).
    sidecar::navigate_to_setup(app);
    show_main_window(app);
    let app = app.clone();
    std::thread::spawn(move || {
        if let Some(state) = app.try_state::<AppState>() {
            state.sidecar.stop();
        }
    });
}
