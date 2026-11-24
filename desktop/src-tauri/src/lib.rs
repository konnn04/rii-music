mod config;
mod sidecar;
mod tray;

use config::DesktopConfig;
use serde::Serialize;
use sidecar::SidecarManager;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager, Url, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_window_state::StateFlags;

#[derive(Debug, Clone, Default)]
pub struct NowPlayingState {
    pub title: String,
    pub artist: String,
    pub playing: bool,
}

pub struct AppState {
    pub config: Mutex<DesktopConfig>,
    pub setup_url: Mutex<Option<Url>>,
    pub last_error: Mutex<Option<String>>,
    pub pending_deep_link: Mutex<Option<String>>,
    pub now_playing: Mutex<NowPlayingState>,
    pub sidecar: SidecarManager,
}

impl AppState {
    fn new(cfg: DesktopConfig) -> Self {
        Self {
            config: Mutex::new(cfg),
            setup_url: Mutex::new(None),
            last_error: Mutex::new(None),
            pending_deep_link: Mutex::new(None),
            now_playing: Mutex::new(NowPlayingState::default()),
            sidecar: SidecarManager::new(),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SetupState {
    config: DesktopConfig,
    default_music_dir: String,
    last_error: Option<String>,
    starting: bool,
}

#[tauri::command]
fn get_setup_state(app: AppHandle) -> SetupState {
    let state = app.state::<AppState>();
    let cfg = state
        .config
        .lock()
        .map(|g| g.clone())
        .unwrap_or_else(|_| config::load_config(&app));
    let last_error = state.last_error.lock().ok().and_then(|g| g.clone());
    SetupState {
        config: cfg,
        default_music_dir: config::default_music_dir(&app),
        last_error,
        starting: state.sidecar.is_starting(),
    }
}

#[tauri::command]
async fn pick_music_dir(
    app: AppHandle,
    default_path: Option<String>,
) -> Result<Option<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut builder = app.dialog().file();
    if let Some(dir) = default_path {
        if !dir.trim().is_empty() {
            builder = builder.set_directory(dir);
        }
    }
    builder.pick_folder(move |folder| {
        let path = folder
            .and_then(|f| f.into_path().ok())
            .map(|p| p.to_string_lossy().to_string());
        let _ = tx.send(path);
    });
    rx.await.map_err(|_| "Đã hủy chọn thư mục.".to_string())
}

#[tauri::command]
async fn check_server(url: String) -> Result<String, String> {
    let trimmed = url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("Vui lòng nhập địa chỉ máy chủ.".to_string());
    }
    if !trimmed.starts_with("http://") && !trimmed.starts_with("https://") {
        return Err("Địa chỉ phải bắt đầu bằng http:// hoặc https://".to_string());
    }

    let health_url = format!("{trimmed}/api/health");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Không tạo được HTTP client: {e}"))?;

    let resp = client
        .get(&health_url)
        .send()
        .await
        .map_err(|e| format!("Không kết nối được máy chủ: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("Máy chủ trả về mã lỗi HTTP {}", resp.status()));
    }

    let body = resp
        .text()
        .await
        .map_err(|e| format!("Không đọc được phản hồi từ máy chủ: {e}"))?;

    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&body) {
        if let Some(ver) = json.get("version").and_then(|v| v.as_str()) {
            return Ok(ver.to_string());
        }
    }
    Ok("OK".to_string())
}

#[tauri::command]
fn save_setup(app: AppHandle, mut config: DesktopConfig) -> Result<(), String> {
    match config.mode.as_deref() {
        Some("local") => {
            if config.music_dir.trim().is_empty() {
                config.music_dir = config::default_music_dir(&app);
            }
        }
        Some("client") => {
            config.server_url = config.server_url.trim().trim_end_matches('/').to_string();
            if config.server_url.is_empty() {
                return Err("Vui lòng nhập địa chỉ máy chủ.".to_string());
            }
        }
        _ => return Err("Chế độ không hợp lệ.".to_string()),
    }

    config::save_config(&app, &config)?;
    apply_autostart(&app, config.autostart);

    let is_local = config.mode.as_deref() == Some("local");
    tray::update_local_mode(&app, is_local);

    let state = app.state::<AppState>();
    if let Ok(mut guard) = state.config.lock() {
        *guard = config.clone();
    }
    if let Ok(mut err) = state.last_error.lock() {
        *err = None;
    }

    sidecar::start_async(app, config);
    Ok(())
}

#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    let autolaunch = app.autolaunch();
    if enabled {
        autolaunch
            .enable()
            .map_err(|e| format!("Không bật được tự khởi động: {e}"))?;
    } else {
        autolaunch
            .disable()
            .map_err(|e| format!("Không tắt được tự khởi động: {e}"))?;
    }

    let state = app.state::<AppState>();
    if let Ok(mut cfg) = state.config.lock() {
        cfg.autostart = enabled;
        let _ = config::save_config(&app, &cfg);
    }
    Ok(())
}

#[tauri::command]
fn now_playing(app: AppHandle, title: String, artist: String, playing: bool) {
    let state = app.state::<AppState>();
    if let Ok(mut np) = state.now_playing.lock() {
        np.title = title.clone();
        np.artist = artist.clone();
        np.playing = playing;
    }
    tray::update_tooltip(&app, &title, &artist, playing);
}

#[tauri::command]
fn open_music_dir(app: AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let dir = state
        .config
        .lock()
        .map(|c| c.music_dir.clone())
        .unwrap_or_else(|_| config::default_music_dir(&app));
    if dir.trim().is_empty() {
        return Err("Chưa thiết lập thư mục nhạc.".to_string());
    }
    let _ = std::fs::create_dir_all(&dir);
    app.opener()
        .open_path(dir, None::<&str>)
        .map_err(|e| format!("Không mở được thư mục nhạc: {e}"))
}

#[tauri::command]
fn switch_mode(app: AppHandle) {
    tray::handle_switch_mode(&app);
}

fn apply_autostart(app: &AppHandle, enabled: bool) {
    let autolaunch = app.autolaunch();
    if enabled {
        let _ = autolaunch.enable();
    } else {
        let _ = autolaunch.disable();
    }
}

fn parse_deep_link_path(raw: &str) -> Option<String> {
    let parsed = Url::parse(raw).ok()?;
    if parsed.scheme() != "riimusic" {
        return None;
    }
    let host = parsed.host_str()?;
    let id = parsed.path().trim_matches('/');
    if id.is_empty() {
        return None;
    }
    match host {
        "room" => Some(format!("/?room={id}")),
        "track" => Some(format!("/?track={id}")),
        _ => None,
    }
}

fn handle_deep_link(app: &AppHandle, raw: &str) {
    let Some(rel_path) = parse_deep_link_path(raw) else {
        return;
    };
    let state = app.state::<AppState>();
    if let Some(port) = state.sidecar.current_port() {
        let target = format!("http://127.0.0.1:{port}{rel_path}");
        if let (Some(window), Ok(url)) = (app.get_webview_window("main"), Url::parse(&target)) {
            let _ = window.navigate(url);
            tray::show_main_window(app);
        }
    } else if let Ok(mut pending) = state.pending_deep_link.lock() {
        *pending = Some(rel_path);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            tray::show_main_window(app);
            for arg in args {
                if arg.starts_with("riimusic://") {
                    handle_deep_link(app, &arg);
                }
            }
        }))
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(
                    StateFlags::SIZE
                        | StateFlags::POSITION
                        | StateFlags::MAXIMIZED
                        | StateFlags::FULLSCREEN,
                )
                .build(),
        )
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        match shortcut.key {
                            Code::MediaPlayPause => tray::dispatch_player_cmd(app, "toggle"),
                            Code::MediaTrackNext => tray::dispatch_player_cmd(app, "next"),
                            Code::MediaTrackPrevious => tray::dispatch_player_cmd(app, "prev"),
                            _ => {}
                        }
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            get_setup_state,
            pick_music_dir,
            check_server,
            save_setup,
            set_autostart,
            now_playing,
            open_music_dir,
            switch_mode
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let cfg = config::load_config(&handle);
            let is_local = cfg.mode.as_deref() == Some("local");

            app.manage(AppState::new(cfg.clone()));
            app.manage(tray::TrayState::new());

            // Capture initial bundled setup URL before navigating anywhere
            if let Some(window) = app.get_webview_window("main") {
                if let Ok(url) = window.url() {
                    if let Ok(mut guard) = app.state::<AppState>().setup_url.lock() {
                        *guard = Some(url);
                    }
                }
            }

            // Initialize system tray
            tray::init_tray(&handle, is_local)?;

            // Register global media shortcuts (ignore registration errors)
            for code in [
                Code::MediaPlayPause,
                Code::MediaTrackNext,
                Code::MediaTrackPrevious,
            ] {
                let _ = app.global_shortcut().register(Shortcut::new(None, code));
            }

            // Listen for deep links (warm & cold start)
            let dl_handle = handle.clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    handle_deep_link(&dl_handle, url.as_str());
                }
            });
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                for url in urls {
                    handle_deep_link(&handle, url.as_str());
                }
            }
            for arg in std::env::args().skip(1) {
                if arg.starts_with("riimusic://") {
                    handle_deep_link(&handle, &arg);
                }
            }

            // Show window unless launched with --minimized (or startMinimized with mode configured)
            let arg_minimized = std::env::args().any(|a| a == "--minimized");
            let should_hide = arg_minimized || (cfg.start_minimized && cfg.mode.is_some());
            if !should_hide {
                tray::show_main_window(&handle);
            }

            // Start sidecar automatically if mode is already configured
            if cfg.mode.is_some() {
                sidecar::start_async(handle, cfg);
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let close_to_tray = window
                    .app_handle()
                    .try_state::<AppState>()
                    .and_then(|s| s.config.lock().ok().map(|c| c.close_to_tray))
                    .unwrap_or(true);
                if close_to_tray {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        });

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building RiiMusic desktop application");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            if let Some(state) = app_handle.try_state::<AppState>() {
                state.sidecar.stop();
            }
        }
    });
}
