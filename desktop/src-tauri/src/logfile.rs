use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_BYTES: u64 = 2 * 1024 * 1024;

static LOG_FILE: OnceLock<Mutex<Option<File>>> = OnceLock::new();

pub fn init(dir: &Path) {
    let log_dir = dir.join("logs");
    let _ = fs::create_dir_all(&log_dir);
    let path = log_dir.join("desktop.log");
    if let Ok(meta) = fs::metadata(&path) {
        if meta.len() > MAX_BYTES {
            let backup = log_dir.join("desktop.log.1");
            let _ = fs::rename(&path, &backup);
        }
    }
    let file = OpenOptions::new().create(true).append(true).open(&path).ok();
    let _ = LOG_FILE.set(Mutex::new(file));
}

pub fn log(line: &str) {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Some(lock) = LOG_FILE.get() {
        if let Ok(mut guard) = lock.lock() {
            if let Some(ref mut file) = *guard {
                let _ = writeln!(file, "{ts} {line}");
            }
        }
    }
}

#[macro_export]
macro_rules! dlog {
    ($($arg:tt)*) => {{
        let msg = format!($($arg)*);
        eprintln!("[desktop] {msg}");
        $crate::logfile::log(&msg);
    }};
}
