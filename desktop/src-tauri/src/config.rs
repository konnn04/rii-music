use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopConfig {
    pub mode: Option<String>,
    #[serde(default)]
    pub server_url: String,
    #[serde(default)]
    pub music_dir: String,
    #[serde(default)]
    pub autostart: bool,
    #[serde(default = "default_true")]
    pub close_to_tray: bool,
    #[serde(default)]
    pub start_minimized: bool,
}

impl Default for DesktopConfig {
    fn default() -> Self {
        Self {
            mode: None,
            server_url: String::new(),
            music_dir: String::new(),
            autostart: false,
            close_to_tray: true,
            start_minimized: false,
        }
    }
}

pub fn default_music_dir(app: &AppHandle) -> String {
    if let Ok(audio) = app.path().audio_dir() {
        return audio.join("RiiMusic").to_string_lossy().to_string();
    }
    if let Ok(home) = app.path().home_dir() {
        return home
            .join("Music")
            .join("RiiMusic")
            .to_string_lossy()
            .to_string();
    }
    "RiiMusic".to_string()
}

pub fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Không lấy được thư mục cấu hình: {e}"))?;
    Ok(dir.join("desktop.json"))
}

pub fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map_err(|e| format!("Không lấy được thư mục dữ liệu: {e}"))
}

pub fn load_config(app: &AppHandle) -> DesktopConfig {
    let fallback_dir = default_music_dir(app);
    let path = match config_path(app) {
        Ok(p) => p,
        Err(_) => {
            return DesktopConfig {
                music_dir: fallback_dir,
                ..Default::default()
            };
        }
    };

    let mut cfg = match fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str::<DesktopConfig>(&raw).unwrap_or_default(),
        Err(_) => DesktopConfig::default(),
    };

    if cfg.music_dir.trim().is_empty() {
        cfg.music_dir = fallback_dir;
    }
    cfg
}

pub fn save_config(app: &AppHandle, cfg: &DesktopConfig) -> Result<(), String> {
    let path = config_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Không tạo được thư mục cấu hình: {e}"))?;
    }
    let json = serde_json::to_string_pretty(cfg)
        .map_err(|e| format!("Không mã hóa được cấu hình: {e}"))?;
    fs::write(&path, json).map_err(|e| format!("Không ghi được tệp cấu hình: {e}"))?;
    Ok(())
}
