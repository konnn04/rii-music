package clientproxy

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func mustParseURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("parse url %q: %v", raw, err)
	}
	return u
}

func startProxy(t *testing.T, remote *url.URL, rt http.RoundTripper) *httptest.Server {
	t.Helper()
	h, err := newWithTransport(remote, nil, rt)
	if err != nil {
		t.Fatalf("newWithTransport: %v", err)
	}
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return srv
}

func TestForwardHostOriginRefererAndHeaders(t *testing.T) {
	var gotHost, gotOrigin, gotReferer string
	remoteSrv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotHost = r.Host
		gotOrigin = r.Header.Get("Origin")
		gotReferer = r.Header.Get("Referer")

		switch r.URL.Path {
		case "/":
			w.Header().Set("Strict-Transport-Security", "max-age=63072000")
			w.Header().Set("Content-Security-Policy", "default-src 'self'")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("home"))
		case "/api/me":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"user":"alice"}`))
		case "/redirect":
			w.Header().Set("Location", "https://"+r.Host+"/login?next=/")
			w.WriteHeader(http.StatusFound)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer remoteSrv.Close()

	remoteURL := mustParseURL(t, remoteSrv.URL)
	proxySrv := startProxy(t, remoteURL, remoteSrv.Client().Transport)

	client := &http.Client{
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}

	// GET /
	req, err := http.NewRequest(http.MethodGet, proxySrv.URL+"/", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Origin", proxySrv.URL)
	req.Header.Set("Referer", proxySrv.URL+"/tracks?p=1")

	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()

	if resp.StatusCode != http.StatusOK || string(body) != "home" {
		t.Fatalf("GET /: status=%d body=%q", resp.StatusCode, body)
	}
	if gotHost != remoteURL.Host {
		t.Fatalf("Host = %q, want %q", gotHost, remoteURL.Host)
	}
	if gotOrigin != remoteSrv.URL {
		t.Fatalf("Origin = %q, want %q", gotOrigin, remoteSrv.URL)
	}
	if gotReferer != remoteSrv.URL+"/tracks?p=1" {
		t.Fatalf("Referer = %q, want %q", gotReferer, remoteSrv.URL+"/tracks?p=1")
	}
	if hsts := resp.Header.Get("Strict-Transport-Security"); hsts != "" {
		t.Fatalf("HSTS should be dropped, got %q", hsts)
	}
	if csp := resp.Header.Get("Content-Security-Policy"); csp != "default-src 'self'" {
		t.Fatalf("CSP = %q, want preserved", csp)
	}

	// GET /api/me
	req, err = http.NewRequest(http.MethodGet, proxySrv.URL+"/api/me", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Origin", proxySrv.URL)

	resp, err = client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ = io.ReadAll(resp.Body)
	resp.Body.Close()

	if resp.StatusCode != http.StatusOK || string(body) != `{"user":"alice"}` {
		t.Fatalf("GET /api/me: status=%d body=%q", resp.StatusCode, body)
	}
	if gotHost != remoteURL.Host {
		t.Fatalf("/api/me Host = %q, want %q", gotHost, remoteURL.Host)
	}
	if gotOrigin != remoteSrv.URL {
		t.Fatalf("/api/me Origin = %q, want %q", gotOrigin, remoteSrv.URL)
	}

	// Location rewrite
	resp, err = client.Get(proxySrv.URL + "/redirect")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if loc := resp.Header.Get("Location"); loc != "/login?next=/" {
		t.Fatalf("Location = %q, want %q", loc, "/login?next=/")
	}
}

func TestSetCookieRewrite(t *testing.T) {
	remoteSrv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Add("Set-Cookie", "rii_session=x; Domain=music.example.com; Path=/; Secure; HttpOnly; SameSite=Lax")
		w.WriteHeader(http.StatusOK)
	}))
	defer remoteSrv.Close()

	proxySrv := startProxy(t, mustParseURL(t, remoteSrv.URL), remoteSrv.Client().Transport)

	resp, err := http.Get(proxySrv.URL + "/api/login")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()

	raw := resp.Header.Get("Set-Cookie")
	if raw == "" {
		t.Fatal("missing Set-Cookie header")
	}
	lower := strings.ToLower(raw)
	if strings.Contains(lower, "domain=") {
		t.Fatalf("Set-Cookie still contains Domain: %q", raw)
	}
	if strings.Contains(lower, "secure") {
		t.Fatalf("Set-Cookie still contains Secure: %q", raw)
	}
	if !strings.Contains(lower, "httponly") {
		t.Fatalf("Set-Cookie missing HttpOnly: %q", raw)
	}
	if !strings.Contains(lower, "samesite=lax") {
		t.Fatalf("Set-Cookie missing SameSite=Lax: %q", raw)
	}
	if !strings.Contains(raw, "rii_session=x") || !strings.Contains(raw, "Path=/") {
		t.Fatalf("Set-Cookie missing value or Path: %q", raw)
	}
}

func TestSSEStreamingFlushesImmediately(t *testing.T) {
	var secondWritten atomic.Bool

	remoteSrv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "no flusher", http.StatusInternalServerError)
			return
		}
		_, _ = io.WriteString(w, "data: first\n\n")
		flusher.Flush()

		time.Sleep(300 * time.Millisecond)

		secondWritten.Store(true)
		_, _ = io.WriteString(w, "data: second\n\n")
		flusher.Flush()
	}))
	defer remoteSrv.Close()

	proxySrv := startProxy(t, mustParseURL(t, remoteSrv.URL), remoteSrv.Client().Transport)

	resp, err := http.Get(proxySrv.URL + "/api/events")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	scanner := bufio.NewScanner(resp.Body)
	var gotFirst, gotSecond bool
	for scanner.Scan() {
		line := scanner.Text()
		if line == "data: first" {
			gotFirst = true
			if secondWritten.Load() {
				t.Fatal("first SSE event was not delivered before second event was written")
			}
		}
		if line == "data: second" {
			gotSecond = true
			break
		}
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	if !gotFirst || !gotSecond {
		t.Fatalf("gotFirst=%v gotSecond=%v, want both true", gotFirst, gotSecond)
	}
}

func TestRangeRequestPassthrough(t *testing.T) {
	payload := []byte("0123456789abcdef")
	remoteSrv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.ServeContent(w, r, "track.m4a", time.Unix(1700000000, 0), bytes.NewReader(payload))
	}))
	defer remoteSrv.Close()

	proxySrv := startProxy(t, mustParseURL(t, remoteSrv.URL), remoteSrv.Client().Transport)

	req, err := http.NewRequest(http.MethodGet, proxySrv.URL+"/api/stream/1", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Range", "bytes=4-7")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()

	if resp.StatusCode != http.StatusPartialContent {
		t.Fatalf("status = %d, want 206", resp.StatusCode)
	}
	if string(body) != "4567" {
		t.Fatalf("body = %q, want %q", body, "4567")
	}
	if cr := resp.Header.Get("Content-Range"); cr != "bytes 4-7/16" {
		t.Fatalf("Content-Range = %q, want %q", cr, "bytes 4-7/16")
	}
}

func TestUpstreamDownReturns502(t *testing.T) {
	remoteSrv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	remoteURL := mustParseURL(t, remoteSrv.URL)
	rt := remoteSrv.Client().Transport
	remoteSrv.Close() // ensure upstream is unreachable

	proxySrv := startProxy(t, remoteURL, rt)

	// HTML for /
	resp, err := http.Get(proxySrv.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()

	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("GET / status = %d, want 502", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.Contains(ct, "text/html") {
		t.Fatalf("GET / Content-Type = %q, want text/html", ct)
	}
	htmlStr := string(body)
	for _, want := range []string{
		"Không kết nối được máy chủ RiiMusic",
		remoteURL.String(),
		"Thử lại",
		"location.reload()",
		"Đổi máy chủ trong khay hệ thống → Đổi chế độ",
		"#0E0F12",
		"#EDEDF2",
	} {
		if !strings.Contains(htmlStr, want) {
			t.Errorf("offline HTML missing %q", want)
		}
	}

	// JSON for /api/x
	resp, err = http.Get(proxySrv.URL + "/api/x")
	if err != nil {
		t.Fatal(err)
	}
	body, _ = io.ReadAll(resp.Body)
	resp.Body.Close()

	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("GET /api/x status = %d, want 502", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.Contains(ct, "application/json") {
		t.Fatalf("GET /api/x Content-Type = %q, want application/json", ct)
	}
	if string(body) != `{"error":"Không kết nối được máy chủ"}` {
		t.Fatalf("GET /api/x body = %q", body)
	}
}

func TestLocalProxyEndpoint(t *testing.T) {
	var upstreamHits atomic.Int32
	remoteSrv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamHits.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	defer remoteSrv.Close()

	remoteURL := mustParseURL(t, remoteSrv.URL)
	proxySrv := startProxy(t, remoteURL, remoteSrv.Client().Transport)

	resp, err := http.Get(proxySrv.URL + "/__rii/proxy")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if upstreamHits.Load() != 0 {
		t.Fatalf("upstream was hit %d times, want 0", upstreamHits.Load())
	}

	var got struct {
		Mode   string `json:"mode"`
		Remote string `json:"remote"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got.Mode != "client" || got.Remote != remoteURL.String() {
		t.Fatalf("got %+v, want mode=client remote=%s", got, remoteURL.String())
	}
}

func TestCheckHealthVersion(t *testing.T) {
	// TLS server via checkWithTransport
	tlsSrv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/health" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok","version":"1.2.3"}`))
	}))
	defer tlsSrv.Close()

	ver, err := checkWithTransport(context.Background(), mustParseURL(t, tlsSrv.URL), tlsSrv.Client().Transport)
	if err != nil {
		t.Fatalf("checkWithTransport: %v", err)
	}
	if ver != "1.2.3" {
		t.Fatalf("version = %q, want %q", ver, "1.2.3")
	}

	// Plain HTTP server via exported Check
	httpSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/health" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"version":"2.0.0"}`))
	}))
	defer httpSrv.Close()

	ver, err = Check(context.Background(), mustParseURL(t, httpSrv.URL))
	if err != nil {
		t.Fatalf("Check: %v", err)
	}
	if ver != "2.0.0" {
		t.Fatalf("Check version = %q, want %q", ver, "2.0.0")
	}
}
