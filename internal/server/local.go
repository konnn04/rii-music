package server

import (
	"crypto/subtle"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Desktop app, local mode: one user on this machine, no sign-in. The Tauri
// shell starts the server with RII_LOCAL_TOKEN and opens
// /__rii/auto-login?token=…, which sets the usual session cookie.

func (s *Server) handleAutoLogin(w http.ResponseWriter, r *http.Request) {
	tok := r.URL.Query().Get("token")
	host, _, _ := net.SplitHostPort(r.RemoteAddr)
	if !s.cfg.Local() || s.cfg.LocalToken == "" || subtle.ConstantTimeCompare([]byte(tok), []byte(s.cfg.LocalToken)) != 1 ||
		!(host == "127.0.0.1" || host == "::1") {
		http.NotFound(w, r)
		return
	}
	var id string
	if err := s.db.QueryRow(`SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1`).Scan(&id); err != nil {
		s.internalError(w, r, err)
		return
	}
	u, err := s.userByID(id)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	s.setSession(w, r, u)
	http.Redirect(w, r, "/", http.StatusFound)
}

// POST /__rii/shutdown?token=…: the desktop shell asks for a clean exit (the
// embedded database is stopped properly) before it would kill the process.
func (s *Server) handleShutdown(w http.ResponseWriter, r *http.Request) {
	host, _, _ := net.SplitHostPort(r.RemoteAddr)
	tok := r.URL.Query().Get("token")
	if s.cfg.LocalToken == "" || subtle.ConstantTimeCompare([]byte(tok), []byte(s.cfg.LocalToken)) != 1 || !(host == "127.0.0.1" || host == "::1") {
		http.NotFound(w, r)
		return
	}
	w.WriteHeader(http.StatusAccepted)
	s.log.Info("shutdown requested by the desktop app")
	go func() {
		time.Sleep(200 * time.Millisecond)
		if p, err := os.FindProcess(os.Getpid()); err == nil {
			p.Signal(os.Interrupt) // run()'s signal handler shuts down; Windows: see shutdownHook
		}
		if shutdownHook != nil {
			shutdownHook()
		}
	}()
}

// shutdownHook is set by main: cancels the server context (os.Interrupt can't
// be sent to oneself on Windows).
var shutdownHook func()

// SetShutdownHook lets main stop the server from /__rii/shutdown.
func SetShutdownHook(f func()) { shutdownHook = f }

// LocalMusicDir: the music folder chosen in the app (stored in the database so
// a move survives restarts), else RII_MUSIC_DIR.
func (s *Server) LoadLocalMusicDir() {
	var dir string
	if s.db.QueryRow(`SELECT value_json FROM settings WHERE key = 'local_music_dir'`).Scan(&dir) == nil {
		dir = strings.Trim(dir, `"`)
		if dir != "" {
			s.cfg.MusicPath = dir
		}
	}
	os.MkdirAll(s.cfg.MusicDir(), 0o755)
}

type musicMove struct {
	mu    sync.Mutex
	on    bool
	done  int
	total int
	err   string
	to    string
}

// GET /api/local: mode, folders and the progress of a music folder move.
func (s *Server) handleLocalInfo(w http.ResponseWriter, r *http.Request) {
	m := &s.move
	m.mu.Lock()
	defer m.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{
		"mode": s.cfg.Mode, "musicDir": s.cfg.MusicDir(), "dataDir": s.cfg.DataDir, "encrypted": s.vaultKey != nil,
		"move": map[string]any{"running": m.on, "done": m.done, "total": m.total, "error": m.err, "to": m.to},
	})
}

// POST /api/local/music-dir {path}: move every song to another folder (local mode).
func (s *Server) handleMoveMusicDir(w http.ResponseWriter, r *http.Request) {
	if !s.cfg.Local() {
		http.NotFound(w, r)
		return
	}
	var body struct {
		Path string `json:"path"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	to, err := filepath.Abs(strings.TrimSpace(body.Path))
	if err != nil || body.Path == "" {
		httpError(w, http.StatusBadRequest, "Đường dẫn không hợp lệ")
		return
	}
	from := s.cfg.MusicDir()
	if filepath.Clean(to) == filepath.Clean(from) {
		httpError(w, http.StatusBadRequest, "Đây đã là thư mục nhạc hiện tại")
		return
	}
	if err := os.MkdirAll(to, 0o755); err != nil {
		httpError(w, http.StatusBadRequest, "Không tạo được thư mục: "+err.Error())
		return
	}
	m := &s.move
	m.mu.Lock()
	if m.on {
		m.mu.Unlock()
		httpError(w, http.StatusConflict, "Đang chuyển thư mục nhạc")
		return
	}
	m.on, m.done, m.total, m.err, m.to = true, 0, 0, "", to
	m.mu.Unlock()
	go s.moveMusic(from, to)
	w.WriteHeader(http.StatusAccepted)
}

// moveMusic moves the files one by one (rename on the same drive, else copy
// then delete), then points the app at the new folder.
func (s *Server) moveMusic(from, to string) {
	m := &s.move
	entries, _ := os.ReadDir(from)
	var files []string
	for _, e := range entries {
		if e.Type().IsRegular() {
			files = append(files, e.Name())
		}
	}
	m.mu.Lock()
	m.total = len(files)
	m.mu.Unlock()
	var firstErr error
	for _, f := range files {
		src, dst := filepath.Join(from, f), filepath.Join(to, f)
		if err := os.Rename(src, dst); err != nil {
			if err := copyThenRemove(src, dst); err != nil && firstErr == nil {
				firstErr = err
			}
		}
		m.mu.Lock()
		m.done++
		m.mu.Unlock()
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.on = false
	if firstErr != nil {
		m.err = firstErr.Error()
		s.log.Error("move music folder", "err", firstErr)
	}
	s.cfg.MusicPath = to
	s.db.Exec(`INSERT INTO settings(key, value_json) VALUES ('local_music_dir', ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`, `"`+to+`"`)
	s.log.Info("music folder moved", "to", to, "files", len(files))
}

func copyThenRemove(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst + ".part")
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		os.Remove(dst + ".part")
		return err
	}
	if err := out.Sync(); err != nil {
		out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	if err := os.Rename(dst+".part", dst); err != nil {
		return err
	}
	in.Close()
	if err := os.Remove(src); err != nil {
		return errors.Join(errors.New("đã chép nhưng không xoá được file cũ"), err)
	}
	return nil
}
