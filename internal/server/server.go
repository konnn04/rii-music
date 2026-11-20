package server

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"path"
	"strings"
	"time"

	"rii_music/internal/db"
	"rii_music/internal/ytdlp"
)

type Server struct {
	cfg   Config
	db    *db.DB
	yt    *ytdlp.Client
	log   *slog.Logger
	web   fs.FS
	auth  *Auth
	hub   *Hub
	dl    *Downloader
	lrc   *LRCLib
	login *RateLimiter
	otpRL *RateLimiter
	jobRL *RateLimiter

	ext      *extClient
	features *featureIndex
	co       coIndex
	np       nowPlayingState
	playback playbackState
	autodl   *autoDL
	logs     *LogBuffer
}

func New(cfg Config, database *db.DB, yt *ytdlp.Client, web fs.FS, log *slog.Logger) (*Server, error) {
	auth, err := NewAuth(cfg)
	if err != nil {
		return nil, err
	}
	s := &Server{
		cfg: cfg, db: database, yt: yt, log: log, web: web, auth: auth,
		hub:   NewHub(),
		lrc:   NewLRCLib(),
		login: NewRateLimiter(10, time.Minute),
		otpRL: NewRateLimiter(5, 10*time.Minute),
		jobRL: NewRateLimiter(30, time.Minute),
	}
	s.dl = NewDownloader(s)
	s.ext = newExtClient(s)
	s.features = newFeatureIndex()
	s.autodl = newAutoDL()
	return s, nil
}

// Start launches background workers; they stop when ctx is cancelled.
func (s *Server) Start(ctx context.Context) {
	s.dl.Start(ctx)
	go s.backfillLangs()
	go s.runFeatureWorker(ctx)
	go s.runAutoDownloader(ctx)
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	api := func(pattern string, h http.HandlerFunc) { mux.Handle(pattern, s.requireAuth(h)) }

	mux.HandleFunc("GET /api/health", s.handleHealth)

	// accounts
	mux.HandleFunc("POST /api/auth/login", s.handleLogin)
	mux.HandleFunc("POST /api/auth/otp", s.handleRequestOTP)
	mux.HandleFunc("POST /api/auth/otp/verify", s.handleVerifyOTP)
	mux.HandleFunc("POST /api/auth/reset", s.handleResetPassword)
	mux.HandleFunc("POST /api/auth/logout", s.handleLogout)
	api("GET /api/me", s.handleMe)
	api("PATCH /api/me", s.handlePatchMe)
	api("POST /api/me/password", s.handleChangePassword)

	api("GET /api/tracks", s.handleListTracks)
	api("GET /api/tracks/{id}", s.handleGetTrack)
	api("PATCH /api/tracks/{id}", s.handlePatchTrack)
	api("DELETE /api/tracks/{id}", s.handleDeleteTrack)
	api("GET /api/tracks/{id}/stream", s.handleStream)
	api("GET /api/tracks/{id}/cover", s.handleCover)
	api("GET /api/tracks/{id}/lyrics", s.handleGetLyrics)
	api("PUT /api/tracks/{id}/lyrics", s.handlePutLyrics)
	api("POST /api/tracks/{id}/lyrics/search", s.handleSearchLyrics)
	api("GET /api/tracks/{id}/lyrics/candidates", s.handleLyricsCandidates)
	api("GET /api/artists", s.handleListArtists)
	api("GET /api/artist", s.handleGetArtist)
	api("GET /api/albums", s.handleListAlbums)
	api("GET /api/album", s.handleGetAlbum)
	api("GET /api/search", s.handleSearch)
	api("GET /api/web/list", s.handleWebList)
	api("POST /api/web/list/save", s.handleSaveWebList)
	api("GET /api/album/full", s.handleFullAlbum)

	api("PUT /api/likes/{id}", s.handleLike)
	api("DELETE /api/likes/{id}", s.handleUnlike)

	api("GET /api/playlists", s.handleListPlaylists)
	api("POST /api/playlists", s.handleCreatePlaylist)
	api("GET /api/playlists/{id}", s.handleGetPlaylist)
	api("PATCH /api/playlists/{id}", s.handlePatchPlaylist)
	api("DELETE /api/playlists/{id}", s.handleDeletePlaylist)
	api("POST /api/playlists/{id}/items", s.handleAddPlaylistItems)
	api("PUT /api/playlists/{id}/items", s.handleReorderPlaylist)
	api("DELETE /api/playlists/{id}/items/{trackId}", s.handleRemovePlaylistItem)
	api("GET /api/playlists/{id}/export", s.handleExportPlaylist)

	api("GET /api/downloads", s.handleListJobs)
	api("POST /api/downloads", s.handleCreateJobs)
	api("POST /api/downloads/{id}/retry", s.handleRetryJob)
	api("DELETE /api/downloads/{id}", s.handleDeleteJob)
	api("DELETE /api/downloads", s.handleClearJobs)
	api("GET /api/events", s.handleSSE)

	api("POST /api/events/listen", s.handleListen)
	api("GET /api/history", s.handleHistory)
	api("GET /api/stats", s.handleStats)
	api("GET /api/home", s.handleHome)
	api("GET /api/radio", s.handleRadio)
	api("GET /api/recs/autoplay", s.handleAutoplay)
	api("GET /api/autodl", s.handleAutoDLStatus)
	api("POST /api/autodl/run", s.handleAutoDLRun)

	api("GET /api/recs/foryou", s.handleForYou)
	api("GET /api/recs/discover", s.handleDiscover)
	api("GET /api/artist/similar", s.handleArtistSimilar)
	api("GET /api/artist/web", s.handleArtistWeb)
	api("GET /api/tracks/{id}/similar", s.handleTrackSimilar)
	api("POST /api/feedback", s.handleFeedback)
	api("GET /api/onboarding/artists", s.handleOnboardingArtists)
	api("POST /api/recs/mood", s.handleMood)

	// personal tokens, Discord presence
	api("GET /api/tokens", s.handleListTokens)
	api("POST /api/tokens", s.handleCreateToken)
	api("DELETE /api/tokens/{id}", s.handleDeleteToken)
	api("POST /api/nowplaying", s.handlePostNowPlaying)
	api("POST /api/playback", s.handlePostPlayback)
	api("GET /api/playback", s.handleGetPlayback)
	api("GET /api/discord", s.handleDiscordInfo)
	mux.HandleFunc("GET /api/agent/nowplaying", s.handleAgentNowPlaying) // agent token

	// share links (public preview) and branding
	api("GET /api/tracks/{id}/share", s.handleShareLink)
	mux.HandleFunc("GET /api/share/{tok}", s.handleShareInfo)
	mux.HandleFunc("GET /api/share/{tok}/cover", s.handleShareCover)
	mux.HandleFunc("GET /api/share/{tok}/preview", s.handleSharePreview)
	api("POST /api/share/{tok}/add", s.handleShareAdd)
	mux.HandleFunc("GET /api/branding", s.handleGetBranding)
	mux.HandleFunc("GET /branding/logo", s.handleLogo)
	mux.HandleFunc("GET /robots.txt", s.handleRobots)
	mux.HandleFunc("GET /download/agent/{file}", s.handleAgentFile)
	mux.HandleFunc("GET /agent.ps1", s.serveAgentScript(agentPS1))
	mux.HandleFunc("GET /agent.sh", s.serveAgentScript(agentSH))
	mux.HandleFunc("GET /api/openapi.json", s.handleOpenAPI)
	mux.HandleFunc("GET /api/docs/client.ts", s.handleClientLib)

	api("POST /api/reset", s.handleReset)
	api("GET /api/settings", s.handleGetSettings)
	api("PUT /api/settings", s.handlePutSettings)

	// admin
	admin := func(pattern string, h http.HandlerFunc) { mux.Handle(pattern, s.requireAdmin(h)) }
	admin("GET /api/admin/users", s.handleAdminListUsers)
	admin("POST /api/admin/users", s.handleAdminCreateUser)
	admin("PATCH /api/admin/users/{id}", s.handleAdminPatchUser)
	admin("DELETE /api/admin/users/{id}", s.handleAdminDeleteUser)
	admin("GET /api/admin/users/{id}/stats", s.handleAdminUserStats)
	admin("GET /api/admin/users/{id}/history", s.handleAdminUserHistory)
	admin("GET /api/admin/users/{id}/tracks", s.handleAdminUserTracks)
	admin("DELETE /api/admin/users/{id}/tracks/{trackId}", s.handleAdminRemoveUserTrack)
	admin("POST /api/admin/users/{id}/reset", s.handleAdminResetUser)
	admin("GET /api/admin/system", s.handleAdminSystem)
	admin("GET /api/admin/logs", s.handleAdminLogs)
	admin("POST /api/admin/system/ytdlp-update", s.handleAdminUpdateYtdlp)
	admin("POST /api/admin/system/cleanup", s.handleAdminCleanup)
	admin("POST /api/admin/system/clear-cache", s.handleAdminClearCache)
	admin("POST /api/admin/system/test-mail", s.handleAdminTestMail)
	admin("GET /api/admin/jobs", s.handleAdminJobs)
	admin("GET /api/admin/settings", s.handleGetServerSettings)
	admin("PUT /api/admin/settings", s.handlePutServerSettings)
	admin("PUT /api/admin/branding", s.handlePutBranding)
	admin("POST /api/admin/branding/logo", s.handleUploadLogo)
	admin("DELETE /api/admin/branding/logo", s.handleDeleteLogo)

	mux.Handle("/api/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		httpError(w, http.StatusNotFound, "Không tìm thấy endpoint")
	}))
	mux.Handle("/", s.staticHandler())

	return s.logRequests(s.securityHeaders(mux))
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	if err := s.db.PingContext(r.Context()); err != nil {
		httpError(w, http.StatusServiceUnavailable, "database unavailable")
		return
	}
	ready, err := s.yt.Status()
	msg := ""
	if err != nil {
		msg = err.Error()
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "version": Version, "ytdlp": ready, "ytdlpError": msg})
}

// ── middleware ──────────────────────────────────────────────────────────

type statusWriter struct {
	http.ResponseWriter
	code int
}

func (w *statusWriter) WriteHeader(c int) { w.code = c; w.ResponseWriter.WriteHeader(c) }
func (w *statusWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}
func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (s *Server) logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/api/") {
			next.ServeHTTP(w, r)
			return
		}
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w, code: 200}
		next.ServeHTTP(sw, r)
		if strings.HasSuffix(r.URL.Path, "/stream") || strings.HasSuffix(r.URL.Path, "/cover") {
			if sw.code < 400 {
				return
			}
		}
		lvl := slog.LevelDebug
		if sw.code >= 500 {
			lvl = slog.LevelError
		} else if sw.code >= 400 {
			lvl = slog.LevelWarn
		}
		s.log.Log(r.Context(), lvl, "http", "method", r.Method, "path", r.URL.Path, "status", sw.code, "dur_ms", time.Since(start).Milliseconds())
	})
}

func (s *Server) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "same-origin")
		h.Set("X-Frame-Options", "DENY")
		if s.cfg.DevCORS != "" {
			h.Set("Access-Control-Allow-Origin", s.cfg.DevCORS)
			h.Set("Access-Control-Allow-Credentials", "true")
			h.Set("Access-Control-Allow-Headers", "Content-Type, X-RiiMusic")
			h.Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE")
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// ── static SPA ──────────────────────────────────────────────────────────

func (s *Server) staticHandler() http.Handler {
	files := http.FileServerFS(s.web)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if p == "" {
			p = "index.html"
		}
		if st, err := fs.Stat(s.web, p); err != nil || st.IsDir() {
			// SPA route: serve the shell.
			if strings.Contains(path.Base(p), ".") && p != "index.html" {
				http.NotFound(w, r)
				return
			}
			s.serveIndex(w, r)
			return
		}
		switch {
		case strings.HasPrefix(p, "assets/"):
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		case p == "manifest.webmanifest":
			if s.serveManifest(w, r) {
				return
			}
		case p == "index.html" || p == "sw.js" || strings.HasPrefix(p, "workbox-"):
			w.Header().Set("Cache-Control", "no-cache")
		default:
			w.Header().Set("Cache-Control", "public, max-age=86400")
		}
		if p == "index.html" {
			s.serveIndex(w, r)
			return
		}
		files.ServeHTTP(w, r)
	})
}

func (s *Server) serveIndex(w http.ResponseWriter, r *http.Request) {
	b, err := fs.ReadFile(s.web, "index.html")
	if err != nil {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusServiceUnavailable)
		io.WriteString(w, "Giao diện chưa được build. Chạy: cd web && pnpm build, rồi build lại server.\n")
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Write(s.brandIndex(b, r.URL.Path))
}

// ── helpers ─────────────────────────────────────────────────────────────

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func httpError(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

func (s *Server) internalError(w http.ResponseWriter, r *http.Request, err error) {
	s.log.Error("internal error", "path", r.URL.Path, "err", err)
	httpError(w, http.StatusInternalServerError, "Lỗi máy chủ")
}

func readJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		httpError(w, http.StatusBadRequest, "Dữ liệu gửi lên không hợp lệ")
		return false
	}
	return true
}

func newID() string {
	b := make([]byte, 12)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func nowMs() int64 { return time.Now().UnixMilli() }

var errNotFound = errors.New("not found")
