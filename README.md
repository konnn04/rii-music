<p align="center">
  <img src="web/public/icon.png" alt="RiiMusic" width="128" />
</p>

# RiiMusic

Web nghe nhạc tự host cho bạn và nhóm bạn bè. Tìm và tải nhạc từ YouTube Music, mỗi người một thư viện riêng, nghe trên điện thoại và máy tính như một app.

Một file chạy duy nhất (Go) phục vụ cả giao diện lẫn API. Dữ liệu bảng nằm trong PostgreSQL, nhạc và ảnh bìa nằm trong một thư mục.

## Tính năng

**Nghe nhạc**
- Phát, tua, trộn bài, lặp; crossfade, gapless giữa các bài cùng album, cân bằng âm lượng giữa các bài.
- Hàng đợi kéo thả, "Phát tiếp theo", lưu hàng đợi thành playlist.
- Lời bài hát chạy theo nhạc (LRCLIB), chỉnh độ lệch, tự tìm hoặc dán lời.
- Điều khiển từ màn hình khoá và thanh thông báo, cài thành app (PWA).
- Hẹn giờ ngủ (5–90 phút, nhạc nhỏ dần, hoặc hết bài này).
- Âm thanh trên chính thiết bị: EQ 10 băng có preset, tăng bass, làm sáng tiếng (exciter), crossfeed cho tai nghe, độ rộng stereo, chống vỡ tiếng.
- Nghe offline (tự bật): lưu giao diện, thư viện và bài đã nghe trên máy (giữ 30/60/90 ngày), “Tải về máy” trong menu ⋯ của bài.
- Một trình phát tại một thời điểm giữa các tab và thiết bị: thiết bị khác tự dừng, “Phát ở đây” để tiếp tục đúng bài, đúng chỗ.
- Hiệu ứng nền đập theo bass, 12 màu nhấn hoặc màu theo ảnh bìa; ảnh bìa chuyển liền mạch từ mini-player lên Đang phát.

**Tìm và tải**
- Tìm bài, album, playlist, video trên YouTube Music. Bấm Phát: bài đã có phát ngay, bài chưa có tải xong tự phát.
- Xem album / playlist, lưu cả album thành playlist.
- Trang nghệ sĩ: bài trong thư viện (kể cả góp giọng), bài hát và album trên YouTube Music.
- Theo dõi nghệ sĩ: danh sách hiện ở sidebar (PC) và Thư viện → Nghệ sĩ, bấm vào để xem; nghệ sĩ đang theo dõi được ưu tiên trong gợi ý.
- Thư viện lọc theo điều kiện (chữ, ngôn ngữ, thể loại, nghệ sĩ, album, đã thích, lượt nghe, ngày thêm, thời lượng); kéo bài thả vào playlist ở sidebar (PC).
- Chạy ngầm sau khi tải: nhúng lời vào file nhạc, gắn thể loại (Deezer, Last.fm), kiểm tra tên bài trên MusicBrainz cho video không chính thức.
- File nhạc dùng chung giữa mọi người: bài đã có trên máy chủ không tải lại.

**Gợi ý**
- Tự động gợi ý phát khi hàng đợi sắp hết, giữ đúng một ngôn ngữ (đang nghe nhạc Việt thì chỉ nhạc Việt).
- Mix hằng ngày, radio từ một bài, nghệ sĩ tương tự, playlist theo tâm trạng (trò chuyện với linh vật Vani), playlist thông minh theo thể loại.
- “Nghe giống” so âm sắc (MFCC), hoà âm (chroma), phổ, năng lượng và nhịp của bài.
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
cp .env.example .env      # điền ít nhất POSTGRES_PASSWORD, ADMIN_EMAIL, ADMIN_PASSWORD, PUBLIC_URL
docker compose up -d --build
```

Compose chạy hai container: app và PostgreSQL (chỉ app truy cập được). Mở `http://<máy chủ>:8080` và đăng nhập bằng `ADMIN_EMAIL` / `ADMIN_PASSWORD`. Lần chạy đầu, máy chủ tự tạo bảng và tải yt-dlp (xem bằng `docker compose logs -f`).

**Chạy thật trên Internet:**
- Đặt sau reverse proxy có HTTPS, ví dụ Caddy: `nhac.example.com { reverse_proxy localhost:8080 }`.
- Đặt `PUBLIC_URL=https://nhac.example.com` (dùng cho link trong email, link chia sẻ, ảnh bìa trên Discord).
- Với Nginx, tắt đệm cho cập nhật trực tiếp: `proxy_buffering off;` ở `/api/events`.

**Cập nhật:** `git pull && docker compose up -d --build`. Cơ sở dữ liệu tự nâng cấp (migration đánh số, chạy một lần, có khoá để không chạy chồng). Xem trạng thái: `docker compose exec rii_music rii_music migrate status`.

**Sao lưu:** cơ sở dữ liệu bằng `docker compose exec postgres pg_dump -U rii rii_music > backup.sql`; nhạc, ảnh bìa, cookies nằm trong volume `rii_music-data`.

## Chạy trực tiếp trên máy

Cần Go 1.27+, Node 22+ với pnpm, ffmpeg trong PATH, và một PostgreSQL (14 trở lên) với một database trống.

```bash
cp .env.example .env         # đặt DATABASE_URL trỏ tới PostgreSQL của bạn
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
| `DATABASE_URL` | Compose tự đặt | Chuỗi kết nối PostgreSQL, vd `postgres://rii:mat-khau@localhost:5432/rii_music?sslmode=disable` |
| `POSTGRES_PASSWORD` | | Mật khẩu PostgreSQL trong Docker Compose (chữ và số) |
| `PUBLIC_URL` | | Địa chỉ công khai (https) của trang |
| `SMTP_USERNAME` / `SMTP_PASSWORD` | | Gmail và app password. Thiếu thì đăng nhập bằng mã và quên mật khẩu bị tắt |
| `SMTP_HOST` / `SMTP_PORT` | `smtp.gmail.com` / `587` | Máy chủ gửi mail (465 = TLS ngay) |
| `SMTP_FROM` | `SMTP_USERNAME` | Người gửi, dạng `Tên <địa chỉ>` |
| `DEFAULT_STORAGE_LIMIT_MB` | `2048` | Dung lượng nhạc cho tài khoản mới |
| `LASTFM_API_KEY` | | Dùng Last.fm thay Deezer để tìm nghệ sĩ tương tự |
| `DATA_DIR` | `./data` | Thư mục nhạc, ảnh bìa, yt-dlp |
| `PORT` | `8080` | Cổng |
| `TRUST_PROXY` | `false` (Docker: `true`) | Lấy IP thật từ reverse proxy |
| `DOWNLOAD_CONCURRENCY` | `2` | Số bài tải cùng lúc |
| `MAX_DURATION_SEC` | `10800` | Bỏ qua video dài hơn |
| `YT_COOKIES_PATH` | `$DATA_DIR/cookies.txt` | Cookie YouTube khi bị đòi xác minh |
| `YTDLP_PATH` | tự quản lý | Dùng yt-dlp có sẵn thay vì tự tải |
| `YTDLP_GEO_COUNTRY` | | Giả vùng, ví dụ `VN` |
| `FORCE_IPV4` | `false` | Tắt IPv6, ép IPv4 cho yt-dlp (`--force-ipv4`) và mọi kết nối ra ngoài của server |
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

## Phiên bản và bản phát hành

`VERSION` giữ số chính và phụ (vd `1.0`). Mỗi lần push hoặc merge vào `main`, GitHub Actions chạy test rồi phát hành `v1.0.<số lần chạy>`: file chạy cho Linux (amd64, arm64), Windows, macOS (Intel, Apple Silicon) kèm `SHA256SUMS.txt`, và image Docker trên GHCR. Phiên bản đang chạy hiện ở Cài đặt → Giới thiệu và `rii_music -version`.

## Xử lý sự cố

- **YouTube báo "Sign in to confirm you're not a bot":** xuất cookies.txt từ trình duyệt (tiện ích "Get cookies.txt LOCALLY") và đặt vào `$DATA_DIR/cookies.txt`.
- **Trang quay mãi, không tải được:** máy chủ chưa chạy hoặc đã tắt. Kiểm tra `http://<máy chủ>:8080/api/health`.
- **Không thấy thay đổi sau khi cập nhật:** tải lại trang bằng Ctrl+Shift+R (app lưu giao diện cũ trong cache).
- **Không nhận được email:** kiểm tra `SMTP_*`, rồi dùng nút gửi email thử trong Quản trị → Hệ thống.

## Phát triển

Xem [AGENTS.md](AGENTS.md): kiến trúc, cách chạy chế độ phát triển, kiểm thử và quy ước code.
