# RiiMusic

Web nghe nhạc tự host cho bạn và nhóm bạn bè. Tìm và tải nhạc từ YouTube Music, mỗi người một thư viện riêng, nghe trên điện thoại và máy tính như một app.

Một file chạy duy nhất (Go) phục vụ cả giao diện lẫn API. Toàn bộ dữ liệu nằm trong một thư mục.

## Tính năng

**Nghe nhạc**
- Phát, tua, trộn bài, lặp; crossfade, gapless giữa các bài cùng album, cân bằng âm lượng giữa các bài.
- Hàng đợi kéo thả, "Phát tiếp theo", lưu hàng đợi thành playlist.
- Lời bài hát chạy theo nhạc (LRCLIB), chỉnh độ lệch, tự tìm hoặc dán lời.
- Điều khiển từ màn hình khoá và thanh thông báo, cài thành app (PWA).
- Hiệu ứng nền đập theo bass, 12 màu nhấn hoặc màu theo ảnh bìa.

**Tìm và tải**
- Tìm bài, album, playlist, video trên YouTube Music. Bấm Phát: bài đã có phát ngay, bài chưa có tải xong tự phát.
- Xem album / playlist, lưu cả album thành playlist.
- Trang nghệ sĩ: bài trong thư viện, bài hát và album trên YouTube Music.
- File nhạc dùng chung giữa mọi người: bài đã có trên máy chủ không tải lại.

**Gợi ý**
- Tự động gợi ý phát khi hàng đợi sắp hết, giữ đúng một ngôn ngữ (đang nghe nhạc Việt thì chỉ nhạc Việt).
- Mix hằng ngày, radio từ một bài, nghệ sĩ tương tự, playlist theo tâm trạng (trò chuyện với linh vật Vani).
- Tự động tải trước nhạc hợp gu trong giới hạn dung lượng.

**Tài khoản và quản trị**
- Đăng nhập bằng mật khẩu hoặc mã gửi qua email; quên mật khẩu bằng mã OTP.
- Admin: quản lý người dùng và dung lượng, xem log hệ thống, đặt tên / logo / mô tả trang.
- Chia sẻ bài bằng link: người chưa đăng nhập nghe thử 30 giây.
- Giao diện tiếng Việt và English.

**Mở rộng**
- Hiện "Đang nghe…" trên Discord bằng một lệnh, không cần cài thêm gì.
- API có token cá nhân, tài liệu tại `/docs`, thư viện TypeScript một file.

## Cài đặt bằng Docker

Cần Docker và Docker Compose.

```bash
git clone <repo> rii_music && cd rii_music
cp .env.example .env      # điền ít nhất ADMIN_EMAIL, ADMIN_PASSWORD, PUBLIC_URL
docker compose up -d --build
```

Mở `http://<máy chủ>:8080` và đăng nhập bằng `ADMIN_EMAIL` / `ADMIN_PASSWORD`. Lần chạy đầu, máy chủ tự tải yt-dlp (xem tiến trình bằng `docker compose logs -f`).

**Chạy thật trên Internet:**
- Đặt sau reverse proxy có HTTPS, ví dụ Caddy: `nhac.example.com { reverse_proxy localhost:8080 }`.
- Đặt `PUBLIC_URL=https://nhac.example.com` (dùng cho link trong email, link chia sẻ, ảnh bìa trên Discord).
- Với Nginx, tắt đệm cho cập nhật trực tiếp: `proxy_buffering off;` ở `/api/events`.

**Cập nhật:** `git pull && docker compose up -d --build`. Cơ sở dữ liệu tự nâng cấp.

**Sao lưu:** toàn bộ dữ liệu (DB, nhạc, ảnh bìa, cookies) nằm trong volume `rii_music-data`. Sao lưu volume này là đủ.

## Chạy trực tiếp trên máy

Cần Go 1.27+, Node 22+ với pnpm, và ffmpeg trong PATH.

```bash
cp .env.example .env
cd web && pnpm install && pnpm build && cd ..
go build -o rii_music .      # Windows: go build -o rii_music.exe .
./rii_music                  # Windows: .\rii_music.exe
```

Mở http://localhost:8080. Tắt bằng Ctrl+C. Sau mỗi lần cập nhật code, build lại cả hai bước (giao diện trước, Go sau).

## Cấu hình

Đặt trong `.env` (đọc lúc khởi động) hoặc biến môi trường thật (được ưu tiên hơn).

| Biến | Mặc định | Ý nghĩa |
| --- | --- | --- |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | `admin@riimusic.local` / ngẫu nhiên, in ra log | Tài khoản admin đầu tiên, chỉ tạo khi chưa có tài khoản nào |
| `PUBLIC_URL` | | Địa chỉ công khai (https) của trang |
| `SMTP_USERNAME` / `SMTP_PASSWORD` | | Gmail và app password. Thiếu thì đăng nhập bằng mã và quên mật khẩu bị tắt |
| `SMTP_HOST` / `SMTP_PORT` | `smtp.gmail.com` / `587` | Máy chủ gửi mail (465 = TLS ngay) |
| `SMTP_FROM` | `SMTP_USERNAME` | Người gửi, dạng `Tên <địa chỉ>` |
| `DEFAULT_STORAGE_LIMIT_MB` | `2048` | Dung lượng nhạc cho tài khoản mới |
| `LASTFM_API_KEY` | | Dùng Last.fm thay Deezer để tìm nghệ sĩ tương tự |
| `DATA_DIR` | `./data` | Thư mục dữ liệu |
| `PORT` | `8080` | Cổng |
| `TRUST_PROXY` | `false` (Docker: `true`) | Lấy IP thật từ reverse proxy |
| `DOWNLOAD_CONCURRENCY` | `2` | Số bài tải cùng lúc |
| `MAX_DURATION_SEC` | `10800` | Bỏ qua video dài hơn |
| `YT_COOKIES_PATH` | `$DATA_DIR/cookies.txt` | Cookie YouTube khi bị đòi xác minh |
| `YTDLP_PATH` | tự quản lý | Dùng yt-dlp có sẵn thay vì tự tải |
| `YTDLP_GEO_COUNTRY` | | Giả vùng, ví dụ `VN` |
| `FFMPEG_PATH` | `ffmpeg` | |
| `LOG_LEVEL` | `info` | `debug` để log mọi request |
| `ENV_FILE` | `.env` | Đường dẫn file cấu hình |

Các thiết lập còn lại (định dạng tải về, Discord Application ID, tên và logo trang) đặt trong trang **Quản trị**.

## Trạng thái Discord

1. Admin tạo một Application tại [discord.com/developers](https://discord.com/developers/applications) và dán Application ID vào Quản trị → Discord. Tên Application là chữ hiện sau "Đang nghe".
2. Mỗi người vào Cài đặt → Trạng thái Discord, bật công tắc, tạo token.
3. Trên máy tính có Discord, chạy lệnh rồi dán token khi được hỏi:
   - Windows (PowerShell): `irm https://nhac.example.com/agent.ps1 | iex`
   - macOS / Linux (cần python3): `curl -fsSL https://nhac.example.com/agent.sh | sh`

Token được lưu trên máy, lần sau chỉ cần chạy lại lệnh. Để cửa sổ mở trong lúc nghe.

## API

Tạo token ở Cài đặt → API rồi gọi với header `Authorization: Bearer <token>`. Tài liệu đầy đủ tại `/docs` trên máy chủ của bạn (OpenAPI ở `/api/openapi.json`, thư viện TypeScript ở `/api/docs/client.ts`).

## Xử lý sự cố

- **YouTube báo "Sign in to confirm you're not a bot":** xuất cookies.txt từ trình duyệt (tiện ích "Get cookies.txt LOCALLY") và đặt vào `$DATA_DIR/cookies.txt`.
- **Trang quay mãi, không tải được:** máy chủ chưa chạy hoặc đã tắt. Kiểm tra `http://<máy chủ>:8080/api/health`.
- **Không thấy thay đổi sau khi cập nhật:** tải lại trang bằng Ctrl+Shift+R (app lưu giao diện cũ trong cache).
- **Không nhận được email:** kiểm tra `SMTP_*`, rồi dùng nút gửi email thử trong Quản trị → Hệ thống.

## Phát triển

Xem [AGENTS.md](AGENTS.md): kiến trúc, cách chạy chế độ phát triển, kiểm thử và quy ước code.
