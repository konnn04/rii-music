package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestKinds(t *testing.T) {
	song := kindOf("Lạc Trôi", 230_000)
	for _, c := range []struct {
		title string
		durMs int64
		ok    bool
	}{
		{"Nơi Này Có Anh", 260_000, true},
		{"Lofi Chill Mix 2024 - nhạc lofi nhẹ nhàng", 3_600_000, false},
		{"Đừng Như Thói Quen (Lofi Ver.)", 240_000, false},
		{"Liên Khúc Bolero Hay Nhất", 1_800_000, false},
		{"Nhạc Không Lời Piano", 200_000, false},
		{"Beat It", 258_000, true}, // not a beat
		{"Remix Hay", 200_000, true},
		{"Some Song", 600_000, false}, // 10 minutes after a 4-minute song
		{"Rap God", 364_000, true},    // 6 minutes: still fine
	} {
		if got := kindCompatible(song, kindOf(c.title, c.durMs)); got != c.ok {
			t.Errorf("after a song, %q (%d s): %v, want %v", c.title, c.durMs/1000, got, c.ok)
		}
	}
	// Listening to lofi, lofi is fine.
	if !kindCompatible(kindOf("lofi hip hop radio", 3_600_000), kindOf("Lofi Chill Mix", 3_600_000)) {
		t.Error("lofi after lofi refused")
	}
}

func TestStyles(t *testing.T) {
	bolero := styleOf([]string{"bolero", "vietnamese"})
	bolero2 := styleOf([]string{"nhạc vàng", "trữ tình"})
	vpop := styleOf([]string{"v-pop", "pop"})
	edm := styleOf([]string{"electronic", "dance"})
	if styleSim(bolero, bolero2) < 0.9 {
		t.Errorf("bolero ~ nhạc vàng: %.2f", styleSim(bolero, bolero2))
	}
	if !styleConflict(bolero, vpop) || !styleConflict(bolero, edm) {
		t.Error("bolero should conflict with V-pop and EDM")
	}
	if styleConflict(nil, vpop) || styleFactor(nil, vpop) != 1 {
		t.Error("unknown style should not change anything")
	}
	if f := styleFactor(bolero, edm); f > 0.2 {
		t.Errorf("bolero → EDM factor %.2f", f)
	}
}

// TestRateLimitBackoff: HTTP 429 and Last.fm's {"error": 29} pause the host;
// calls during the pause don't reach the service.
func TestRateLimitBackoff(t *testing.T) {
	var hits atomic.Int32
	mode := atomic.Value{}
	mode.Store("429")
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		switch mode.Load() {
		case "429":
			w.Header().Set("Retry-After", "1")
			w.WriteHeader(http.StatusTooManyRequests)
		default:
			json.NewEncoder(w).Encode(map[string]any{"ok": true})
		}
	}))
	defer srv.Close()
	s := &Server{log: testLogger()}
	e := &extClient{s: s, hc: srv.Client()}
	s.ext = e
	host := strings.TrimPrefix(srv.URL, "https://")

	var out map[string]any
	if err := e.getJSON(context.Background(), srv.URL+"/a", &out); !errors.Is(err, errRateLimited) {
		t.Fatalf("429 → %v", err)
	}
	if limited, until := e.RateLimited(host); !limited || time.Until(until) > 2*time.Second {
		t.Fatalf("not paused after 429 (Retry-After 1): %v %v", limited, until)
	}
	mode.Store("ok")
	if err := e.getJSON(context.Background(), srv.URL+"/b", &out); !errors.Is(err, errRateLimited) || hits.Load() != 1 {
		t.Fatalf("call during the pause reached the service: %v, hits %d", err, hits.Load())
	}
	time.Sleep(1100 * time.Millisecond)
	if err := e.getJSON(context.Background(), srv.URL+"/c", &out); err != nil || out["ok"] != true {
		t.Fatalf("after the pause: %v %v", err, out)
	}
	// Doubling: without Retry-After the next pause is 30 s.
	e.backoff(host, 0)
	if _, until := e.RateLimited(host); time.Until(until) < 25*time.Second {
		t.Errorf("default pause too short: %v", time.Until(until))
	}
}

// TestRadioKindAndStyle: a radio from a bolero song skips lofi mixes and V-pop.
func TestRadioKindAndStyle(t *testing.T) {
	s, ts := newTestServer(t)
	admin, uid := loginAdmin(t, ts.URL)
	add := func(n int, title, artist, genres string, durMs int64) {
		seedTrack(t, s, uid, hexID(n), title, artist, "vi")
		s.db.Exec(`UPDATE tracks SET genres = ?, genres_done = 1, duration_ms = ? WHERE id = ?`, genres, durMs, hexID(n))
	}
	add(0, "Đắp Mộ Cuộc Tình", "Quang Lê", "bolero,trữ tình", 300_000)
	for i := 1; i <= 8; i++ {
		add(i, "Bài Bolero", "Quang Lê", "bolero", 280_000)
	}
	for i := 20; i <= 27; i++ {
		add(i, "Nhạc Trẻ Sôi Động", "Quang Lê", "v-pop,dance", 200_000)
	}
	add(40, "Lofi Bolero Chill Mix", "Quang Lê", "bolero", 3_000_000)
	req, _ := http.NewRequest("GET", ts.URL+"/api/radio?autoplay=1&seed="+hexID(0), nil)
	res, err := admin.hc.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var body struct {
		Tracks   []Track
		Discover int
	}
	json.NewDecoder(res.Body).Decode(&body)
	res.Body.Close()
	bolero := 0
	for _, tr := range body.Tracks[1:] {
		if tr.ID == hexID(40) {
			t.Error("a 50-minute lofi mix followed a bolero song")
		}
		if tr.Title == "Bài Bolero" {
			bolero++
		}
	}
	// V-pop of the same artist may come after the bolero songs, never before.
	for i, tr := range body.Tracks[1:] {
		if tr.Title == "Nhạc Trẻ Sôi Động" && i < bolero {
			t.Errorf("V-pop at %d before the bolero songs (%d)", i, bolero)
			break
		}
	}
	if bolero < 8 {
		t.Errorf("bolero songs in the radio: %d", bolero)
	}
	if body.Discover < 1 {
		t.Errorf("a small library should look for new songs: discover = %d", body.Discover)
	}
}

func testLogger() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }
