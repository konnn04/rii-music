package discordrpc

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestPresenceHandler(t *testing.T) {
	p := NewPresence(slog.New(slog.NewTextHandler(io.Discard, nil)))
	h := p.Handler()
	do := func(method, body string, header bool) int {
		req := httptest.NewRequest(method, "/__rii/discord", strings.NewReader(body))
		if header {
			req.Header.Set("X-RiiMusic", "1")
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec.Code
	}
	if c := do("POST", `{"title":"x"}`, false); c != http.StatusForbidden {
		t.Errorf("without X-RiiMusic: %d", c)
	}
	if c := do("POST", `not json`, true); c != http.StatusBadRequest {
		t.Errorf("bad json: %d", c)
	}
	if c := do("GET", ``, true); c != http.StatusMethodNotAllowed {
		t.Errorf("GET: %d", c)
	}
	// No Application ID: accepted, but no connection is attempted.
	if c := do("POST", `{"playing":true,"title":"Lạc Trôi","artist":"Sơn Tùng M-TP"}`, true); c != http.StatusNoContent {
		t.Errorf("post: %d", c)
	}
	time.Sleep(50 * time.Millisecond)
	p.mu.Lock()
	connected := p.dc != nil
	p.mu.Unlock()
	if connected {
		t.Error("connected to Discord without an Application ID")
	}
	if c := do("DELETE", ``, true); c != http.StatusNoContent {
		t.Errorf("delete: %d", c)
	}
}
