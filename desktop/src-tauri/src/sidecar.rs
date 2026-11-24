use crate::config::{self, DesktopConfig};
use crate::AppState;
use rand::RngCore;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Url};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;
const KEEP_LOG_BYTES: usize = 2_500_000;
const HEALTH_POLL_INTERVAL_MS: u64 = 250;
// 10 minutes: the first local start downloads PostgreSQL and ffmpeg.
const HEALTH_POLL_MAX_ATTEMPTS: u32 = 2400;

struct SidecarInner {
    child: Option<CommandChild>,
    port: Option<u16>,
    // Local mode's secret: also used to ask the sidecar for a clean shutdown.
    token: Option<String>,
    generation: u64,
    intentional_stop: bool,
    starting: bool,
    restart_count: u8,
    exited_early: bool,
}

pub struct SidecarManager {
    inner: Mutex<SidecarInner>,
}

impl SidecarManager {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(SidecarInner {
                child: None,
                port: None,
                token: None,
                generation: 0,
                intentional_stop: false,
                starting: false,
                restart_count: 0,
                exited_early: false,
            }),
        }
    }

    pub fn current_port(&self) -> Option<u16> {
        self.inner.lock().ok().and_then(|g| g.port)
    }

    pub fn is_starting(&self) -> bool {
        self.inner.lock().map(|g| g.starting).unwrap_or(false)
    }

    pub fn stop(&self) {
        // Take what we need, then release the lock: the clean shutdown below
        // can take seconds and nothing else may wait on the state meanwhile.
        let (child, port, token) = match self.inner.lock() {
            Ok(mut inner) => {
                inner.intentional_stop = true;
                inner.starting = false;
                inner.generation = inner.generation.wrapping_add(1);
                (inner.child.take(), inner.port.take(), inner.token.take())
            }
            Err(_) => return,
        };
        if let Some(child) = child {
            // Local mode: ask for a clean exit first so the embedded
            // PostgreSQL stops properly; kill only if it doesn't go.
            if let (Some(port), Some(token)) = (port, token) {
                if request_shutdown(port, &token) {
                    wait_port_closed(port, std::time::Duration::from_secs(15));
                }
            }
            let _ = child.kill();
        }
    }
}

pub fn start_async(app: AppHandle, cfg: DesktopConfig) {
    tauri::async_runtime::spawn(async move {
        start_internal(app, cfg, false).await;
    });
}

// Boxed and Send: it restarts itself when the sidecar dies (a recursive async fn).
fn start_internal(
    app: AppHandle,
    cfg: DesktopConfig,
    is_restart: bool,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
    Box::pin(start_internal_impl(app, cfg, is_restart))
}

async fn start_internal_impl(app: AppHandle, cfg: DesktopConfig, is_restart: bool) {
    let state = app.state::<AppState>();

    let my_gen = {
        let mut inner = match state.sidecar.inner.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        if let Some(old_child) = inner.child.take() {
            let _ = old_child.kill();
        }
        inner.generation = inner.generation.wrapping_add(1);
        inner.intentional_stop = false;
        inner.starting = true;
        inner.exited_early = false;
        inner.port = None;
        if !is_restart {
            inner.restart_count = 0;
        }
        inner.generation
    };

    navigate_to_splash(&app);

    let mode = match cfg.mode.as_deref() {
        Some("local") => "local",
        Some("client") => "client",
        _ => {
            fail_to_setup(&app, "Chưa chọn chế độ hoạt động.".to_string());
            return;
        }
    };

    let port = match pick_free_port() {
        Ok(p) => p,
        Err(e) => {
            fail_to_setup(&app, e);
            return;
        }
    };

    let data_dir = match config::data_dir(&app) {
        Ok(d) => d,
        Err(e) => {
            fail_to_setup(&app, e);
            return;
        }
    };

    if let Err(e) = fs::create_dir_all(&data_dir) {
        fail_to_setup(&app, format!("Không tạo được thư mục dữ liệu: {e}"));
        return;
    }

    let log_dir = data_dir.join("logs");
    let _ = fs::create_dir_all(&log_dir);
    let log_path = log_dir.join("rii_music.log");

    let nonexistent_env = data_dir.join(".nonexistent.env");
    let local_token = if mode == "local" {
        Some(random_hex_32())
    } else {
        None
    };

    let mut envs: Vec<(&str, String)> = vec![
        ("RII_MODE", mode.to_string()),
        ("PORT", port.to_string()),
        ("RII_APP_DIR", data_dir.to_string_lossy().to_string()),
        ("ENV_FILE", nonexistent_env.to_string_lossy().to_string()),
    ];

    if mode == "local" {
        envs.push(("RII_MUSIC_DIR", cfg.music_dir.clone()));
        if let Some(ref token) = local_token {
            envs.push(("RII_LOCAL_TOKEN", token.clone()));
        }
    } else {
        envs.push((
            "RII_REMOTE",
            cfg.server_url.trim().trim_end_matches('/').to_string(),
        ));
    }

    let mut cmd = match app.shell().sidecar("rii_music") {
        Ok(c) => c,
        Err(e) => {
            fail_to_setup(&app, format!("Không tìm thấy sidecar rii_music: {e}"));
            return;
        }
    };

    for (k, v) in envs {
        cmd = cmd.env(k, v);
    }

    let (mut rx, child) = match cmd.spawn() {
        Ok(pair) => pair,
        Err(e) => {
            fail_to_setup(&app, format!("Không khởi chạy được rii_music: {e}"));
            return;
        }
    };

    {
        let mut inner = match state.sidecar.inner.lock() {
            Ok(g) => g,
            Err(_) => {
                let _ = child.kill();
                return;
            }
        };
        if inner.generation != my_gen || inner.intentional_stop {
            let _ = child.kill();
            return;
        }
        inner.child = Some(child);
    }

    append_log(
        &log_path,
        &format!("--- Starting rii_music (mode={mode}, port={port}) ---"),
    );

    // Spawn stdout/stderr/termination reader task
    let app_for_reader = app.clone();
    let cfg_for_reader = cfg.clone();
    let log_for_reader = log_path.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => {
                    let text = String::from_utf8_lossy(&bytes);
                    for line in text.lines() {
                        let trimmed = line.trim();
                        if !trimmed.is_empty() {
                            append_log(&log_for_reader, trimmed);
                            let _ = app_for_reader.emit("sidecar-log", trimmed);
                        }
                    }
                }
                CommandEvent::Error(err) => {
                    let msg = format!("Sidecar error: {err}");
                    append_log(&log_for_reader, &msg);
                    let _ = app_for_reader.emit("sidecar-log", &msg);
                }
                CommandEvent::Terminated(payload) => {
                    let msg = format!(
                        "rii_music exited (code={:?}, signal={:?})",
                        payload.code, payload.signal
                    );
                    append_log(&log_for_reader, &msg);

                    let should_restart = {
                        let state = app_for_reader.state::<AppState>();
                        let mut inner = match state.sidecar.inner.lock() {
                            Ok(g) => g,
                            Err(_) => return,
                        };
                        if inner.generation != my_gen || inner.intentional_stop {
                            return;
                        }
                        inner.child = None;
                        inner.port = None;
                        inner.exited_early = true;
                        inner.starting = false;

                        if inner.restart_count < 1 {
                            inner.restart_count += 1;
                            true
                        } else {
                            false
                        }
                    };

                    if should_restart {
                        let _ = app_for_reader.emit(
                            "sidecar-log",
                            "Tiến trình rii_music dừng đột ngột, đang thử khởi động lại…",
                        );
                        let app_restart = app_for_reader.clone();
                        let cfg_restart = cfg_for_reader.clone();
                        tauri::async_runtime::spawn(async move {
                            tokio::time::sleep(Duration::from_millis(500)).await;
                            start_internal(app_restart, cfg_restart, true).await;
                        });
                    } else {
                        let code_str = payload
                            .code
                            .map(|c| c.to_string())
                            .unwrap_or_else(|| "unknown".to_string());
                        fail_to_setup(
                            &app_for_reader,
                            format!(
                                "rii_music đã dừng đột ngột (mã thoát: {code_str}). Xem log tại {}",
                                log_for_reader.display()
                            ),
                        );
                    }
                    break;
                }
                _ => {}
            }
        }
    });

    // Poll /api/health until ready (every 250ms, max 60s)
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    let health_url = format!("http://127.0.0.1:{port}/api/health");
    let mut ready = false;

    for _ in 0..HEALTH_POLL_MAX_ATTEMPTS {
        {
            let inner = match state.sidecar.inner.lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            if inner.generation != my_gen || inner.intentional_stop || inner.exited_early {
                return;
            }
        }

        if let Ok(resp) = client.get(&health_url).send().await {
            if resp.status().is_success() {
                ready = true;
                break;
            }
        }

        tokio::time::sleep(Duration::from_millis(HEALTH_POLL_INTERVAL_MS)).await;
    }

    if !ready {
        state.sidecar.stop();
        fail_to_setup(
            &app,
            format!(
                "Hết thời gian chờ rii_music khởi động (60 giây). Xem log tại {}",
                log_path.display()
            ),
        );
        return;
    }

    {
        let mut inner = match state.sidecar.inner.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        if inner.generation != my_gen || inner.intentional_stop {
            return;
        }
        inner.port = Some(port);
        inner.token = local_token.clone();
        inner.starting = false;
    }

    let pending_path = state
        .pending_deep_link
        .lock()
        .ok()
        .and_then(|mut g| g.take());

    let target_url = if mode == "local" {
        let token = local_token.unwrap_or_default();
        format!("http://127.0.0.1:{port}/__rii/auto-login?token={token}")
    } else if let Some(path) = pending_path {
        format!("http://127.0.0.1:{port}{path}")
    } else {
        format!("http://127.0.0.1:{port}/")
    };

    if let (Some(window), Ok(url)) = (app.get_webview_window("main"), Url::parse(&target_url)) {
        let _ = window.navigate(url);
    }
}

/// The bundled setup page (ui/index.html): the URL captured at start when it
/// is the app's own origin, else the platform's fixed app URL.
fn setup_page(app: &AppHandle) -> Option<Url> {
    let state = app.state::<AppState>();
    let captured = state.setup_url.lock().ok().and_then(|g| g.clone());
    if let Some(u) = captured {
        let own = u.scheme() == "tauri" || u.host_str() == Some("tauri.localhost");
        if own {
            return Some(u);
        }
    }
    let fixed = if cfg!(any(windows, target_os = "android")) { "http://tauri.localhost/index.html" } else { "tauri://localhost/index.html" };
    Url::parse(fixed).ok()
}

pub fn navigate_to_setup(app: &AppHandle) {
    if let (Some(window), Some(mut url)) = (app.get_webview_window("main"), setup_page(app)) {
        url.set_fragment(None);
        let _ = window.navigate(url);
    }
}

pub fn navigate_to_splash(app: &AppHandle) {
    if let (Some(window), Some(mut url)) = (app.get_webview_window("main"), setup_page(app)) {
        url.set_fragment(Some("starting"));
        let _ = window.navigate(url);
    }
}

fn fail_to_setup(app: &AppHandle, message: String) {
    let state = app.state::<AppState>();
    if let Ok(mut err) = state.last_error.lock() {
        *err = Some(message.clone());
    }
    if let Ok(mut inner) = state.sidecar.inner.lock() {
        inner.starting = false;
    }
    let _ = app.emit("sidecar-error", &message);
    navigate_to_setup(app);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn pick_free_port() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("Không tìm được cổng cục bộ trống: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("Không đọc được số cổng: {e}"))?
        .port();
    drop(listener);
    Ok(port)
}

fn random_hex_32() -> String {
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    let mut out = String::with_capacity(32);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

fn append_log(path: &Path, line: &str) {
    rotate_log_if_needed(path);
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{line}");
    }
}

fn rotate_log_if_needed(path: &Path) {
    let meta = match fs::metadata(path) {
        Ok(m) => m,
        Err(_) => return,
    };
    if meta.len() <= MAX_LOG_BYTES {
        return;
    }
    if let Ok(data) = fs::read(path) {
        let start = data.len().saturating_sub(KEEP_LOG_BYTES);
        // Align to next newline so we don't start mid-line
        let slice = &data[start..];
        let trimmed = match slice.iter().position(|&b| b == b'\n') {
            Some(pos) if pos + 1 < slice.len() => &slice[pos + 1..],
            _ => slice,
        };
        let tmp: PathBuf = path.with_extension("log.tmp");
        if fs::write(&tmp, trimmed).is_ok() {
            let _ = fs::rename(&tmp, path);
        } else {
            let _ = fs::write(path, trimmed);
        }
    }
}

/// POST /__rii/shutdown with a plain blocking HTTP request (works while the
/// async runtime is shutting down).
fn request_shutdown(port: u16, token: &str) -> bool {
    use std::io::{Read, Write};
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_secs(2)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(3)));
    let req = format!(
        "POST /__rii/shutdown?token={token} HTTP/1.1
Host: 127.0.0.1:{port}
Content-Length: 0
Connection: close

"
    );
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 32];
    matches!(stream.read(&mut buf), Ok(n) if n > 12 && buf.starts_with(b"HTTP/1.1 202"))
}

/// Wait until nothing listens on the port any more (the sidecar exited).
fn wait_port_closed(port: u16, max: std::time::Duration) {
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let start = std::time::Instant::now();
    while start.elapsed() < max {
        if std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(300)).is_err() {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(300));
    }
}
