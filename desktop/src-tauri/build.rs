// The app's own commands must be listed here: Tauri checks every command called
// from a remote origin (the web app runs on http://127.0.0.1:<port>) against the
// capabilities, and without this manifest none of them could be granted.
const COMMANDS: &[&str] = &[
    "get_setup_state",
    "pick_music_dir",
    "check_server",
    "save_setup",
    "set_autostart",
    "now_playing",
    "mini_state",
    "mini_cmd",
    "toggle_mini_player",
    "open_music_dir",
    "open_log_dir",
    "switch_mode",
    "check_update",
    "install_update",
    "device_name",
    "set_language",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
