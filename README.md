# RiiMusic — web nghe nhạc cá nhân

Web app nghe nhạc tự host cho bạn và nhóm nhỏ: tải nhạc từ YouTube bằng yt-dlp, mỗi người một thư viện riêng (file nhạc lưu chung, không tải trùng), nghe trên điện thoại và máy tính như một app (PWA).

Một binary Go phục vụ cả API lẫn giao diện (Vite + React nhúng bằng `go:embed`). Dữ liệu nằm trong một thư mục: SQLite, file nhạc, ảnh bìa, yt-dlp.

## Đã có

| Nhóm | Tính năng |
| --- | --- |
| Tải về | Dán link video / playlist YouTube, YouTube Music, youtu.be, shorts, hoặc gõ từ khoá. Nhiều dòng một lần. Chạy nền 2 job song song, tiến độ realtime (SSE), thử lại, huỷ. Chống trùng theo video id. |
| Xử lý | ffmpeg giữ nguyên AAC/Opus khi được (không chuyển mã); độ ồn EBU R128 (`ebur128`, −14 LUFS, chặn true peak −1 dBTP) đo ngầm sau khi bài đã vào thư viện nên nghe được ngay; gắn tag, cắt viền đen rồi cắt vuông ảnh bìa 720 px. Làm sạch tiêu đề “Nghệ sĩ - Bài (Official MV)”, sửa tay được. |
| yt-dlp | Tự tải bản nightly, kiểm SHA-256, làm mới mỗi ngày. Thử lần lượt các player client khi YouTube từ chối. Hỗ trợ `cookies.txt` và JS runtime (deno/node) cho YouTube. |
| Thư viện | Tab Bài hát / Nghệ sĩ / Album / Playlist, sắp xếp mới thêm / tên / nghệ sĩ / nghe nhiều, danh sách ảo hoá cho hàng nghìn bài. |
| Tìm kiếm | Gọi thẳng API tìm kiếm của YouTube Music (~0,5 s): Bài hát / Album / Playlist / Video, có nghệ sĩ, album, thời lượng; tự lùi về yt-dlp nếu YouTube Music lỗi. Bài đã có hiện dấu tick (khớp video id, hoặc cùng nghệ sĩ + tên bài). Lọc Đã tải / Chưa tải, lọc theo tên không dấu. Tải cả album / playlist một lần. |
| Phát nhạc | Play/pause/seek, trước/sau, trộn bài, lặp (tắt/tất cả/một bài), âm lượng, nhớ hàng đợi và vị trí khi tải lại trang. Media Session (màn hình khoá, phím media). |
| Hàng đợi | “Phát tiếp theo”, “Thêm vào hàng đợi”, tách hàng đợi thêm tay khỏi phần tiếp theo của playlist, kéo thả, xoá, lưu thành playlist. |
| Chuyển bài | Crossfade 0–12 s (Web Audio, hai phần tử audio luân phiên), tải trước bài kế 15 s trước khi hết, gapless khi cùng album, fade 200 ms khi pause/play/seek, chuẩn hoá âm lượng theo gain đã đo. Chế độ âm thanh đơn giản (mặc định trên iPhone). |
| Playlist | Tạo, đổi tên, xoá, kéo thả, thêm hàng loạt, “Yêu thích”, playlist thông minh (nghe nhiều 30 ngày, mới thêm, chưa nghe, theo nghệ sĩ), ảnh ghép 4 bìa, xuất M3U/JSON. |
| Lời bài hát | LRCLIB (lời đồng bộ theo dòng), cache trong DB, dòng hiện tại sáng + tự cuộn, chạm dòng để tua, chỉnh lệch ±0,5 s lưu theo bài, dán lời thường hoặc LRC. Toàn màn hình bằng phím L. |
| Trang chủ | Tiếp tục nghe, Mix hằng ngày, Nghệ sĩ bạn hay nghe, Hay nghe buổi sáng/chiều/tối, Mới thêm, Radio từ một bài. |
| Lịch sử | Ghi finish / skip / repeat, trang Nghe gần đây, thống kê tuần/tháng/năm (phút nghe mỗi ngày, top bài, top nghệ sĩ). |
| Giao diện | Bộ token “RiiMusic” (tối + sáng), Be Vietnam Pro, màu nhấn khung Đang phát lấy từ ảnh bìa, nền bìa mờ. Mobile: thanh tab, mini-player, Đang phát toàn màn hình (vuốt xuống để thu). PC: sidebar + playlist, panel phải Đang phát / Hàng đợi / Lời, chuột phải, Ctrl+click chọn nhiều, phím tắt. |
| Bảo mật | Tài khoản email + mật khẩu (PBKDF2-SHA256) hoặc mã OTP qua email, cookie phiên ký HMAC (đổi mật khẩu là mọi phiên khác mất hiệu lực), giới hạn đăng nhập theo IP, OTP 6 số hết hạn 10 phút / tối đa 5 lần thử, mọi API cần đăng nhập, request thay đổi dữ liệu cần header `X-Vang`, chỉ nhận URL YouTube, tham số yt-dlp truyền bằng mảng (không qua shell). |

### Tài khoản

| Nhóm | Tính năng |
| --- | --- |
| Vai trò | Người nghe và Admin (admin có mọi quyền của người nghe). Admin đầu tiên tạo từ `ADMIN_EMAIL` / `ADMIN_PASSWORD` trong `.env` khi chưa có tài khoản nào. |
| Đăng nhập | Email + mật khẩu, hoặc email + mã OTP gửi qua Gmail (app password). Quên mật khẩu: nhận mã → nhập mã + mật khẩu mới hai lần. Đổi mật khẩu: mật khẩu cũ + mới hai lần. |
| Thư viện riêng | Lịch sử, thích, playlist, gợi ý, hàng chờ, cài đặt, danh sách tải là của từng người. File nhạc, ảnh bìa, lời, đặc trưng âm thanh dùng chung: bài người khác đã tải thì thêm vào ngay, không tải lại. Xoá bài chỉ gỡ khỏi thư viện của mình; file mất khi không còn ai có. |
| Quản trị | Thêm người dùng (gửi email mời), đổi vai trò, email, giới hạn dung lượng, khoá, đặt mật khẩu, đăng xuất mọi thiết bị, xoá. Xem thói quen nghe (phút nghe, giờ hay nghe, nghệ sĩ / bài nghe nhiều, lịch sử, thư viện), gỡ bài, xoá dữ liệu. Hệ thống: phiên bản và cập nhật yt-dlp, dung lượng, phân tích nền, hàng chờ tải của mọi người, dọn file thừa, cache gợi ý, email thử, định dạng tải về. |
| Tên bài | Lấy từ YouTube Music theo video id (bài chính thức, MV chính thức có nghệ sĩ gắn link); chỉ video người dùng tải lên mới phải làm sạch tiêu đề. |

### V2

| Nhóm | Tính năng |
| --- | --- |
| Hồ sơ khẩu vị | Từ lượt nghe (nghe hết +1, lặp +2, bỏ qua trước 30 s −1,5), lượt thích, playlist, nút “Ít gợi ý kiểu này”; giảm dần theo thời gian (nửa đời 30 ngày). |
| Tầng 1 | Nghệ sĩ tương tự từ Deezer (không cần key) hoặc Last.fm (`LASTFM_API_KEY`; ảnh nghệ sĩ vẫn lấy từ Deezer vì Last.fm đã bỏ ảnh). Cache 7 ngày trong DB. |
| Tầng 2 | Item-item: bài hay được nghe gần nhau trong cùng phiên. |
| Tầng 3 | Vector đặc trưng âm thanh (phổ, năng lượng, nhịp) tính bằng ffmpeg trên đoạn 90 s, chạy nền cho từng bài. Đây là đặc trưng thủ công, chưa phải embedding học máy. |
| Hiển thị | Trang Khám phá (Gợi ý cho bạn trong thư viện; nghệ sĩ và bài mới ngoài thư viện có nút Tải về), Trang chủ có Gợi ý cho bạn và Giống &lt;nghệ sĩ&gt;, trang Nghệ sĩ có Nghệ sĩ tương tự, menu bài có Bài nghe giống. Mix hằng ngày và Radio pha cả 3 tầng. Mỗi gợi ý có lý do. |
| Tự động gợi ý phát | Một nút 3 trạng thái ở hàng đợi: Tắt / Trong thư viện / Tự do. Hàng chờ còn dưới 3 bài thì thêm bài tương tự (radio 3 tầng, cùng ngôn ngữ với bài đang nghe); chế độ Tự do còn tải ngầm trước 2 bài mới và chèn vào khi xong. Nhảy cóc trong hàng đợi thì các bài bị bỏ qua không quay lại. |
| Ngôn ngữ nhạc | Mỗi bài có ngôn ngữ (Việt, Âu Mỹ, Nhật, Hàn, Hoa, Thái) đoán từ tên bài, tên nghệ sĩ (có dấu), lời bài hát và đa số bài của nghệ sĩ (bài V-pop tên tiếng Anh vẫn là V-pop). Radio, mix, gợi ý, tải ngầm giữ một ngôn ngữ, không trộn. |
| Lần đầu | Màn chào hỏi ngôn ngữ, thể loại, nghệ sĩ hay nghe (gợi ý nghệ sĩ từ YouTube Music); dùng làm điểm xuất phát khi chưa có lịch sử nghe. |
| Linh vật | Vani ở trang chủ: chào theo giờ, số phút nghe hôm nay, đeo tai nghe lắc lư khi đang phát; trò chuyện để tạo playlist theo tâm trạng (vui, buồn, thư giãn, sôi động, tập trung) từ đặc trưng âm thanh. |
| Tự động tải nhạc | Cài đặt → Tự động tải nhạc (mặc định tắt). Cứ 6 giờ xem lại thói quen nghe, tải trước tối đa 8 bài hợp gu trong giới hạn dung lượng admin đặt cho tài khoản (mặc định 2 GB). Vượt giới hạn thì bỏ bài ít khả năng nghe nhất khỏi thư viện; không bao giờ xoá bài đã thích, trong playlist, thêm trong 3 ngày hoặc nghe trong 14 ngày. Bài đã xoá không bị tải lại trong 90 ngày. |
| Dữ liệu | Cài đặt → Dữ liệu: xoá lịch sử nghe, hoặc xoá toàn bộ dữ liệu của mình (thư viện, playlist, thích, lịch sử, job). Phải gõ xác nhận. Người khác không bị ảnh hưởng. |

### Tìm kiếm, chia sẻ, giao diện

| Nhóm | Tính năng |
| --- | --- |
| Tìm kiếm | Kết quả YouTube Music có nút Phát: bài đã có (icon tải-tick xám) phát ngay, bài chưa có tải rồi tự phát khi xong. Album / playlist: bấm để xem danh sách bài, Phát tất cả, hoặc Lưu vào thư viện (thành playlist; bài tải xong tự vào đúng vị trí). |
| Đủ album | Trang album trong thư viện tìm album đó trên YouTube Music và liệt kê các bài bạn chưa có, kèm nút Lưu cả album. |
| Lời bài hát | Icon chỉnh nhỏ mở hộp: độ lệch, tìm lời bằng từ khoá của bạn (kết quả LRCLIB có xem trước, khớp độ dài, số người đã chọn), dán lời. Lựa chọn lưu theo người; khi từ 2 người chọn cùng một lời, người khác được gợi ý lời đó. |
| Đang phát (mobile) | Vuốt ngang Bìa / Lời / Hàng đợi; bìa luôn vuông theo kích thước màn hình, còn chỗ thì hiện dòng lời đang hát (chạm để mở Lời). |
| Chia sẻ | Link `/s/…` có chữ ký: người chưa đăng nhập nghe thử 30 giây (đoạn khoảng 1/4 bài), người đã đăng nhập thêm vào thư viện ngay. Trang chia sẻ `noindex`: chỉ tên trang được SEO. |
| Thương hiệu | Admin đặt tên trang, mô tả, logo: vào tiêu đề, header mobile, manifest PWA, thẻ meta. |
| Song ngữ | Tiếng Việt / English cho toàn bộ giao diện (kể cả admin), từ điển JSON theo vùng ở `web/src/i18n/locales/<vi|en>/`. Lỗi từ server được dịch ở client. |
| Thông báo | Toast có tiêu đề, nút hành động; `Tip` (icon giải thích) và `Hint` (mẹo hiện một lần) thay cho đoạn chữ dài. |
| Discord | Cài đặt → Trạng thái Discord: tạo token, chạy một lệnh, dán token khi được hỏi. Agent là script do máy chủ phục vụ, không cần tải exe: Windows `irm https://…/agent.ps1 \| iex` (PowerShell có sẵn), macOS / Linux `curl -fsSL https://…/agent.sh \| sh` (cần python3). Token được lưu trên máy, lần sau chỉ cần chạy lại lệnh. Admin đặt Discord Application ID một lần cho cả máy chủ. |
| API | Token cá nhân (Cài đặt → API), tài liệu tại `/docs` (OpenAPI 3.1 ở `/api/openapi.json`), thư viện TypeScript một file ở `/api/docs/client.ts`. |
| Admin | Thêm: log hệ thống trực tiếp (lọc mức độ, tìm, mật khẩu/token được che), thương hiệu, Discord. |

**Chưa làm:** cache offline, equalizer, đồng bộ phiên phát giữa thiết bị; embedding học máy thật (CLAP…) cho tầng 3.

## Chạy trên máy

Cần: Go 1.27+, Node 22+ và pnpm, ffmpeg trong PATH. yt-dlp sẽ tự tải về `data/bin`.

```bash
cp .env.example .env   # điền ADMIN_EMAIL, ADMIN_PASSWORD, SMTP_*
cd web && pnpm install && pnpm build && cd ..
go build -o vang .
./vang
# mở http://localhost:8080, đăng nhập bằng ADMIN_EMAIL / ADMIN_PASSWORD
```

`.env` chỉ được đọc lúc khởi động; biến môi trường thật được ưu tiên hơn. Admin đầu tiên chỉ được tạo khi DB chưa có tài khoản: đổi email / mật khẩu sau đó trong trang Quản trị và Cài đặt.

Phát triển giao diện: chạy server như trên, rồi `cd web && pnpm dev` (Vite proxy `/api` sang :8080). Hoặc đặt `WEB_DIR=./web/dist` để server đọc giao diện từ đĩa, khỏi build lại Go sau mỗi lần `pnpm build`.

## Triển khai (Docker)

Trên máy chủ (cần Docker + Compose):

```bash
git clone <repo> vang && cd vang
cp .env.example .env        # điền ADMIN_EMAIL, ADMIN_PASSWORD, SMTP_*, PUBLIC_URL
docker compose up -d --build
docker compose logs -f      # lần đầu: yt-dlp tự tải về /data/bin
```

- Dữ liệu (DB, nhạc, ảnh bìa, yt-dlp, `cookies.txt`) nằm trong volume `vang-data` → `/data`. Sao lưu volume này là đủ.
- Đặt sau reverse proxy có HTTPS (Caddy, Nginx, Traefik). Ví dụ Caddy: `nhac.example.com { reverse_proxy localhost:8080 }`. Đặt `PUBLIC_URL=https://nhac.example.com` (link trong email, link chia sẻ, ảnh bìa cho Discord).
- SSE (cập nhật trực tiếp) cần proxy không đệm: Nginx thêm `proxy_buffering off;` cho `/api/events`.
- Image đã có ffmpeg và deno. Agent Discord chạy bằng script (`/agent.ps1`, `/agent.sh`); muốn kèm thêm bản exe cho người dùng tải thì build với `--build-arg AGENT_BINARIES=true` (~60 MB).
- Cập nhật: `git pull && docker compose up -d --build`. Migration DB tự chạy.
- Coolify: tạo resource từ Docker Compose (hoặc Dockerfile), gắn volume `/data`, khai các biến trong `.env.example`.

## Biến môi trường

| Biến | Mặc định | Ý nghĩa |
| --- | --- | --- |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | `admin@vang.local` / tạo ngẫu nhiên in ra log | Admin đầu tiên (chỉ khi DB chưa có tài khoản) |
| `DEFAULT_STORAGE_LIMIT_MB` | `2048` | Giới hạn dung lượng nhạc cho tài khoản mới |
| `SMTP_HOST` / `SMTP_PORT` | `smtp.gmail.com` / `587` | Gửi mã OTP, thư mời (465 = TLS ngay) |
| `SMTP_USERNAME` / `SMTP_PASSWORD` | | Gmail + app password. Thiếu thì OTP và quên mật khẩu tắt |
| `SMTP_FROM` | `SMTP_USERNAME` | `Tên <địa chỉ>` hoặc chỉ địa chỉ |
| `LASTFM_API_KEY` | | Nghệ sĩ tương tự từ Last.fm thay vì Deezer |
| `ENV_FILE` | `.env` | Đường dẫn file cấu hình |
| `DATA_DIR` | `./data` | SQLite, nhạc, ảnh bìa, yt-dlp, `secret.key` |
| `PORT` | `8080` | |
| `TRUST_PROXY` | `false` (Docker: `true`) | Lấy IP từ `X-Forwarded-For` khi chạy sau reverse proxy |
| `FFMPEG_PATH` | `ffmpeg` | |
| `YTDLP_PATH` | (tự quản lý) | Dùng yt-dlp có sẵn thay vì tự tải |
| `YT_COOKIES_PATH` | `$DATA_DIR/cookies.txt` | cookies.txt (định dạng Netscape) khi YouTube đòi xác minh |
| `YTDLP_JS_RUNTIME` | tự tìm deno, rồi node | |
| `YTDLP_REMOTE_EJS` | `true` | `--remote-components ejs:github` |
| `YTDLP_GEO_COUNTRY` | | Giả vùng, ví dụ `VN` |
| `DOWNLOAD_CONCURRENCY` | `2` | Số job tải song song |
| `MAX_DURATION_SEC` | `10800` | Bỏ qua video dài hơn |
| `WEB_DIR` | | Phát triển: đọc giao diện từ thư mục này |
| `LOG_LEVEL` | `info` | `debug` để log mọi request |
| `PUBLIC_URL` | | Địa chỉ công khai (https) của trang: link trong email, link chia sẻ, ảnh bìa cho Discord |
| `AGENT_DIR` | `/opt/vang/agent` trong Docker | Thư mục chứa bản exe của agent Discord (chỉ khi build với `AGENT_BINARIES=true`) |
| `TZ` | `Asia/Ho_Chi_Minh` trong Docker | Múi giờ log |

Khi YouTube báo “Sign in to confirm you're not a bot”: xuất cookies.txt từ trình duyệt (tiện ích “Get cookies.txt LOCALLY”) và đặt vào `$DATA_DIR/cookies.txt`.

## Cấu trúc

```
main.go                  khởi động, cấu hình, tắt êm
internal/db              SQLite + migration
internal/ytdlp           quản lý binary yt-dlp, chạy tiến trình con
internal/textutil        tìm không dấu, làm sạch tiêu đề YouTube
internal/server          HTTP API, tài khoản (auth.go, mail.go, admin.go), SSE theo người dùng, bộ tải, lời, thống kê, đề xuất (recs.go, external.go, features.go), YouTube Music (ytmusic.go)
internal/discordrpc      client Discord Rich Presence qua IPC (để dành cho bản desktop; trình phát phát sự kiện `vang:nowplaying`)
web/                     Vite + React + TypeScript (TanStack Router/Query, Zustand, Tailwind v4, Radix, dnd-kit)
web/src/player           store hàng đợi + engine âm thanh (crossfade, gapless, Media Session)
```

Kiểm thử: `go test ./...` (làm sạch tiêu đề, kiểm URL đầu vào, tiến độ). `cd web && pnpm typecheck`.
