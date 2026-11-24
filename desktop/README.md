# RiiMusic Desktop (Tauri v2)

Vỏ ứng dụng desktop (Tauri v2) bọc quanh binary Go `rii_music` chạy dưới dạng **sidecar** trên `http://127.0.0.1:<port>`.

## Hai chế độ hoạt động

1. **Nghe trên máy này (Local)**:
   - Không cần tài khoản, tự động đăng nhập bằng `RII_LOCAL_TOKEN`.
   - Nhạc được lưu mã hóa trong thư mục nhạc đã chọn (mặc định `<Home>/Music/RiiMusic`).
   - Lần chạy đầu có thể mất thời gian hơn để sidecar chuẩn bị PostgreSQL/ffmpeg.
2. **Kết nối máy chủ RiiMusic (Client)**:
   - Kết nối tới một máy chủ RiiMusic đang chạy sẵn (qua `RII_REMOTE`), sidecar làm proxy cục bộ trên `http://127.0.0.1:<port>`.

## Chuẩn bị & Phát triển

Yêu cầu: Node.js + `pnpm`, Rust toolchain (edition 2021), và các thư viện hệ thống theo hướng dẫn Tauri v2.

1. Cài đặt CLI:
   ```bash
   cd desktop
   pnpm install
   ```
2. Tạo bộ icon ứng dụng (từ logo của web app):
   ```bash
   pnpm tauri icon ../web/public/icon.png
   ```
   *(Lưu ý: nếu muốn dùng ảnh PNG thay cho SVG mặc định ở màn hình thiết lập, copy `../web/public/icon.png` sang `desktop/ui/icon.png` trong bước build.)*
3. Đặt binary sidecar `rii_music` đã build sẵn (kèm `web/dist` được nhúng) vào `desktop/src-tauri/binaries/` theo đúng target triple, ví dụ:
   - Windows x64: `desktop/src-tauri/binaries/rii_music-x86_64-pc-windows-msvc.exe`
   - macOS arm64: `desktop/src-tauri/binaries/rii_music-aarch64-apple-darwin`
   - Linux x64: `desktop/src-tauri/binaries/rii_music-x86_64-unknown-linux-gnu`
   Xem thêm `src-tauri/binaries/README.md`.
4. Chạy chế độ phát triển:
   ```bash
   pnpm tauri dev
   ```

## Build phát hành

```bash
cd desktop
pnpm install
pnpm tauri build
```

Các gói đầu ra được cấu hình trong `src-tauri/tauri.conf.json`:
- **Windows**: `nsis` (cài đặt per-user, không cần quyền admin, hỗ trợ Tiếng Việt & English) và `msi`.
- **macOS**: `dmg`.
- **Linux**: `appimage` và `deb`.

## Nơi lưu dữ liệu

- **Cấu hình desktop (`desktop.json`)**: thư mục config của ứng dụng (`app_config_dir`):
  - Windows: `%APPDATA%\app.riimusic.desktop\desktop.json`
  - macOS: `~/Library/Application Support/app.riimusic.desktop/desktop.json`
  - Linux: `~/.config/app.riimusic.desktop/desktop.json`
- **Dữ liệu sidecar (`RII_APP_DIR`)**: thư mục local data (`app_local_data_dir`):
  - Windows: `%LOCALAPPDATA%\app.riimusic.desktop` (hoặc `RiiMusic` tùy nền tảng)
  - macOS: `~/Library/Application Support/app.riimusic.desktop`
  - Linux: `~/.local/share/app.riimusic.desktop`
- **Log sidecar**: `<RII_APP_DIR>/logs/rii_music.log` (tự động xoay vòng, giữ ~5 MB gần nhất).
- **Thư mục nhạc (Local mode)**: mặc định `<Home>/Music/RiiMusic` (có thể đổi ở màn hình thiết lập).
