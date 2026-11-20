package server

import (
	"context"
	"crypto/hmac"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Share links: /s/<trackId>-<signature>. Anyone with the link sees the song
// and hears a 30-second preview; signed-in users can add it to their library
// (instant: the file is already on the server). The signature keeps track ids
// from being guessed into links.

const previewSec = 30

func (s *Server) shareSig(trackID string) string { return s.auth.mac("share", trackID)[:20] }

func (s *Server) shareToken(trackID string) string { return trackID + "-" + s.shareSig(trackID) }

// shareTrack checks a token and returns the shared track.
func (s *Server) shareTrack(tok string) (*Track, error) {
	id, sig, ok := strings.Cut(tok, "-")
	if !ok || !isHexID(id) || !hmac.Equal([]byte(sig), []byte(s.shareSig(id))) {
		return nil, errNotFound
	}
	return s.sharedTrack(id)
}

func (s *Server) baseURL(r *http.Request) string {
	if s.cfg.PublicURL != "" {
		return s.cfg.PublicURL
	}
	scheme := "http"
	if isHTTPS(r) {
		scheme = "https"
	}
	return scheme + "://" + r.Host
}

// handleShareLink: GET /api/tracks/{id}/share (signed in, track in library).
func (s *Server) handleShareLink(w http.ResponseWriter, r *http.Request) {
	t, err := s.getTrack(userOf(r).ID, r.PathValue("id"))
	if err != nil {
		httpError(w, http.StatusNotFound, "Không có bài này")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"url": s.baseURL(r) + "/s/" + s.shareToken(t.ID), "title": t.Title, "artist": t.Artist})
}

// handleShareInfo: public. Tells the page what it may do: full (in the
// visitor's library), add (signed in), or preview (anonymous).
func (s *Server) handleShareInfo(w http.ResponseWriter, r *http.Request) {
	t, err := s.shareTrack(r.PathValue("tok"))
	if err != nil {
		httpError(w, http.StatusNotFound, "Link chia sẻ không hợp lệ hoặc bài đã bị xoá")
		return
	}
	access := "preview"
	if u := s.sessionUser(r); u != nil {
		access = "add"
		if _, err := s.getTrack(u.ID, t.ID); err == nil {
			access = "full"
		}
	}
	b := s.branding()
	writeJSON(w, http.StatusOK, map[string]any{
		"track":  map[string]any{"id": t.ID, "title": t.Title, "artist": t.Artist, "album": t.Album, "durationMs": t.DurationMs, "hasCover": t.HasCover},
		"access": access, "previewSec": previewSec, "site": b.Name,
	})
}

func (s *Server) handleShareCover(w http.ResponseWriter, r *http.Request) {
	t, err := s.shareTrack(r.PathValue("tok"))
	if err != nil || !t.HasCover {
		http.NotFound(w, r)
		return
	}
	f, err := os.Open(filepath.Join(s.cfg.CoverDir(), t.ID+".jpg"))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	st, _ := f.Stat()
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	http.ServeContent(w, r, "", st.ModTime(), f)
}

var previewMu sync.Map // track id → *sync.Mutex

func (s *Server) previewDir() string { return filepath.Join(s.cfg.DataDir, "previews") }

// previewFile cuts (once) a 30-second excerpt from around a quarter into the
// song, where the chorus often starts. Stream copy: no re-encoding.
func (s *Server) previewFile(ctx context.Context, t *Track) (string, string, error) {
	var file, mime string
	if err := s.db.QueryRow(`SELECT file_path, mime FROM tracks WHERE id = ?`, t.ID).Scan(&file, &mime); err != nil {
		return "", "", err
	}
	ext := filepath.Ext(file)
	out := filepath.Join(s.previewDir(), t.ID+ext)
	if _, err := os.Stat(out); err == nil {
		return out, mime, nil
	}
	m, _ := previewMu.LoadOrStore(t.ID, &sync.Mutex{})
	mu := m.(*sync.Mutex)
	mu.Lock()
	defer mu.Unlock()
	if _, err := os.Stat(out); err == nil {
		return out, mime, nil
	}
	if err := os.MkdirAll(s.previewDir(), 0o755); err != nil {
		return "", "", err
	}
	dur := float64(t.DurationMs) / 1000
	start := 0.0
	if dur > previewSec*2 {
		start = min(dur*0.25, dur-previewSec)
	}
	tmp := out + ".tmp" + ext
	args := []string{"-y", "-ss", ftoa(start), "-t", ftoa(previewSec), "-i", filepath.Join(s.cfg.DataDir, filepath.FromSlash(file)),
		"-map", "0:a:0", "-c", "copy", "-map_metadata", "-1"}
	if ext == ".m4a" {
		args = append(args, "-movflags", "+faststart")
	}
	args = append(args, tmp)
	cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if err := runFFmpeg(cctx, s.cfg.FFmpeg, args...); err != nil {
		os.Remove(tmp)
		return "", "", err
	}
	if err := os.Rename(tmp, out); err != nil {
		return "", "", err
	}
	return out, mime, nil
}

func ftoa(f float64) string { return strings.TrimRight(strings.TrimRight(strconvF(f), "0"), ".") }

// handleSharePreview: public, the 30-second excerpt only.
func (s *Server) handleSharePreview(w http.ResponseWriter, r *http.Request) {
	t, err := s.shareTrack(r.PathValue("tok"))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	p, mime, err := s.previewFile(r.Context(), t)
	if err != nil {
		s.log.Warn("share preview", "track", t.ID, "err", err)
		httpError(w, http.StatusServiceUnavailable, "Không tạo được đoạn nghe thử")
		return
	}
	f, err := os.Open(p)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	st, _ := f.Stat()
	w.Header().Set("Content-Type", mime)
	w.Header().Set("Cache-Control", "public, max-age=3600")
	http.ServeContent(w, r, "", st.ModTime(), f)
}

// handleShareAdd: signed in, add the shared song to my library.
func (s *Server) handleShareAdd(w http.ResponseWriter, r *http.Request) {
	u := userOf(r)
	t, err := s.shareTrack(r.PathValue("tok"))
	if err != nil {
		httpError(w, http.StatusNotFound, "Link chia sẻ không hợp lệ hoặc bài đã bị xoá")
		return
	}
	if _, err := s.getTrack(u.ID, t.ID); errors.Is(err, errNotFound) {
		if used, _ := s.userUsage(u.ID); used >= int64(u.StorageLimitMB)<<20 && !s.loadSettings(u.ID).AutoDownload {
			httpError(w, http.StatusInsufficientStorage, "Thư viện đã đầy giới hạn dung lượng")
			return
		}
		if _, err := s.db.Exec(`INSERT INTO user_tracks(user_id, track_id, origin, added_at) VALUES (?,?,'user',?) ON CONFLICT DO NOTHING`, u.ID, t.ID, nowMs()); err != nil {
			s.internalError(w, r, err)
			return
		}
		s.afterAdd(u.ID, t.ID)
	}
	tr, err := s.getTrack(u.ID, t.ID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, tr)
}

// publicCoverURL: a cover Discord can fetch (needs a public https address).
func (s *Server) publicCoverURL(trackID string) string {
	if !strings.HasPrefix(s.cfg.PublicURL, "https://") {
		return ""
	}
	return s.cfg.PublicURL + "/api/share/" + s.shareToken(trackID) + "/cover"
}
