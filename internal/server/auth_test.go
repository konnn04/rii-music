package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"rii_music/internal/db"
	"rii_music/internal/ytdlp"
)

func newTestServer(t *testing.T) (*Server, *httptest.Server) {
	t.Helper()
	dir := t.TempDir()
	for _, d := range []string{"music", "covers", "tmp", "bin"} {
		os.MkdirAll(filepath.Join(dir, d), 0o755)
	}
	database := testDB(t)
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	cfg := Config{DataDir: dir, AdminEmail: "Admin@Example.com", AdminPassword: "admin-pass-1", DefaultStorageMB: 2048, MaxJobs: 1, FFmpeg: "ffmpeg"}
	s, err := New(cfg, database, ytdlp.New(ytdlp.Config{BinDir: filepath.Join(dir, "bin")}, log), fstest.MapFS{}, log)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.EnsureAdmin(); err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)
	return s, ts
}

// testDB gives each test its own PostgreSQL schema in TEST_DATABASE_URL
// (dropped afterwards). Without TEST_DATABASE_URL the test is skipped.
func testDB(t *testing.T) *db.DB {
	t.Helper()
	base := os.Getenv("TEST_DATABASE_URL")
	if base == "" {
		t.Skip("TEST_DATABASE_URL not set (e.g. postgres://rii@localhost:5432/rii_test?sslmode=disable)")
	}
	ctx := context.Background()
	admin, err := db.Connect(ctx, base)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("t_%d_%d", time.Now().UnixNano(), rand.IntN(1e6))
	// citext lives in public once per database; each schema migrates into itself.
	admin.Exec(`CREATE EXTENSION IF NOT EXISTS citext SCHEMA public`)
	if _, err := admin.Exec(`CREATE SCHEMA ` + schema); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		admin.Exec(`DROP SCHEMA ` + schema + ` CASCADE`)
		admin.Close()
	})
	sep := "?"
	if strings.Contains(base, "?") {
		sep = "&"
	}
	d, err := db.Open(ctx, base+sep+"search_path="+schema+",public")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	return d
}

type client struct {
	t    *testing.T
	base string
	hc   *http.Client
}

func newClient(t *testing.T, base string) *client {
	jar, _ := cookiejar.New(nil)
	return &client{t: t, base: base, hc: &http.Client{Jar: jar}}
}

func (c *client) do(method, path string, body any) (int, map[string]any) {
	c.t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, c.base+path, rd)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-RiiMusic", "1")
	res, err := c.hc.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	var out map[string]any
	json.Unmarshal(raw, &out)
	return res.StatusCode, out
}

func TestAccountsAndIsolation(t *testing.T) {
	s, ts := newTestServer(t)
	admin := newClient(t, ts.URL)

	if code, _ := admin.do("GET", "/api/me", nil); code != 401 {
		t.Fatalf("me before login: %d", code)
	}
	if code, _ := admin.do("POST", "/api/auth/login", map[string]string{"email": "admin@example.com", "password": "wrong-pass"}); code != 401 {
		t.Fatalf("wrong password: %d", code)
	}
	if code, _ := admin.do("POST", "/api/auth/login", map[string]string{"email": "nobody@example.com", "password": "x"}); code != 401 {
		t.Fatalf("unknown email: %d", code)
	}
	// Email is case-insensitive and comes from ADMIN_EMAIL.
	if code, body := admin.do("POST", "/api/auth/login", map[string]string{"email": "ADMIN@example.com", "password": "admin-pass-1"}); code != 200 {
		t.Fatalf("admin login: %d %v", code, body)
	}
	code, me := admin.do("GET", "/api/me", nil)
	if code != 200 || me["user"].(map[string]any)["role"] != "admin" {
		t.Fatalf("me: %d %v", code, me)
	}
	adminID := me["user"].(map[string]any)["id"].(string)

	// Admin creates a listener (no SMTP here, so a password is required).
	if code, _ := admin.do("POST", "/api/admin/users", map[string]any{"email": "nghe@example.com"}); code != 400 {
		t.Fatalf("create without password and without SMTP: %d", code)
	}
	code, created := admin.do("POST", "/api/admin/users", map[string]any{"email": "nghe@example.com", "name": "Người nghe", "password": "listener-1", "storageLimitMb": 512})
	if code != 201 {
		t.Fatalf("create user: %d %v", code, created)
	}
	listenerID := created["id"].(string)
	if code, _ := admin.do("POST", "/api/admin/users", map[string]any{"email": "NGHE@example.com", "password": "listener-1"}); code != 409 {
		t.Fatalf("duplicate email: %d", code)
	}

	// A track in the admin's library only.
	now := nowMs()
	s.db.Exec(`INSERT INTO tracks(id, source_id, title, artist, file_path, mime, size_bytes, added_at) VALUES ('aaaaaaaaaaaaaaaaaaaaaaaa', 'vid00000001', 'Bài của admin', 'A', 'music/x.m4a', 'audio/mp4', 1000, ?)`, now)
	s.db.Exec(`INSERT INTO user_tracks(user_id, track_id, added_at) VALUES (?, 'aaaaaaaaaaaaaaaaaaaaaaaa', ?)`, adminID, now)

	listener := newClient(t, ts.URL)
	if code, _ := listener.do("POST", "/api/auth/login", map[string]string{"email": "nghe@example.com", "password": "listener-1"}); code != 200 {
		t.Fatalf("listener login: %d", code)
	}
	if code, _ := listener.do("GET", "/api/admin/users", nil); code != 403 {
		t.Fatalf("listener on admin API: %d", code)
	}
	req, _ := http.NewRequest("GET", ts.URL+"/api/tracks", nil)
	res, _ := listener.hc.Do(req)
	raw, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if strings.TrimSpace(string(raw)) != "[]" {
		t.Fatalf("listener sees other library: %s", raw)
	}
	for _, p := range []string{"/api/tracks/aaaaaaaaaaaaaaaaaaaaaaaa", "/api/tracks/aaaaaaaaaaaaaaaaaaaaaaaa/stream", "/api/tracks/aaaaaaaaaaaaaaaaaaaaaaaa/cover"} {
		if code, _ := listener.do("GET", p, nil); code != 404 {
			t.Fatalf("listener %s: %d", p, code)
		}
	}
	if code, _ := listener.do("PUT", "/api/likes/aaaaaaaaaaaaaaaaaaaaaaaa", nil); code != 404 {
		t.Fatalf("listener liked another user's track: %d", code)
	}

	// Change password: mismatch, wrong current, then OK; other sessions end.
	other := newClient(t, ts.URL)
	other.do("POST", "/api/auth/login", map[string]string{"email": "nghe@example.com", "password": "listener-1"})
	if code, _ := listener.do("POST", "/api/me/password", map[string]string{"current": "listener-1", "password": "new-pass-22", "confirm": "new-pass-23"}); code != 400 {
		t.Fatalf("confirm mismatch: %d", code)
	}
	if code, _ := listener.do("POST", "/api/me/password", map[string]string{"current": "nope-nope", "password": "new-pass-22", "confirm": "new-pass-22"}); code != 400 {
		t.Fatalf("wrong current: %d", code)
	}
	if code, b := listener.do("POST", "/api/me/password", map[string]string{"current": "listener-1", "password": "new-pass-22", "confirm": "new-pass-22"}); code != 200 {
		t.Fatalf("change password: %d %v", code, b)
	}
	if code, _ := listener.do("GET", "/api/me", nil); code != 200 {
		t.Fatalf("this device signed out after change: %d", code)
	}
	if code, _ := other.do("GET", "/api/me", nil); code != 401 {
		t.Fatalf("other device still signed in: %d", code)
	}

	// Forgot password with a one-time code.
	email := "nghe@example.com"
	s.db.Exec(`INSERT INTO otp_codes(email, purpose, code_hash, expires_at, attempts, sent_at) VALUES (?, 'reset', ?, ?, 0, ?)`,
		email, s.auth.mac("otp", email, "reset", "123456"), time.Now().Add(otpTTL).UnixMilli(), nowMs())
	anon := newClient(t, ts.URL)
	if code, _ := anon.do("POST", "/api/auth/reset", map[string]string{"email": email, "code": "000000", "password": "reset-pass-3", "confirm": "reset-pass-3"}); code != 401 {
		t.Fatalf("wrong code: %d", code)
	}
	if code, _ := anon.do("POST", "/api/auth/reset", map[string]string{"email": email, "code": "123456", "password": "reset-pass-3", "confirm": "reset-pass-3"}); code != 200 {
		t.Fatalf("reset: %d", code)
	}
	if code, _ := anon.do("POST", "/api/auth/reset", map[string]string{"email": email, "code": "123456", "password": "again-pass-4", "confirm": "again-pass-4"}); code != 401 {
		t.Fatalf("code reused: %d", code)
	}
	if code, _ := newClient(t, ts.URL).do("POST", "/api/auth/login", map[string]string{"email": email, "password": "reset-pass-3"}); code != 200 {
		t.Fatalf("login with reset password: %d", code)
	}

	// Brute force on a code: blocked after 5 tries.
	s.db.Exec(`INSERT INTO otp_codes(email, purpose, code_hash, expires_at, attempts, sent_at) VALUES (?, 'login', ?, ?, 0, ?)`,
		email, s.auth.mac("otp", email, "login", "654321"), time.Now().Add(otpTTL).UnixMilli(), nowMs())
	// (called directly: over HTTP the per-IP limiter would step in first)
	for i := 0; i < otpMaxTries; i++ {
		if err := s.consumeOTP(email, "login", "111111"); err == nil {
			t.Fatal("wrong code accepted")
		}
	}
	if err := s.consumeOTP(email, "login", "654321"); err == nil {
		t.Fatal("code still valid after 5 wrong tries")
	}

	// The last admin stays an admin; a disabled user is signed out.
	if code, _ := admin.do("PATCH", "/api/admin/users/"+adminID, map[string]any{"role": "listener"}); code != 400 {
		t.Fatalf("self demote: %d", code)
	}
	if code, _ := admin.do("PATCH", "/api/admin/users/"+listenerID, map[string]any{"disabled": true}); code != 200 {
		t.Fatalf("disable: %d", code)
	}
	if code, _ := listener.do("GET", "/api/me", nil); code != 401 {
		t.Fatalf("disabled user still signed in: %d", code)
	}
	if code, _ := admin.do("DELETE", "/api/admin/users/"+listenerID, nil); code != 200 {
		t.Fatalf("delete user: %d", code)
	}
	// The admin's track survives; deleting the admin's own copy frees the file.
	if code, _ := admin.do("DELETE", "/api/tracks/aaaaaaaaaaaaaaaaaaaaaaaa", nil); code != 204 {
		t.Fatalf("remove own track: %d", code)
	}
	var n int
	s.db.QueryRow(`SELECT COUNT(*) FROM tracks`).Scan(&n)
	if n != 0 {
		t.Fatalf("orphan track not collected: %d", n)
	}
}

func TestPasswordHash(t *testing.T) {
	h, err := hashPassword("mật khẩu dài")
	if err != nil {
		t.Fatal(err)
	}
	if !checkPassword(h, "mật khẩu dài") || checkPassword(h, "mật khẩu sai") || checkPassword("garbage", "x") {
		t.Fatal("password check wrong")
	}
}

func TestDotEnv(t *testing.T) {
	p := filepath.Join(t.TempDir(), ".env")
	os.WriteFile(p, []byte("# comment\nRIIMUSIC_TEST_A=one\nexport RIIMUSIC_TEST_B=\"two words\"\nRIIMUSIC_TEST_C=x # trailing\nRIIMUSIC_TEST_SET=file\n"), 0o600)
	t.Setenv("RIIMUSIC_TEST_SET", "shell")
	os.Unsetenv("RIIMUSIC_TEST_A")
	os.Unsetenv("RIIMUSIC_TEST_B")
	os.Unsetenv("RIIMUSIC_TEST_C")
	if err := LoadDotEnv(p); err != nil {
		t.Fatal(err)
	}
	for k, want := range map[string]string{"RIIMUSIC_TEST_A": "one", "RIIMUSIC_TEST_B": "two words", "RIIMUSIC_TEST_C": "x", "RIIMUSIC_TEST_SET": "shell"} {
		if got := os.Getenv(k); got != want {
			t.Errorf("%s = %q, want %q", k, got, want)
		}
	}
	for _, k := range []string{"RIIMUSIC_TEST_A", "RIIMUSIC_TEST_B", "RIIMUSIC_TEST_C"} {
		os.Unsetenv(k)
	}
}

func TestFromHeader(t *testing.T) {
	for in, want := range map[string]string{
		"RiiMusic <noreply@example.dev>": `"RiiMusic" <noreply@example.dev>`,
		"noreply@example.dev":            `"RiiMusic" <noreply@example.dev>`,
		"":                               `"RiiMusic" <me@gmail.com>`,
		"Nhạc RiiMusic <a@b.co>":         "=?utf-8?q?Nh=E1=BA=A1c_RiiMusic?= <a@b.co>",
	} {
		if got := fromHeader(in, "me@gmail.com"); got != want {
			t.Errorf("fromHeader(%q) = %s, want %s", in, got, want)
		}
	}
}
