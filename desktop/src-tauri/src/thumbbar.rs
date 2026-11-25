use std::cell::RefCell;
use std::ffi::c_void;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::OnceLock;
use tauri::{AppHandle, Manager};
use windows::core::w;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::Graphics::Gdi::{CreateBitmap, DeleteObject, HGDIOBJ};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
};
use windows::Win32::UI::Shell::{
    DefSubclassProc, ITaskbarList3, SetWindowSubclass, TaskbarList, THBF_ENABLED, THB_FLAGS,
    THB_ICON, THB_TOOLTIP, THBN_CLICKED, THUMBBUTTON,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateIconIndirect, LoadIconW, RegisterWindowMessageW, HICON, ICONINFO, IDI_APPLICATION,
    WM_COMMAND,
};

const SUBCLASS_ID: usize = 0x5249_4901;
const BTN_PREV: u32 = 1;
const BTN_TOGGLE: u32 = 2;
const BTN_NEXT: u32 = 3;

static APP: OnceLock<AppHandle> = OnceLock::new();
static TASKBAR_CREATED_MSG: AtomicU32 = AtomicU32::new(0);

struct ThumbState {
    hwnd: HWND,
    taskbar: ITaskbarList3,
    added: bool,
    playing: bool,
    icon_prev: HICON,
    icon_play: HICON,
    icon_pause: HICON,
    icon_next: HICON,
}

thread_local! {
    static THUMB: RefCell<Option<ThumbState>> = const { RefCell::new(None) };
}

const ICON_PREV: [&str; 16] = [
    "................",
    "................",
    "..##........##..",
    "..##.......###..",
    "..##.....#####..",
    "..##...#######..",
    "..##.#########..",
    "..############..",
    "..############..",
    "..##.#########..",
    "..##...#######..",
    "..##.....#####..",
    "..##.......###..",
    "..##........##..",
    "................",
    "................",
];

const ICON_PLAY: [&str; 16] = [
    "................",
    "................",
    "....##..........",
    "....####........",
    "....######......",
    "....########....",
    "....##########..",
    "....###########.",
    "....###########.",
    "....##########..",
    "....########....",
    "....######......",
    "....####........",
    "....##..........",
    "................",
    "................",
];

const ICON_PAUSE: [&str; 16] = [
    "................",
    "................",
    "...###....###...",
    "...###....###...",
    "...###....###...",
    "...###....###...",
    "...###....###...",
    "...###....###...",
    "...###....###...",
    "...###....###...",
    "...###....###...",
    "...###....###...",
    "...###....###...",
    "...###....###...",
    "................",
    "................",
];

const ICON_NEXT: [&str; 16] = [
    "................",
    "................",
    "..##........##..",
    "..###.......##..",
    "..#####.....##..",
    "..#######...##..",
    "..#########.###.",
    "..############..",
    "..############..",
    "..#########.###.",
    "..#######...##..",
    "..#####.....##..",
    "..###.......##..",
    "..##........##..",
    "................",
    "................",
];

pub fn init(app: &AppHandle) {
    let _ = APP.set(app.clone());
    let Some(window) = app.get_webview_window("main") else {
        dlog!("thumbbar: main window not found");
        return;
    };
    let hwnd_raw = match window.hwnd() {
        Ok(h) => h.0 as usize,
        Err(e) => {
            dlog!("thumbbar: hwnd failed: {e}");
            return;
        }
    };
    if let Err(e) = app.run_on_main_thread(move || unsafe {
        setup_on_main(HWND(hwnd_raw as *mut c_void));
    }) {
        dlog!("thumbbar: run_on_main_thread failed: {e}");
    }
}

pub fn update_playing(app: &AppHandle, playing: bool) {
    let _ = app.run_on_main_thread(move || {
        let update_args = THUMB.with(|cell| {
            let Ok(mut guard) = cell.try_borrow_mut() else {
                return None;
            };
            let state = guard.as_mut()?;
            state.playing = playing;
            if !state.added {
                return None;
            }
            let icon = if playing {
                state.icon_pause
            } else {
                state.icon_play
            };
            Some((state.hwnd, state.taskbar.clone(), icon))
        });

        let Some((hwnd, taskbar, icon)) = update_args else {
            return;
        };
        let btn = THUMBBUTTON {
            dwMask: THB_ICON | THB_TOOLTIP | THB_FLAGS,
            iId: BTN_TOGGLE,
            iBitmap: 0,
            hIcon: icon,
            szTip: tip_buf(crate::lang::tr(if playing { "pause" } else { "play" })),
            dwFlags: THBF_ENABLED,
        };
        if let Err(e) = unsafe { taskbar.ThumbBarUpdateButtons(hwnd, &[btn]) } {
            dlog!("thumbbar: ThumbBarUpdateButtons failed: {e}");
        }
    });
}

unsafe fn setup_on_main(hwnd: HWND) {
    let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);

    let msg = RegisterWindowMessageW(w!("TaskbarButtonCreated"));
    TASKBAR_CREATED_MSG.store(msg, Ordering::Relaxed);

    if !SetWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID, 0).as_bool() {
        dlog!("thumbbar: SetWindowSubclass failed");
        return;
    }

    let taskbar: ITaskbarList3 =
        match CoCreateInstance(&TaskbarList, None, CLSCTX_INPROC_SERVER) {
            Ok(t) => t,
            Err(e) => {
                dlog!("thumbbar: CoCreateInstance failed: {e}");
                return;
            }
        };
    if let Err(e) = taskbar.HrInit() {
        dlog!("thumbbar: HrInit failed: {e}");
        return;
    }

    let state = ThumbState {
        hwnd,
        taskbar,
        added: false,
        playing: false,
        icon_prev: make_icon(&ICON_PREV),
        icon_play: make_icon(&ICON_PLAY),
        icon_pause: make_icon(&ICON_PAUSE),
        icon_next: make_icon(&ICON_NEXT),
    };

    THUMB.with(|cell| {
        if let Ok(mut guard) = cell.try_borrow_mut() {
            *guard = Some(state);
        }
    });

    // Try once now; if the taskbar button does not exist yet, TaskbarButtonCreated will retry.
    try_add_buttons(false);
}

unsafe fn try_add_buttons(reset: bool) {
    let snapshot = THUMB.with(|cell| {
        let Ok(mut guard) = cell.try_borrow_mut() else {
            return None;
        };
        let state = guard.as_mut()?;
        if reset {
            state.added = false;
        }
        if state.added {
            return None;
        }
        let toggle_icon = if state.playing {
            state.icon_pause
        } else {
            state.icon_play
        };
        Some((
            state.hwnd,
            state.taskbar.clone(),
            state.playing,
            state.icon_prev,
            toggle_icon,
            state.icon_next,
        ))
    });

    let Some((hwnd, taskbar, playing, icon_prev, toggle_icon, icon_next)) = snapshot else {
        return;
    };

    let buttons = [
        THUMBBUTTON {
            dwMask: THB_ICON | THB_TOOLTIP | THB_FLAGS,
            iId: BTN_PREV,
            iBitmap: 0,
            hIcon: icon_prev,
            szTip: tip_buf(crate::lang::tr("prev")),
            dwFlags: THBF_ENABLED,
        },
        THUMBBUTTON {
            dwMask: THB_ICON | THB_TOOLTIP | THB_FLAGS,
            iId: BTN_TOGGLE,
            iBitmap: 0,
            hIcon: toggle_icon,
            szTip: tip_buf(crate::lang::tr(if playing { "pause" } else { "play" })),
            dwFlags: THBF_ENABLED,
        },
        THUMBBUTTON {
            dwMask: THB_ICON | THB_TOOLTIP | THB_FLAGS,
            iId: BTN_NEXT,
            iBitmap: 0,
            hIcon: icon_next,
            szTip: tip_buf(crate::lang::tr("next")),
            dwFlags: THBF_ENABLED,
        },
    ];

    match taskbar.ThumbBarAddButtons(hwnd, &buttons) {
        Ok(()) => {
            THUMB.with(|cell| {
                if let Ok(mut guard) = cell.try_borrow_mut() {
                    if let Some(state) = guard.as_mut() {
                        state.added = true;
                    }
                }
            });
        }
        Err(e) => {
            if reset {
                dlog!("thumbbar: ThumbBarAddButtons failed: {e}");
            }
        }
    }
}

unsafe extern "system" fn subclass_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _uid_subclass: usize,
    _dw_ref_data: usize,
) -> LRESULT {
    let created_msg = TASKBAR_CREATED_MSG.load(Ordering::Relaxed);
    if created_msg != 0 && msg == created_msg {
        try_add_buttons(true);
    } else if msg == WM_COMMAND {
        let hiword = ((wparam.0 >> 16) & 0xffff) as u32;
        if hiword == THBN_CLICKED {
            let loword = (wparam.0 & 0xffff) as u32;
            let cmd = match loword {
                BTN_PREV => Some("prev"),
                BTN_TOGGLE => Some("toggle"),
                BTN_NEXT => Some("next"),
                _ => None,
            };
            if let (Some(cmd), Some(app)) = (cmd, APP.get()) {
                crate::tray::dispatch_player_cmd(app, cmd);
            }
            return LRESULT(0);
        }
    }
    DefSubclassProc(hwnd, msg, wparam, lparam)
}

fn tip_buf(text: &str) -> [u16; 260] {
    let mut buf = [0u16; 260];
    for (dst, src) in buf.iter_mut().take(259).zip(text.encode_utf16()) {
        *dst = src;
    }
    buf
}

unsafe fn make_icon(rows: &[&str; 16]) -> HICON {
    let mut color = [0u32; 16 * 16];
    let mut mask = [0xFFu8; 16 * 2];
    for (y, row) in rows.iter().enumerate() {
        for (x, ch) in row.bytes().take(16).enumerate() {
            if ch == b'#' {
                color[y * 16 + x] = 0xFFFF_FFFF;
                mask[y * 2 + (x / 8)] &= !(1u8 << (7 - (x % 8)));
            }
        }
    }
    let hbm_color = CreateBitmap(16, 16, 1, 32, Some(color.as_ptr() as *const c_void));
    let hbm_mask = CreateBitmap(16, 16, 1, 1, Some(mask.as_ptr() as *const c_void));
    if hbm_color.0.is_null() || hbm_mask.0.is_null() {
        if !hbm_color.0.is_null() {
            let _ = DeleteObject(HGDIOBJ(hbm_color.0));
        }
        if !hbm_mask.0.is_null() {
            let _ = DeleteObject(HGDIOBJ(hbm_mask.0));
        }
        return LoadIconW(None, IDI_APPLICATION).unwrap_or_default();
    }
    let info = ICONINFO {
        fIcon: true.into(),
        xHotspot: 0,
        yHotspot: 0,
        hbmMask: hbm_mask,
        hbmColor: hbm_color,
    };
    let icon = CreateIconIndirect(&info)
        .unwrap_or_else(|_| LoadIconW(None, IDI_APPLICATION).unwrap_or_default());
    let _ = DeleteObject(HGDIOBJ(hbm_color.0));
    let _ = DeleteObject(HGDIOBJ(hbm_mask.0));
    icon
}
