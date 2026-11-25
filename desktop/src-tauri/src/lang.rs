//! The shell's own texts (tray menu, taskbar buttons) in the web app's language.
//! The web app tells it with `set_language` when it starts.

use std::sync::atomic::{AtomicBool, Ordering};

static ENGLISH: AtomicBool = AtomicBool::new(false);

pub fn set(lang: &str) -> bool {
    let en = lang.starts_with("en");
    ENGLISH.swap(en, Ordering::Relaxed) != en
}

pub fn tr(key: &str) -> &'static str {
    let en = ENGLISH.load(Ordering::Relaxed);
    match (key, en) {
        ("open", false) => "Mở RiiMusic",
        ("open", true) => "Open RiiMusic",
        ("mini", false) => "Trình phát mini",
        ("mini", true) => "Mini player",
        ("toggle", false) => "Phát / Tạm dừng",
        ("toggle", true) => "Play / Pause",
        ("prev", false) => "Bài trước",
        ("prev", true) => "Previous",
        ("next", false) => "Bài sau",
        ("next", true) => "Next",
        ("switch_mode", false) => "Đổi chế độ…",
        ("switch_mode", true) => "Switch mode…",
        ("open_music_dir", false) => "Mở thư mục nhạc",
        ("open_music_dir", true) => "Open music folder",
        ("quit", false) => "Thoát",
        ("quit", true) => "Quit",
        ("play", false) => "Phát",
        ("play", true) => "Play",
        ("pause", false) => "Tạm dừng",
        ("pause", true) => "Pause",
        _ => "",
    }
}
