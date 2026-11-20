package server

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"testing"
)

// seedTrack puts a shared track straight into the store and a user's library.
func seedTrack(t *testing.T, s *Server, uid, id, title, artist, lang string) {
	t.Helper()
	if _, err := s.db.Exec(`INSERT OR IGNORE INTO tracks(id, source_id, title, artist, file_path, mime, size_bytes, lang, added_at) VALUES (?,?,?,?,?,?,?,?,?)`,
		id, "v"+id, title, artist, "music/"+id+".m4a", "audio/mp4", 1000, lang, nowMs()); err != nil {
		t.Fatal(err)
	}
	if uid != "" {
		s.db.Exec(`INSERT OR IGNORE INTO user_tracks(user_id, track_id, added_at) VALUES (?,?,?)`, uid, id, nowMs())
	}
}

func hexID(n int) string {
	return strings.Repeat("0", 22) + string(rune('a'+n/10)) + string(rune('0'+n%10))
}

func loginAdmin(t *testing.T, ts string) (*client, string) {
	c := newClient(t, ts)
	if code, _ := c.do("POST", "/api/auth/login", map[string]string{"email": "admin@example.com", "password": "admin-pass-1"}); code != 200 {
		t.Fatal("admin login", code)
	}
	_, me := c.do("GET", "/api/me", nil)
	return c, me["user"].(map[string]any)["id"].(string)
}

func TestRadioKeepsOneLanguage(t *testing.T) {
	s, ts := newTestServer(t)
	admin, uid := loginAdmin(t, ts.URL)
	for i := 0; i < 6; i++ {
		seedTrack(t, s, uid, hexID(i), "Bài Việt", "Ca Sĩ Việt", "vi")
		seedTrack(t, s, uid, hexID(20+i), "日本の歌", "Japanese Artist", "ja")
	}
	for seed, want := range map[string]string{hexID(0): "vi", hexID(20): "ja"} {
		req, _ := http.NewRequest("GET", ts.URL+"/api/radio?seed="+seed, nil)
		res, err := admin.hc.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		var body struct{ Tracks []Track }
		json.NewDecoder(res.Body).Decode(&body)
		res.Body.Close()
		if len(body.Tracks) < 2 {
			t.Fatalf("radio %s: %d tracks", want, len(body.Tracks))
		}
		for _, tr := range body.Tracks {
			if tr.Lang != want {
				t.Errorf("radio from a %s song contains %s song %q", want, tr.Lang, tr.Title)
			}
		}
	}
}

func TestAPITokens(t *testing.T) {
	_, ts := newTestServer(t)
	admin, _ := loginAdmin(t, ts.URL)
	code, created := admin.do("POST", "/api/tokens", map[string]string{"kind": "api", "name": "script"})
	if code != 201 {
		t.Fatalf("create token: %d", code)
	}
	tok := created["token"].(string)
	call := func(path, tok string) int {
		req, _ := http.NewRequest("GET", ts.URL+path, nil)
		req.Header.Set("Authorization", "Bearer "+tok)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res.StatusCode
	}
	if c := call("/api/me", tok); c != 200 {
		t.Fatalf("bearer api token: %d", c)
	}
	if c := call("/api/me", tok+"x"); c != 401 {
		t.Fatalf("wrong token: %d", c)
	}
	_, agent := admin.do("POST", "/api/tokens", map[string]string{"kind": "agent"})
	if c := call("/api/me", agent["token"].(string)); c != 401 {
		t.Fatalf("agent token used on the API: %d", c)
	}
	if c := call("/api/agent/nowplaying", agent["token"].(string)); c != 200 {
		t.Fatalf("agent endpoint: %d", c)
	}
	if c := call("/api/agent/nowplaying", tok); c != 401 {
		t.Fatalf("api token used as agent: %d", c)
	}
	// Revoked tokens stop working.
	admin.do("DELETE", "/api/tokens/"+created["info"].(map[string]any)["id"].(string), nil)
	if c := call("/api/me", tok); c != 401 {
		t.Fatalf("revoked token still works: %d", c)
	}
}

func TestShareLinks(t *testing.T) {
	s, ts := newTestServer(t)
	admin, uid := loginAdmin(t, ts.URL)
	id := hexID(1)
	seedTrack(t, s, uid, id, "Bài Chia Sẻ", "Ca Sĩ", "vi")
	code, link := admin.do("GET", "/api/tracks/"+id+"/share", nil)
	if code != 200 {
		t.Fatalf("share link: %d", code)
	}
	tok := link["url"].(string)[strings.LastIndex(link["url"].(string), "/s/")+3:]

	anon := newClient(t, ts.URL)
	if code, info := anon.do("GET", "/api/share/"+tok, nil); code != 200 || info["access"] != "preview" {
		t.Fatalf("anonymous share info: %d %v", code, info)
	}
	if code, _ := anon.do("GET", "/api/share/"+id+"-0000000000000000bad0", nil); code != 404 {
		t.Fatalf("forged signature: %d", code)
	}
	if code, _ := anon.do("POST", "/api/share/"+tok+"/add", nil); code != 401 {
		t.Fatalf("anonymous add: %d", code)
	}
	if code, _ := admin.do("GET", "/api/share/"+tok, nil); code != 200 {
		t.Fatal("owner share info")
	}

	admin.do("POST", "/api/admin/users", map[string]any{"email": "b@example.com", "password": "listener-b"})
	b := newClient(t, ts.URL)
	b.do("POST", "/api/auth/login", map[string]string{"email": "b@example.com", "password": "listener-b"})
	if _, info := b.do("GET", "/api/share/"+tok, nil); info["access"] != "add" {
		t.Fatalf("signed-in visitor access: %v", info["access"])
	}
	if code, _ := b.do("POST", "/api/share/"+tok+"/add", nil); code != 200 {
		t.Fatalf("add shared song: %d", code)
	}
	if _, info := b.do("GET", "/api/share/"+tok, nil); info["access"] != "full" {
		t.Fatalf("after add: %v", info["access"])
	}
}

func TestCommunityLyrics(t *testing.T) {
	s, ts := newTestServer(t)
	admin, _ := loginAdmin(t, ts.URL)
	id := hexID(2)
	seedTrack(t, s, "", id, "Bài Hiếm", "Ai Đó", "vi")
	s.saveShared(id, Lyrics{Source: "none"})
	var uids []string
	for _, e := range []string{"c1@example.com", "c2@example.com", "c3@example.com"} {
		_, u := admin.do("POST", "/api/admin/users", map[string]any{"email": e, "password": "password-1"})
		uids = append(uids, u["id"].(string))
		s.db.Exec(`INSERT INTO user_tracks(user_id, track_id, added_at) VALUES (?,?,?)`, u["id"], id, nowMs())
	}
	// Two users pick the same LRCLIB entry.
	for _, uid := range uids[:2] {
		s.saveChoice(uid, id, choiceRow{source: "lrclib", lrclibID: 42, plain: "lời đúng", synced: "[00:01.00] lời đúng"})
	}
	l, ok, err := s.lyricsFor(uids[2], id)
	if err != nil || !ok || l.Choice != "community" || l.LrclibID != 42 {
		t.Fatalf("third user: %+v ok=%v err=%v", l, ok, err)
	}
	// One user's own choice beats the community's.
	s.saveChoice(uids[2], id, choiceRow{source: "manual", plain: "lời của tôi"})
	if l, _, _ := s.lyricsFor(uids[2], id); l.Choice != "mine" || l.Plain != "lời của tôi" {
		t.Fatalf("own choice: %+v", l)
	}
	// A single pick is not enough to suggest it to others.
	s.db.Exec(`DELETE FROM lyrics_choices WHERE user_id = ?`, uids[1])
	if l, _, _ := s.lyricsFor(uids[1], id); l.Choice == "community" {
		t.Fatalf("one pick became a suggestion: %+v", l)
	}
}

func TestBrandingInIndex(t *testing.T) {
	s, _ := newTestServer(t)
	s.saveBranding(Branding{Name: "Nhạc <Nhà>", Description: "Mô tả & thử"})
	page := string(s.brandIndex([]byte(`<head><title>RiiMusic</title></head>`), "/"))
	if !strings.Contains(page, "<title>Nhạc &lt;Nhà&gt;</title>") || !strings.Contains(page, `content="Mô tả &amp; thử"`) {
		t.Fatalf("branding not injected / escaped: %s", page)
	}
	if strings.Contains(page, "noindex") {
		t.Fatal("home page must be indexable")
	}
	if !strings.Contains(string(s.brandIndex([]byte(`<title>RiiMusic</title>`), "/s/abc")), "noindex") {
		t.Fatal("share pages must be noindex")
	}
	_ = io.Discard
}

// Every endpoint in the API docs must exist (docs can't drift from routes).
func TestDocsMatchRoutes(t *testing.T) {
	_, ts := newTestServer(t)
	admin, _ := loginAdmin(t, ts.URL)
	_, created := admin.do("POST", "/api/tokens", map[string]string{"kind": "api"})
	tok := created["token"].(string) // a bearer token survives the documented logout call
	for _, d := range apiDocs {
		if d.Path == "/api/events" || d.Path == "/api/auth/logout" {
			continue // endless SSE stream / would end nothing for a token
		}
		path := pathParamRe.ReplaceAllString(d.Path, "x")
		req, _ := http.NewRequest(d.Method, ts.URL+path, strings.NewReader("{}"))
		req.Header.Set("Content-Type", "application/json")
		if d.Auth == "agent" {
			_, ag := admin.do("POST", "/api/tokens", map[string]string{"kind": "agent"})
			req.Header.Set("Authorization", "Bearer "+ag["token"].(string))
		} else if d.Auth != "public" {
			req.Header.Set("Authorization", "Bearer "+tok)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(res.Body)
		res.Body.Close()
		if res.StatusCode == 404 && strings.Contains(string(b), "Không tìm thấy endpoint") || res.StatusCode == 405 {
			t.Errorf("documented but not routed: %s %s (%d)", d.Method, d.Path, res.StatusCode)
		}
		if res.StatusCode == 401 && d.Auth != "public" {
			t.Errorf("token rejected on %s %s: %s", d.Method, d.Path, b)
		}
	}
	code, spec := admin.do("GET", "/api/openapi.json", nil)
	if code != 200 || spec["openapi"] != "3.1.0" || len(spec["paths"].(map[string]any)) < 40 {
		t.Fatalf("openapi: %d", code)
	}
}

func TestLogBufferMasksSecrets(t *testing.T) {
	b := NewLogBuffer(3)
	l := slog.New(b.Wrap(slog.NewTextHandler(io.Discard, nil)))
	l.Warn("tạo admin", "email", "a@b.c", "password", "hunter22")
	l.Info("x")
	l.Info("y")
	l.Info("z") // ring of 3: the first record is dropped
	recs := b.since(0)
	if len(recs) != 3 || recs[0].Msg != "x" {
		t.Fatalf("ring: %+v", recs)
	}
	b2 := NewLogBuffer(10)
	slog.New(b2.Wrap(slog.NewTextHandler(io.Discard, nil))).Warn("m", "password", "hunter22", "token", "rii_x")
	r := b2.since(0)[0]
	if r.Attrs["password"] != "••••" || r.Attrs["token"] != "••••" {
		t.Fatalf("secret stored: %+v", r.Attrs)
	}
}

func TestMoodPlaylistOneLanguage(t *testing.T) {
	s, ts := newTestServer(t)
	admin, uid := loginAdmin(t, ts.URL)
	for i := 0; i < 8; i++ {
		seedTrack(t, s, uid, hexID(i), "Bài Việt", "Ca Sĩ", "vi")
	}
	for i := 0; i < 3; i++ {
		seedTrack(t, s, uid, hexID(30+i), "Song", "Singer", "en")
	}
	code, res := admin.do("POST", "/api/recs/mood", map[string]string{"mood": "chill"})
	if code != 200 {
		t.Fatalf("mood: %d %v", code, res)
	}
	tracks := res["tracks"].([]any)
	if len(tracks) == 0 {
		t.Fatal("no tracks without audio analysis")
	}
	for _, x := range tracks {
		if x.(map[string]any)["lang"] != "vi" {
			t.Errorf("mood list mixes languages: %v", x)
		}
	}
	if code, _ := admin.do("POST", "/api/recs/mood", map[string]string{"mood": "angry"}); code != 400 {
		t.Fatalf("unknown mood: %d", code)
	}
}

// Sound-alikes are computed over every track on the server; radio must only
// hand back tracks from the user's own library (an empty one broke the queue).
func TestRadioOnlyOwnTracks(t *testing.T) {
	s, ts := newTestServer(t)
	admin, uid := loginAdmin(t, ts.URL)
	vec := `[1,0.5,0.2,0.1,0.3,0.4,0.2,0.1,0.3,0.2,0.1,0.4,0.3,0.2,0.1,0.2,0.3,0.4,0.5,0.6]`
	for i := 0; i < 8; i++ {
		owner := uid
		if i >= 4 {
			owner = "" // someone else's track: on the server, not in this library
		}
		seedTrack(t, s, owner, hexID(i), "Bài", "Ca Sĩ", "vi")
		s.db.Exec(`INSERT INTO track_features(track_id, version, vec, computed_at) VALUES (?,?,?,?)`, hexID(i), featureVersion, vec, nowMs())
	}
	s.features.markDirty()
	req, _ := http.NewRequest("GET", ts.URL+"/api/radio?seed="+hexID(0), nil)
	res, err := admin.hc.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var body struct{ Tracks []Track }
	json.NewDecoder(res.Body).Decode(&body)
	res.Body.Close()
	if len(body.Tracks) < 2 {
		t.Fatalf("radio: %d tracks", len(body.Tracks))
	}
	for _, tr := range body.Tracks {
		if tr.ID == "" || tr.Title == "" {
			t.Fatalf("radio returned an empty track: %+v", tr)
		}
	}
}
