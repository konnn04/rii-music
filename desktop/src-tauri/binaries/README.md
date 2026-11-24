# Sidecar Binaries

CI hoặc bước build đặt binary Go `rii_music` đã biên dịch (đã nhúng `web/dist`) vào thư mục này với hậu tố target triple của Rust:

- Windows x64: `rii_music-x86_64-pc-windows-msvc.exe`
- Windows arm64: `rii_music-aarch64-pc-windows-msvc.exe`
- macOS arm64: `rii_music-aarch64-apple-darwin`
- macOS x64: `rii_music-x86_64-apple-darwin`
- Linux x64: `rii_music-x86_64-unknown-linux-gnu`
- Linux arm64: `rii_music-aarch64-unknown-linux-gnu`

Kiểm tra target triple hiện tại của máy bằng:

```bash
rustc -vV | grep host
```
