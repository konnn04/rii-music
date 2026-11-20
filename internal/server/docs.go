package server

import (
	_ "embed"
	"net/http"
	"regexp"
	"sort"
	"strings"
)

// The public API, described once here and served as OpenAPI 3.1 at
// /api/openapi.json; the web app renders it at /docs.

type apiDoc struct {
	Method, Path, Tag, Summary string
	Auth                       string // "" (signed in / API token), public, admin, agent
	Query                      []string
	Body                       string // JSON example
	Resp                       string // JSON example
}

var apiDocs = []apiDoc{
	// accounts
	{"POST", "/api/auth/login", "Tài khoản", "Đăng nhập bằng email + mật khẩu (đặt cookie phiên)", "public", nil, `{"email":"ban@example.com","password":"••••••••"}`, `{"user":{"id":"…","email":"ban@example.com","role":"listener"},"usedBytes":0,"limitBytes":2147483648}`},
	{"POST", "/api/auth/otp", "Tài khoản", "Gửi mã 6 số qua email (purpose: login | reset)", "public", nil, `{"email":"ban@example.com","purpose":"login"}`, `{"ok":true,"ttlSec":600}`},
	{"POST", "/api/auth/otp/verify", "Tài khoản", "Đăng nhập bằng mã", "public", nil, `{"email":"ban@example.com","code":"123456"}`, ``},
	{"POST", "/api/auth/reset", "Tài khoản", "Đặt lại mật khẩu bằng mã", "public", nil, `{"email":"ban@example.com","code":"123456","password":"mới…","confirm":"mới…"}`, ``},
	{"POST", "/api/auth/logout", "Tài khoản", "Đăng xuất", "public", nil, ``, `{"ok":true}`},
	{"GET", "/api/me", "Tài khoản", "Tài khoản đang dùng, dung lượng đã dùng", "", nil, ``, `{"user":{"id":"…","email":"…","name":"…","role":"listener","storageLimitMb":2048},"usedBytes":123456,"tracks":12}`},
	{"PATCH", "/api/me", "Tài khoản", "Đổi tên hiển thị", "", nil, `{"name":"Tên mới"}`, ``},
	{"POST", "/api/me/password", "Tài khoản", "Đổi mật khẩu (mật khẩu cũ + mới hai lần)", "", nil, `{"current":"…","password":"…","confirm":"…"}`, ``},
	{"GET", "/api/tokens", "Tài khoản", "Danh sách token cá nhân", "", nil, ``, `[{"id":"…","kind":"api","name":"script","prefix":"vang_1a2b3c","createdAt":0,"lastUsedAt":0}]`},
	{"POST", "/api/tokens", "Tài khoản", "Tạo token (kind: api | agent). Token chỉ hiện một lần", "", nil, `{"kind":"api","name":"script của tôi"}`, `{"token":"vang_…","info":{"id":"…"}}`},
	{"DELETE", "/api/tokens/{id}", "Tài khoản", "Thu hồi token", "", nil, ``, ``},
	{"GET", "/api/settings", "Tài khoản", "Cài đặt cá nhân", "", nil, ``, `{"crossfadeSec":4,"normalize":true,"autoplayMode":"free","language":"vi"}`},
	{"PUT", "/api/settings", "Tài khoản", "Lưu cài đặt cá nhân (gửi một phần cũng được)", "", nil, `{"crossfadeSec":6}`, ``},

	// library
	{"GET", "/api/tracks", "Thư viện", "Mọi bài trong thư viện của bạn", "", []string{"sort: added | title | artist | plays"}, ``, `[{"id":"…","title":"…","artist":"…","album":"…","durationMs":215000,"playCount":3,"liked":false,"lang":"vi"}]`},
	{"GET", "/api/tracks/{id}", "Thư viện", "Một bài", "", nil, ``, ``},
	{"PATCH", "/api/tracks/{id}", "Thư viện", "Sửa tên bài / nghệ sĩ / album", "", nil, `{"title":"…","artist":"…"}`, ``},
	{"DELETE", "/api/tracks/{id}", "Thư viện", "Bỏ bài khỏi thư viện của bạn", "", nil, ``, ``},
	{"GET", "/api/tracks/{id}/stream", "Thư viện", "File nhạc (hỗ trợ Range)", "", nil, ``, ``},
	{"GET", "/api/tracks/{id}/cover", "Thư viện", "Ảnh bìa 720×720 JPEG", "", nil, ``, ``},
	{"GET", "/api/tracks/{id}/lyrics", "Lời bài hát", "Lời của bạn (của bạn chọn → cộng đồng chọn → tự động)", "", nil, ``, `{"plain":"…","synced":"[00:12.30] …","source":"lrclib","offsetMs":0,"choice":"auto"}`},
	{"GET", "/api/tracks/{id}/lyrics/candidates", "Lời bài hát", "Tìm lời trên LRCLIB bằng từ khoá của bạn", "", []string{"title", "artist", "q: tìm tự do"}, ``, `{"results":[{"id":123,"title":"…","artist":"…","synced":true,"picks":2,"durationOk":true}]}`},
	{"PUT", "/api/tracks/{id}/lyrics", "Lời bài hát", "Chọn lời (lrclibId), dán lời (text), chỉnh lệch (offsetMs) hoặc reset", "", nil, `{"lrclibId":123}`, ``},
	{"GET", "/api/artists", "Thư viện", "Nghệ sĩ trong thư viện", "", nil, ``, ``},
	{"GET", "/api/artist", "Thư viện", "Một nghệ sĩ: bài, album", "", []string{"name"}, ``, ``},
	{"GET", "/api/albums", "Thư viện", "Album trong thư viện", "", nil, ``, ``},
	{"GET", "/api/album", "Thư viện", "Một album", "", []string{"name", "artist"}, ``, ``},
	{"GET", "/api/web/list", "Tìm kiếm", "Các bài của một album / playlist YouTube Music", "", []string{"id: playlist id (OLAK5uy_… / PL…)"}, ``, `{"id":"…","title":"…","tracks":[]}`},
	{"POST", "/api/web/list/save", "Tìm kiếm", "Lưu album / playlist thành playlist RiiMusic (tải các bài vào đó)", "", nil, `{"id":"OLAK5uy_…"}`, `{"playlist":{},"queued":8,"added":2}`},
	{"GET", "/api/album/full", "Thư viện", "Đủ bài của album (từ YouTube Music), đánh dấu bài đã có", "", []string{"name", "artist"}, ``, ``},
	{"PUT", "/api/likes/{id}", "Thư viện", "Thích bài", "", nil, ``, `{"liked":true}`},
	{"DELETE", "/api/likes/{id}", "Thư viện", "Bỏ thích", "", nil, ``, `{"liked":false}`},
	{"GET", "/api/search", "Tìm kiếm", "Tìm trên YouTube Music (scope=web) hoặc trong thư viện", "", []string{"q", "scope: web | library", "kind: songs | albums | playlists | videos"}, ``, `{"results":[{"id":"videoId","title":"…","artist":"…","inLibrary":"","onServer":true}]}`},

	// playlists
	{"GET", "/api/playlists", "Playlist", "Playlist của bạn (kể cả Yêu thích)", "", nil, ``, ``},
	{"POST", "/api/playlists", "Playlist", "Tạo playlist (thường hoặc thông minh với rule)", "", nil, `{"name":"Đi làm","trackIds":["…"]}`, ``},
	{"GET", "/api/playlists/{id}", "Playlist", "Playlist và các bài", "", nil, ``, ``},
	{"PATCH", "/api/playlists/{id}", "Playlist", "Đổi tên / luật", "", nil, `{"name":"…"}`, ``},
	{"DELETE", "/api/playlists/{id}", "Playlist", "Xoá playlist", "", nil, ``, ``},
	{"POST", "/api/playlists/{id}/items", "Playlist", "Thêm bài", "", nil, `{"trackIds":["…"]}`, ``},
	{"PUT", "/api/playlists/{id}/items", "Playlist", "Sắp xếp lại (đủ mọi bài, theo thứ tự mới)", "", nil, `{"trackIds":["…"]}`, ``},
	{"DELETE", "/api/playlists/{id}/items/{trackId}", "Playlist", "Bỏ một bài", "", nil, ``, ``},
	{"GET", "/api/playlists/{id}/export", "Playlist", "Xuất M3U (hoặc JSON với format=json)", "", []string{"format: m3u | json"}, ``, ``},

	// downloads
	{"GET", "/api/downloads", "Tải về", "Danh sách tải của bạn", "", nil, ``, `{"jobs":[{"id":"…","status":"downloading","progress":0.4,"stage":"Đang tải"}]}`},
	{"POST", "/api/downloads", "Tải về", "Tải link YouTube / YouTube Music / playlist, hoặc từ khoá (mỗi dòng một mục)", "", nil, `{"input":"https://music.youtube.com/watch?v=…"}`, `{"jobs":[{"id":"…","status":"queued"}],"errors":[]}`},
	{"POST", "/api/downloads/{id}/retry", "Tải về", "Thử lại job lỗi", "", nil, ``, ``},
	{"DELETE", "/api/downloads/{id}", "Tải về", "Huỷ / xoá job", "", nil, ``, ``},
	{"GET", "/api/events", "Tải về", "Server-sent events: job, library, playlists, settings, trackGain…", "", nil, ``, ``},

	// listening & recommendations
	{"POST", "/api/events/listen", "Nghe & gợi ý", "Ghi một lượt nghe", "", nil, `{"trackId":"…","playedMs":180000,"action":"finish"}`, ``},
	{"GET", "/api/history", "Nghe & gợi ý", "Nghe gần đây", "", []string{"limit"}, ``, ``},
	{"GET", "/api/stats", "Nghe & gợi ý", "Thống kê nghe", "", []string{"days", "tz: phút lệch UTC (getTimezoneOffset)"}, ``, ``},
	{"GET", "/api/home", "Nghe & gợi ý", "Trang chủ: tiếp tục nghe, mix, gợi ý", "", nil, ``, ``},
	{"GET", "/api/radio", "Nghe & gợi ý", "Radio quanh một bài (cùng ngôn ngữ)", "", []string{"seed: track id"}, ``, `{"name":"Radio: …","tracks":[]}`},
	{"GET", "/api/recs/foryou", "Nghe & gợi ý", "Gợi ý trong thư viện", "", nil, ``, ``},
	{"GET", "/api/recs/discover", "Nghe & gợi ý", "Nghệ sĩ và bài mới ngoài thư viện", "", nil, ``, ``},
	{"GET", "/api/recs/autoplay", "Nghe & gợi ý", "Bài mới để tự phát sau một bài", "", []string{"seed", "ext: số bài (0–4)"}, ``, ``},
	{"POST", "/api/recs/mood", "Nghe & gợi ý", "Playlist theo tâm trạng (happy | sad | chill | energetic | focus)", "", nil, `{"mood":"chill"}`, `{"name":"Thư giãn","tracks":[]}`},
	{"POST", "/api/feedback", "Nghe & gợi ý", "“Ít gợi ý kiểu này” cho nghệ sĩ / bài", "", nil, `{"kind":"artist","key":"Tên nghệ sĩ","value":-1}`, ``},

	// share
	{"GET", "/api/tracks/{id}/share", "Chia sẻ", "Tạo link chia sẻ", "", nil, ``, `{"url":"https://…/s/…"}`},
	{"GET", "/api/share/{tok}", "Chia sẻ", "Thông tin bài được chia sẻ (access: preview | add | full)", "public", nil, ``, ``},
	{"GET", "/api/share/{tok}/preview", "Chia sẻ", "Đoạn nghe thử 30 giây", "public", nil, ``, ``},
	{"POST", "/api/share/{tok}/add", "Chia sẻ", "Thêm bài được chia sẻ vào thư viện", "", nil, ``, ``},

	// discord
	{"POST", "/api/nowplaying", "Discord", "Báo bài đang phát (khi bật Trạng thái Discord)", "", nil, `{"trackId":"…","positionMs":42000,"playing":true}`, ``},
	{"GET", "/api/agent/nowplaying", "Discord", "Agent đọc bài đang phát (token loại agent)", "agent", nil, ``, `{"nowPlaying":{"title":"…"},"discordClientId":"…"}`},

	// admin
	{"GET", "/api/admin/users", "Admin", "Mọi tài khoản", "admin", nil, ``, ``},
	{"POST", "/api/admin/users", "Admin", "Tạo tài khoản", "admin", nil, `{"email":"…","role":"listener","storageLimitMb":2048,"sendInvite":true}`, ``},
	{"PATCH", "/api/admin/users/{id}", "Admin", "Sửa vai trò, email, giới hạn, khoá, mật khẩu", "admin", nil, `{"storageLimitMb":4096}`, ``},
	{"DELETE", "/api/admin/users/{id}", "Admin", "Xoá tài khoản", "admin", nil, ``, ``},
	{"GET", "/api/admin/users/{id}/stats", "Admin", "Thói quen nghe của một người", "admin", []string{"days"}, ``, ``},
	{"GET", "/api/admin/system", "Admin", "Trạng thái máy chủ", "admin", nil, ``, ``},
	{"PUT", "/api/admin/branding", "Admin", "Tên, mô tả trang", "admin", nil, `{"name":"Nhạc nhà mình","description":"…"}`, ``},
}

var pathParamRe = regexp.MustCompile(`\{([a-zA-Z]+)\}`)

func (s *Server) handleOpenAPI(w http.ResponseWriter, r *http.Request) {
	b := s.branding()
	paths := map[string]map[string]any{}
	tags := map[string]bool{}
	for _, d := range apiDocs {
		tags[d.Tag] = true
		op := map[string]any{"tags": []string{d.Tag}, "summary": d.Summary, "operationId": strings.ToLower(d.Method) + strings.NewReplacer("/api/", "_", "/", "_", "{", "", "}", "").Replace(d.Path)}
		params := []map[string]any{}
		for _, m := range pathParamRe.FindAllStringSubmatch(d.Path, -1) {
			params = append(params, map[string]any{"name": m[1], "in": "path", "required": true, "schema": map[string]string{"type": "string"}})
		}
		for _, q := range d.Query {
			name, desc, _ := strings.Cut(q, ":")
			params = append(params, map[string]any{"name": strings.TrimSpace(name), "in": "query", "description": strings.TrimSpace(desc), "schema": map[string]string{"type": "string"}})
		}
		if len(params) > 0 {
			op["parameters"] = params
		}
		if d.Body != "" {
			op["requestBody"] = map[string]any{"content": map[string]any{"application/json": map[string]any{"example": rawJSON(d.Body)}}}
		}
		resp := map[string]any{"description": "OK"}
		if d.Resp != "" {
			resp["content"] = map[string]any{"application/json": map[string]any{"example": rawJSON(d.Resp)}}
		}
		op["responses"] = map[string]any{"200": resp, "401": map[string]string{"description": "Chưa đăng nhập / sai token"}}
		switch d.Auth {
		case "public":
			op["security"] = []any{}
		case "agent":
			op["security"] = []map[string][]string{{"agentToken": {}}}
		case "admin":
			op["x-role"] = "admin"
		}
		if paths[d.Path] == nil {
			paths[d.Path] = map[string]any{}
		}
		paths[d.Path][strings.ToLower(d.Method)] = op
	}
	tagList := []map[string]string{}
	for t := range tags {
		tagList = append(tagList, map[string]string{"name": t})
	}
	sort.Slice(tagList, func(i, j int) bool { return docTagOrder(tagList[i]["name"]) < docTagOrder(tagList[j]["name"]) })
	writeJSON(w, http.StatusOK, map[string]any{
		"openapi": "3.1.0",
		"info": map[string]any{
			"title":       b.Name + " API",
			"version":     "1",
			"description": "API của máy chủ nhạc " + b.Name + ". Gọi bằng token cá nhân (Cài đặt → API): `Authorization: Bearer vang_…`. Mọi bài, playlist, lịch sử là của tài khoản sở hữu token.",
		},
		"servers":  []map[string]string{{"url": s.baseURL(r)}},
		"tags":     tagList,
		"paths":    paths,
		"security": []map[string][]string{{"bearer": {}}, {"cookie": {}}},
		"components": map[string]any{"securitySchemes": map[string]any{
			"bearer":     map[string]string{"type": "http", "scheme": "bearer", "description": "Token cá nhân loại api"},
			"agentToken": map[string]string{"type": "http", "scheme": "bearer", "description": "Token loại agent (Discord)"},
			"cookie":     map[string]string{"type": "apiKey", "in": "cookie", "name": sessionCookie},
		}},
	})
}

func docTagOrder(t string) int {
	for i, x := range []string{"Tài khoản", "Thư viện", "Tìm kiếm", "Lời bài hát", "Playlist", "Tải về", "Nghe & gợi ý", "Chia sẻ", "Discord", "Admin"} {
		if x == t {
			return i
		}
	}
	return 99
}

type rawJSON string

func (j rawJSON) MarshalJSON() ([]byte, error) { return []byte(j), nil }

//go:embed client.ts
var clientTS []byte

// handleClientLib serves the TypeScript client library.
func (s *Server) handleClientLib(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="riimusic-client.ts"`)
	w.Write(clientTS)
}
