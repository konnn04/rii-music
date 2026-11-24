package server

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const maxKaraokeModelBytes = 200 << 20 // 200 MB

// karaokeModels maps the ids the web app asks for (?m=) to UVR's file names.
var karaokeModels = map[string]string{
	"kara":  "UVR_MDXNET_KARA.onnx",
	"kara2": "UVR_MDXNET_KARA_2.onnx",
	"hq3":   "UVR-MDX-NET-Inst_HQ_3.onnx",
}

// karaokeModelBase is where the models are downloaded from; tests may override it.
var karaokeModelBase = "https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/"

type karaokeDownload struct {
	done chan struct{}
	err  error
}

var (
	karaokeMu       sync.Mutex
	karaokeInFlight = map[string]*karaokeDownload{}
)

func karaokeModelURL(file string) string {
	base := karaokeModelBase
	if u := strings.TrimSpace(os.Getenv("KARAOKE_MODEL_BASE_URL")); u != "" {
		base = u
	}
	return strings.TrimSuffix(base, "/") + "/" + file
}

// handleKaraokeModel serves an MDX-Net ONNX model (?m=kara|kara2|hq3, default
// hq3 for older clients), downloading it once on demand.
func (s *Server) handleKaraokeModel(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("m")
	if id == "" {
		id = "hq3"
	}
	file, ok := karaokeModels[id]
	if !ok {
		httpError(w, http.StatusBadRequest, "Model karaoke không hợp lệ")
		return
	}
	p := filepath.Join(s.cfg.DataDir, "models", file)
	if err := s.ensureKaraokeModel(r.Context(), p, karaokeModelURL(file)); err != nil {
		if errors.Is(err, context.Canceled) {
			return
		}
		if s.log != nil {
			s.internalError(w, r, err)
		} else {
			httpError(w, http.StatusInternalServerError, "Lỗi máy chủ")
		}
		return
	}

	f, err := os.Open(p)
	if err != nil {
		if s.log != nil {
			s.internalError(w, r, err)
		} else {
			httpError(w, http.StatusInternalServerError, "Lỗi máy chủ")
		}
		return
	}
	defer f.Close()

	st, err := f.Stat()
	if err != nil {
		if s.log != nil {
			s.internalError(w, r, err)
		} else {
			httpError(w, http.StatusInternalServerError, "Lỗi máy chủ")
		}
		return
	}

	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	http.ServeContent(w, r, file, st.ModTime(), f)
}

// ensureKaraokeModel downloads the model once; concurrent callers wait on the
// same download, and a failed download can be retried by subsequent requests.
func (s *Server) ensureKaraokeModel(ctx context.Context, dst, url string) error {
	if st, err := os.Stat(dst); err == nil && st.Mode().IsRegular() && st.Size() > 0 {
		return nil
	}

	karaokeMu.Lock()
	if st, err := os.Stat(dst); err == nil && st.Mode().IsRegular() && st.Size() > 0 {
		karaokeMu.Unlock()
		return nil
	}
	if dl, ok := karaokeInFlight[dst]; ok {
		karaokeMu.Unlock()
		select {
		case <-dl.done:
			return dl.err
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	dl := &karaokeDownload{done: make(chan struct{})}
	karaokeInFlight[dst] = dl
	karaokeMu.Unlock()

	err := s.downloadKaraokeModel(dst, url)
	dl.err = err

	karaokeMu.Lock()
	delete(karaokeInFlight, dst)
	karaokeMu.Unlock()
	close(dl.done)

	return err
}

func (s *Server) downloadKaraokeModel(dst, url string) error {
	dir := filepath.Dir(dst)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("create models dir: %w", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return fmt.Errorf("karaoke model request: %w", err)
	}
	req.Header.Set("User-Agent", "rii-music")

	hc := &http.Client{Timeout: 10 * time.Minute}
	res, err := hc.Do(req)
	if err != nil {
		return fmt.Errorf("download karaoke model: %w", err)
	}
	defer res.Body.Close()

	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("download karaoke model: HTTP %s", res.Status)
	}

	tmp, err := os.CreateTemp(dir, filepath.Base(dst)+".*.tmp")
	if err != nil {
		return fmt.Errorf("create temp model file: %w", err)
	}
	tmpPath := tmp.Name()
	cleanup := true
	defer func() {
		if cleanup {
			os.Remove(tmpPath)
		}
	}()

	n, err := io.Copy(tmp, io.LimitReader(res.Body, maxKaraokeModelBytes+1))
	if err != nil {
		tmp.Close()
		return fmt.Errorf("write karaoke model: %w", err)
	}
	if n == 0 {
		tmp.Close()
		return errors.New("downloaded karaoke model is empty")
	}
	if n > maxKaraokeModelBytes {
		tmp.Close()
		return fmt.Errorf("karaoke model exceeds %d bytes", maxKaraokeModelBytes)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close temp model file: %w", err)
	}
	if err := os.Rename(tmpPath, dst); err != nil {
		return fmt.Errorf("install karaoke model: %w", err)
	}
	cleanup = false

	if s.log != nil {
		s.log.Info("karaoke model downloaded", "path", dst, "bytes", n)
	}
	return nil
}
