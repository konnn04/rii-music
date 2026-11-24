package server

import (
	"bytes"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestKaraokeModelDownloadOnceAndRange(t *testing.T) {
	fakeModel := make([]byte, 16*1024)
	for i := range fakeModel {
		fakeModel[i] = byte(i*31 + 7)
	}

	var hits atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		time.Sleep(40 * time.Millisecond)
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Write(fakeModel)
	}))
	defer upstream.Close()

	prevBase := karaokeModelBase
	karaokeModelBase = upstream.URL + "/"
	t.Cleanup(func() { karaokeModelBase = prevBase })
	t.Setenv("KARAOKE_MODEL_URL", "")

	s := &Server{
		cfg: Config{DataDir: t.TempDir()},
		log: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}

	// Concurrent requests should trigger only a single upstream download.
	const workers = 5
	var wg sync.WaitGroup
	errs := make(chan string, workers)
	for range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			req := httptest.NewRequest(http.MethodGet, "/api/karaoke/model", nil)
			rec := httptest.NewRecorder()
			s.handleKaraokeModel(rec, req)
			if rec.Code != http.StatusOK {
				errs <- "unexpected status: " + rec.Result().Status
				return
			}
			if !bytes.Equal(rec.Body.Bytes(), fakeModel) {
				errs <- "body mismatch"
			}
		}()
	}
	wg.Wait()
	close(errs)
	for e := range errs {
		t.Fatal(e)
	}

	if got := hits.Load(); got != 1 {
		t.Fatalf("expected 1 upstream download, got %d", got)
	}

	// Subsequent request should serve from disk with expected headers.
	req := httptest.NewRequest(http.MethodGet, "/api/karaoke/model", nil)
	rec := httptest.NewRecorder()
	s.handleKaraokeModel(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("cached status = %d, want 200", rec.Code)
	}
	if got := rec.Header().Get("Content-Type"); got != "application/octet-stream" {
		t.Errorf("Content-Type = %q, want application/octet-stream", got)
	}
	if got := rec.Header().Get("Cache-Control"); got != "private, max-age=31536000, immutable" {
		t.Errorf("Cache-Control = %q", got)
	}
	if got := hits.Load(); got != 1 {
		t.Fatalf("expected still 1 upstream download, got %d", got)
	}

	// Range request should return 206 Partial Content with exact slice.
	rReq := httptest.NewRequest(http.MethodGet, "/api/karaoke/model", nil)
	rReq.Header.Set("Range", "bytes=100-299")
	rRec := httptest.NewRecorder()
	s.handleKaraokeModel(rRec, rReq)
	if rRec.Code != http.StatusPartialContent {
		t.Fatalf("range status = %d, want 206", rRec.Code)
	}
	if cr := rRec.Header().Get("Content-Range"); !strings.HasPrefix(cr, "bytes 100-299/") {
		t.Errorf("Content-Range = %q, want prefix bytes 100-299/", cr)
	}
	if !bytes.Equal(rRec.Body.Bytes(), fakeModel[100:300]) {
		t.Fatalf("range body mismatch: got %d bytes", rRec.Body.Len())
	}
}

func TestKaraokeModelRetryAfterFailure(t *testing.T) {
	fakeModel := []byte("fake-onnx-model-bytes")
	var attempts atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if attempts.Add(1) == 1 {
			http.Error(w, "temporary error", http.StatusBadGateway)
			return
		}
		w.Write(fakeModel)
	}))
	defer upstream.Close()

	prevBase := karaokeModelBase
	karaokeModelBase = upstream.URL
	t.Cleanup(func() { karaokeModelBase = prevBase })
	t.Setenv("KARAOKE_MODEL_URL", "")

	s := &Server{
		cfg: Config{DataDir: t.TempDir()},
		log: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}

	// First attempt fails.
	rec1 := httptest.NewRecorder()
	s.handleKaraokeModel(rec1, httptest.NewRequest(http.MethodGet, "/api/karaoke/model", nil))
	if rec1.Code != http.StatusInternalServerError {
		t.Fatalf("first attempt status = %d, want 500", rec1.Code)
	}

	// Second attempt retries and succeeds.
	rec2 := httptest.NewRecorder()
	s.handleKaraokeModel(rec2, httptest.NewRequest(http.MethodGet, "/api/karaoke/model", nil))
	if rec2.Code != http.StatusOK {
		t.Fatalf("retry status = %d, want 200", rec2.Code)
	}
	if !bytes.Equal(rec2.Body.Bytes(), fakeModel) {
		t.Fatalf("retry body mismatch: got %q", rec2.Body.String())
	}
	if got := attempts.Load(); got != 2 {
		t.Fatalf("attempts = %d, want 2", got)
	}
}

func TestKaraokeModelChoice(t *testing.T) {
	var paths []string
	var mu sync.Mutex
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		paths = append(paths, r.URL.Path)
		mu.Unlock()
		w.Write([]byte("model:" + r.URL.Path))
	}))
	defer upstream.Close()
	prevBase := karaokeModelBase
	karaokeModelBase = upstream.URL
	t.Cleanup(func() { karaokeModelBase = prevBase })

	s := &Server{cfg: Config{DataDir: t.TempDir()}}
	rec := httptest.NewRecorder()
	s.handleKaraokeModel(rec, httptest.NewRequest(http.MethodGet, "/api/karaoke/model?m=kara2", nil))
	if rec.Code != http.StatusOK || rec.Body.String() != "model:/UVR_MDXNET_KARA_2.onnx" {
		t.Fatalf("kara2: %d %q", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	s.handleKaraokeModel(rec, httptest.NewRequest(http.MethodGet, "/api/karaoke/model?m=../../etc", nil))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("bad id: %d", rec.Code)
	}
	if len(paths) != 1 {
		t.Fatalf("upstream hits: %v", paths)
	}
}
