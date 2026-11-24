package server

import (
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"rii_music/internal/textutil"
)

// Admin → "Đồng bộ lại": tag every song again (genres from Deezer / Last.fm,
// through the enrichment worker's queue) and recompute languages (titles and
// stored lyrics, locally). Progress comes from GET /api/admin/enrich.

var (
	langResync     atomic.Bool
	langResyncDone atomic.Int64
	langResyncAll  atomic.Int64
	resumeOnce     sync.Mutex
	resumeTimer    *time.Timer
)

// enrichResumeAfterLimit wakes the worker once the external APIs' pause ends.
func (s *Server) enrichResumeAfterLimit() {
	until := time.Now()
	for _, h := range []string{"ws.audioscrobbler.com", "api.deezer.com"} {
		if limited, u := s.ext.RateLimited(h); limited && u.After(until) {
			until = u
		}
	}
	resumeOnce.Lock()
	defer resumeOnce.Unlock()
	if resumeTimer != nil {
		resumeTimer.Stop()
	}
	resumeTimer = time.AfterFunc(time.Until(until)+time.Second, s.enrichKick)
}

type enrichStatus struct {
	Tracks        int    `json:"tracks"`
	GenresDone    int    `json:"genresDone"`    // looked up (with or without tags)
	GenresTagged  int    `json:"genresTagged"`  // have at least one genre
	GenresPending int    `json:"genresPending"` // still to look up
	GenresFailed  int    `json:"genresFailed"`  // service error, retried hourly
	LyricsInFile  int    `json:"lyricsInFile"`
	LangRunning   bool   `json:"langRunning"`
	LangDone      int64  `json:"langDone"`
	LangTotal     int64  `json:"langTotal"`
	Provider      string `json:"provider"` // "lastfm" with a key, else "deezer"
	LastfmPaused  int64  `json:"lastfmPausedUntil,omitempty"`
	DeezerPaused  int64  `json:"deezerPausedUntil,omitempty"`
}

func (s *Server) enrichStatus() enrichStatus {
	st := enrichStatus{Provider: "deezer", LangRunning: langResync.Load(), LangDone: langResyncDone.Load(), LangTotal: langResyncAll.Load()}
	if s.cfg.LastfmKey != "" {
		st.Provider = "lastfm"
	}
	s.db.QueryRow(`SELECT COUNT(*),
		COUNT(*) FILTER (WHERE genres_done = 1),
		COUNT(*) FILTER (WHERE genres_done = 1 AND genres <> ''),
		COUNT(*) FILTER (WHERE genres_done = 0),
		COUNT(*) FILTER (WHERE genres_done = -1),
		COUNT(*) FILTER (WHERE lyrics_embedded = 1)
		FROM tracks`).Scan(&st.Tracks, &st.GenresDone, &st.GenresTagged, &st.GenresPending, &st.GenresFailed, &st.LyricsInFile)
	if ok, u := s.ext.RateLimited("ws.audioscrobbler.com"); ok {
		st.LastfmPaused = u.UnixMilli()
	}
	if ok, u := s.ext.RateLimited("api.deezer.com"); ok {
		st.DeezerPaused = u.UnixMilli()
	}
	return st
}

// GET /api/admin/enrich
func (s *Server) handleEnrichStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.enrichStatus())
}

// POST /api/admin/enrich/resync: every song back into the tagging queue, and
// languages recomputed in the background.
func (s *Server) handleEnrichResync(w http.ResponseWriter, r *http.Request) {
	if _, err := s.db.Exec(`UPDATE tracks SET genres_done = 0`); err != nil {
		s.internalError(w, r, err)
		return
	}
	// Forget cached lookups so the new rules (artist tags) apply.
	s.db.Exec(`DELETE FROM ext_cache WHERE key LIKE 'genres%'`)
	s.enrichKick()
	if langResync.CompareAndSwap(false, true) {
		go s.resyncLanguages()
	}
	s.log.Info("admin: tags and languages resync started", "by", userOf(r).Email)
	writeJSON(w, http.StatusOK, s.enrichStatus())
}

// resyncLanguages recomputes every song's language from its title and artist,
// then lets the stored lyrics settle it (refineLang), like a fresh download.
func (s *Server) resyncLanguages() {
	defer langResync.Store(false)
	rows, err := s.db.Query(`SELECT t.id, t.title, t.artist, COALESCE(l.plain, ''), COALESCE(l.synced, '')
		FROM tracks t LEFT JOIN lyrics l ON l.track_id = t.id`)
	if err != nil {
		return
	}
	type row struct{ id, title, artist, plain, synced string }
	var list []row
	for rows.Next() {
		var x row
		if rows.Scan(&x.id, &x.title, &x.artist, &x.plain, &x.synced) == nil {
			list = append(list, x)
		}
	}
	rows.Close()
	langResyncAll.Store(int64(len(list)))
	langResyncDone.Store(0)
	for _, x := range list {
		if l := textutil.DetectLang(x.title, x.artist); l != "" {
			s.db.Exec(`UPDATE tracks SET lang = ? WHERE id = ?`, l, x.id)
		}
		text := x.plain
		if text == "" {
			text = x.synced
		}
		if text != "" {
			s.refineLang(x.id, text)
		}
		langResyncDone.Add(1)
	}
	s.log.Info("admin: languages recomputed", "tracks", len(list))
}
