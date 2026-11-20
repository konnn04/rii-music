package server

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"mime"
	"net/http"
	"strings"
)

const likedID = "liked"

type Rule struct {
	Type  string `json:"type"` // top30 | recent | unplayed | artist
	Value string `json:"value,omitempty"`
	Limit int    `json:"limit,omitempty"`
}

type Playlist struct {
	ID            string   `json:"id"`
	Name          string   `json:"name"`
	Kind          string   `json:"kind"` // manual | smart | system
	Rule          *Rule    `json:"rule,omitempty"`
	TrackCount    int      `json:"trackCount"`
	DurationMs    int64    `json:"durationMs"`
	CoverTrackIDs []string `json:"coverTrackIds"`
	UpdatedAt     int64    `json:"updatedAt"`
}

func (r *Rule) validate() error {
	switch r.Type {
	case "top30", "recent", "unplayed":
	case "artist":
		if strings.TrimSpace(r.Value) == "" {
			return errors.New("Chọn nghệ sĩ cho playlist thông minh")
		}
	default:
		return errors.New("Luật playlist không hợp lệ")
	}
	if r.Limit <= 0 || r.Limit > 500 {
		r.Limit = 50
	}
	return nil
}

func (s *Server) resolveRule(uid string, r Rule) ([]Track, error) {
	lim := r.Limit
	if lim <= 0 {
		lim = 50
	}
	switch r.Type {
	case "top30":
		since := nowMs() - 30*24*3600*1000
		rows, err := s.db.Query(`SELECT track_id FROM listen_events WHERE user_id = ? AND started_at >= ? AND (action != 'skip' OR played_ms >= 30000)
			GROUP BY track_id ORDER BY COUNT(*) DESC, MAX(started_at) DESC LIMIT ?`, uid, since, lim)
		if err != nil {
			return nil, err
		}
		ids, err := scanStrings(rows)
		if err != nil {
			return nil, err
		}
		return s.tracksByIDs(uid, ids)
	case "recent":
		return s.libTracks(uid, `ORDER BY ut.added_at DESC LIMIT ?`, lim)
	case "unplayed":
		return s.libTracks(uid, `AND ut.play_count = 0 ORDER BY ut.added_at DESC LIMIT ?`, lim)
	case "artist":
		return s.libTracks(uid, `AND t.artist = ? ORDER BY ut.play_count DESC LIMIT ?`, r.Value, lim)
	}
	return []Track{}, nil
}

func scanStrings(rows *sql.Rows) ([]string, error) {
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

type playlistRow struct {
	id, name, kind string
	rule           sql.NullString
	updated        int64
}

func (s *Server) playlistRows(uid, and string, args ...any) ([]playlistRow, error) {
	rows, err := s.db.Query(`SELECT id, name, kind, rule_json, updated_at FROM playlists WHERE user_id = ? `+and+` ORDER BY updated_at DESC`, append([]any{uid}, args...)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []playlistRow{}
	for rows.Next() {
		var p playlistRow
		if err := rows.Scan(&p.id, &p.name, &p.kind, &p.rule, &p.updated); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (s *Server) playlistTracks(uid string, p playlistRow) ([]Track, *Rule, error) {
	if p.kind == "smart" {
		var r Rule
		if p.rule.Valid {
			json.Unmarshal([]byte(p.rule.String), &r)
		}
		ts, err := s.resolveRule(uid, r)
		return ts, &r, err
	}
	ts, err := s.queryTracks(trackCols+libJoin+`JOIN playlist_items pi ON pi.track_id = t.id
		WHERE ut.user_id = ? AND pi.playlist_id = ? ORDER BY pi.position`, uid, p.id)
	return ts, nil, err
}

func summarize(id, name, kind string, rule *Rule, updated int64, ts []Track) Playlist {
	p := Playlist{ID: id, Name: name, Kind: kind, Rule: rule, TrackCount: len(ts), UpdatedAt: updated, CoverTrackIDs: []string{}}
	for _, t := range ts {
		p.DurationMs += t.DurationMs
		if t.HasCover && len(p.CoverTrackIDs) < 4 {
			p.CoverTrackIDs = append(p.CoverTrackIDs, t.ID)
		}
	}
	return p
}

func (s *Server) likedTracks(uid string) ([]Track, error) {
	return s.libTracks(uid, `AND l.track_id IS NOT NULL ORDER BY l.created_at DESC`)
}

func (s *Server) listPlaylists(uid string) ([]Playlist, error) {
	liked, err := s.likedTracks(uid)
	if err != nil {
		return nil, err
	}
	out := []Playlist{summarize(likedID, "Yêu thích", "system", nil, 0, liked)}
	rows, err := s.playlistRows(uid, "")
	if err != nil {
		return nil, err
	}
	for _, p := range rows {
		ts, rule, err := s.playlistTracks(uid, p)
		if err != nil {
			return nil, err
		}
		out = append(out, summarize(p.id, p.name, p.kind, rule, p.updated, ts))
	}
	return out, nil
}

func (s *Server) loadPlaylist(uid, id string) (*Playlist, []Track, error) {
	if id == likedID {
		ts, err := s.likedTracks(uid)
		if err != nil {
			return nil, nil, err
		}
		p := summarize(likedID, "Yêu thích", "system", nil, 0, ts)
		return &p, ts, nil
	}
	rows, err := s.playlistRows(uid, `AND id = ?`, id)
	if err != nil {
		return nil, nil, err
	}
	if len(rows) == 0 {
		return nil, nil, errNotFound
	}
	ts, rule, err := s.playlistTracks(uid, rows[0])
	if err != nil {
		return nil, nil, err
	}
	p := summarize(rows[0].id, rows[0].name, rows[0].kind, rule, rows[0].updated, ts)
	return &p, ts, nil
}

func (s *Server) handleListPlaylists(w http.ResponseWriter, r *http.Request) {
	ps, err := s.listPlaylists(userOf(r).ID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, ps)
}

func (s *Server) handleGetPlaylist(w http.ResponseWriter, r *http.Request) {
	p, ts, err := s.loadPlaylist(userOf(r).ID, r.PathValue("id"))
	if errors.Is(err, errNotFound) {
		httpError(w, http.StatusNotFound, "Không có playlist này")
		return
	} else if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"playlist": p, "tracks": ts})
}

func (s *Server) handleCreatePlaylist(w http.ResponseWriter, r *http.Request) {
	uid := userOf(r).ID
	var body struct {
		Name     string   `json:"name"`
		Rule     *Rule    `json:"rule"`
		TrackIDs []string `json:"trackIds"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	body.Name = strings.TrimSpace(body.Name)
	if body.Name == "" || len(body.Name) > 200 {
		httpError(w, http.StatusBadRequest, "Tên playlist không được trống")
		return
	}
	kind := "manual"
	var ruleJSON sql.NullString
	if body.Rule != nil {
		if err := body.Rule.validate(); err != nil {
			httpError(w, http.StatusBadRequest, err.Error())
			return
		}
		kind = "smart"
		b, _ := json.Marshal(body.Rule)
		ruleJSON = sql.NullString{String: string(b), Valid: true}
	}
	id := newID()
	now := nowMs()
	tx, err := s.db.Begin()
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`INSERT INTO playlists(id, user_id, name, kind, rule_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`,
		id, uid, body.Name, kind, ruleJSON, now, now); err != nil {
		s.internalError(w, r, err)
		return
	}
	if kind == "manual" {
		if err := addItems(tx, uid, id, body.TrackIDs); err != nil {
			s.internalError(w, r, err)
			return
		}
	}
	if err := tx.Commit(); err != nil {
		s.internalError(w, r, err)
		return
	}
	p, _, err := s.loadPlaylist(uid, id)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	s.hub.Publish(uid, "playlists", map[string]string{"id": id})
	writeJSON(w, http.StatusCreated, p)
}

// addItems appends tracks from the user's library that are not yet in the
// playlist, keeping order.
func addItems(tx *sql.Tx, uid, playlistID string, ids []string) error {
	if len(ids) > 5000 {
		return errors.New("too many items")
	}
	var maxPos int64
	if err := tx.QueryRow(`SELECT COALESCE(MAX(position), 0) FROM playlist_items WHERE playlist_id = ?`, playlistID).Scan(&maxPos); err != nil {
		return err
	}
	now := nowMs()
	for _, tid := range ids {
		maxPos++
		if _, err := tx.Exec(`INSERT INTO playlist_items(playlist_id, track_id, position, added_at)
			SELECT ?, track_id, ?, ? FROM user_tracks WHERE user_id = ? AND track_id = ? ON CONFLICT DO NOTHING`, playlistID, maxPos, now, uid, tid); err != nil {
			return err
		}
	}
	_, err := tx.Exec(`UPDATE playlists SET updated_at = ? WHERE id = ?`, now, playlistID)
	return err
}

func (s *Server) requireManual(w http.ResponseWriter, uid, id string) bool {
	var kind string
	err := s.db.QueryRow(`SELECT kind FROM playlists WHERE id = ? AND user_id = ?`, id, uid).Scan(&kind)
	if errors.Is(err, sql.ErrNoRows) {
		httpError(w, http.StatusNotFound, "Không có playlist này")
		return false
	} else if err != nil {
		httpError(w, http.StatusInternalServerError, "Lỗi máy chủ")
		return false
	}
	if kind != "manual" {
		httpError(w, http.StatusBadRequest, "Playlist thông minh tự cập nhật theo luật, không sửa tay được")
		return false
	}
	return true
}

func (s *Server) handlePatchPlaylist(w http.ResponseWriter, r *http.Request) {
	uid := userOf(r).ID
	id := r.PathValue("id")
	if id == likedID {
		httpError(w, http.StatusBadRequest, "Không đổi được playlist hệ thống")
		return
	}
	var body struct {
		Name *string `json:"name"`
		Rule *Rule   `json:"rule"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if body.Name != nil {
		n := strings.TrimSpace(*body.Name)
		if n == "" || len(n) > 200 {
			httpError(w, http.StatusBadRequest, "Tên playlist không được trống")
			return
		}
		res, err := s.db.Exec(`UPDATE playlists SET name = ?, updated_at = ? WHERE id = ? AND user_id = ?`, n, nowMs(), id, uid)
		if err != nil {
			s.internalError(w, r, err)
			return
		}
		if n, _ := res.RowsAffected(); n == 0 {
			httpError(w, http.StatusNotFound, "Không có playlist này")
			return
		}
	}
	if body.Rule != nil {
		if err := body.Rule.validate(); err != nil {
			httpError(w, http.StatusBadRequest, err.Error())
			return
		}
		b, _ := json.Marshal(body.Rule)
		if _, err := s.db.Exec(`UPDATE playlists SET rule_json = ?, updated_at = ? WHERE id = ? AND user_id = ? AND kind = 'smart'`, string(b), nowMs(), id, uid); err != nil {
			s.internalError(w, r, err)
			return
		}
	}
	s.hub.Publish(uid, "playlists", map[string]string{"id": id})
	s.handleGetPlaylist(w, r)
}

func (s *Server) handleDeletePlaylist(w http.ResponseWriter, r *http.Request) {
	uid := userOf(r).ID
	id := r.PathValue("id")
	if id == likedID {
		httpError(w, http.StatusBadRequest, "Không xoá được playlist hệ thống")
		return
	}
	if _, err := s.db.Exec(`DELETE FROM playlists WHERE id = ? AND user_id = ?`, id, uid); err != nil {
		s.internalError(w, r, err)
		return
	}
	s.hub.Publish(uid, "playlists", map[string]string{"deleted": id})
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleAddPlaylistItems(w http.ResponseWriter, r *http.Request) {
	uid := userOf(r).ID
	id := r.PathValue("id")
	var body struct {
		TrackIDs []string `json:"trackIds"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if id == likedID {
		for _, tid := range body.TrackIDs {
			if _, err := s.db.Exec(`INSERT INTO likes(user_id, track_id, created_at) SELECT ?, track_id, ? FROM user_tracks WHERE user_id = ? AND track_id = ? ON CONFLICT DO NOTHING`, uid, nowMs(), uid, tid); err != nil {
				s.internalError(w, r, err)
				return
			}
		}
	} else {
		if !s.requireManual(w, uid, id) {
			return
		}
		tx, err := s.db.Begin()
		if err != nil {
			s.internalError(w, r, err)
			return
		}
		defer tx.Rollback()
		if err := addItems(tx, uid, id, body.TrackIDs); err != nil {
			s.internalError(w, r, err)
			return
		}
		if err := tx.Commit(); err != nil {
			s.internalError(w, r, err)
			return
		}
	}
	s.hub.Publish(uid, "playlists", map[string]string{"id": id})
	s.handleGetPlaylist(w, r)
}

func (s *Server) handleReorderPlaylist(w http.ResponseWriter, r *http.Request) {
	uid := userOf(r).ID
	id := r.PathValue("id")
	if !s.requireManual(w, uid, id) {
		return
	}
	var body struct {
		TrackIDs []string `json:"trackIds"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	tx, err := s.db.Begin()
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	defer tx.Rollback()
	var count int
	tx.QueryRow(`SELECT COUNT(*) FROM playlist_items WHERE playlist_id = ?`, id).Scan(&count)
	if count != len(body.TrackIDs) {
		httpError(w, http.StatusConflict, "Playlist đã thay đổi, tải lại rồi thử lại")
		return
	}
	for i, tid := range body.TrackIDs {
		res, err := tx.Exec(`UPDATE playlist_items SET position = ? WHERE playlist_id = ? AND track_id = ?`, i+1, id, tid)
		if err != nil {
			s.internalError(w, r, err)
			return
		}
		if n, _ := res.RowsAffected(); n != 1 {
			httpError(w, http.StatusConflict, "Playlist đã thay đổi, tải lại rồi thử lại")
			return
		}
	}
	tx.Exec(`UPDATE playlists SET updated_at = ? WHERE id = ?`, nowMs(), id)
	if err := tx.Commit(); err != nil {
		s.internalError(w, r, err)
		return
	}
	s.hub.Publish(uid, "playlists", map[string]string{"id": id})
	s.handleGetPlaylist(w, r)
}

func (s *Server) handleRemovePlaylistItem(w http.ResponseWriter, r *http.Request) {
	uid := userOf(r).ID
	id, tid := r.PathValue("id"), r.PathValue("trackId")
	if id == likedID {
		s.db.Exec(`DELETE FROM likes WHERE user_id = ? AND track_id = ?`, uid, tid)
	} else {
		if !s.requireManual(w, uid, id) {
			return
		}
		if _, err := s.db.Exec(`DELETE FROM playlist_items WHERE playlist_id = ? AND track_id = ?`, id, tid); err != nil {
			s.internalError(w, r, err)
			return
		}
		s.db.Exec(`UPDATE playlists SET updated_at = ? WHERE id = ?`, nowMs(), id)
	}
	s.hub.Publish(uid, "playlists", map[string]string{"id": id})
	s.handleGetPlaylist(w, r)
}

func (s *Server) handleExportPlaylist(w http.ResponseWriter, r *http.Request) {
	p, ts, err := s.loadPlaylist(userOf(r).ID, r.PathValue("id"))
	if errors.Is(err, errNotFound) {
		httpError(w, http.StatusNotFound, "Không có playlist này")
		return
	} else if err != nil {
		s.internalError(w, r, err)
		return
	}
	name := safeFilename(p.Name)
	if r.URL.Query().Get("format") == "json" {
		w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": name + ".json"}))
		writeJSON(w, http.StatusOK, map[string]any{"name": p.Name, "tracks": ts})
		return
	}
	w.Header().Set("Content-Type", "audio/x-mpegurl; charset=utf-8")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": name + ".m3u"}))
	scheme := "http"
	if isHTTPS(r) {
		scheme = "https"
	}
	var b strings.Builder
	b.WriteString("#EXTM3U\n#PLAYLIST:" + p.Name + "\n")
	for _, t := range ts {
		fmt.Fprintf(&b, "#EXTINF:%d,%s - %s\n%s://%s/api/tracks/%s/stream\n", t.DurationMs/1000, t.Artist, t.Title, scheme, r.Host, t.ID)
	}
	w.Write([]byte(b.String()))
}

func safeFilename(s string) string {
	s = strings.Map(func(r rune) rune {
		if strings.ContainsRune(`\/:*?"<>|`, r) || r < 32 {
			return '_'
		}
		return r
	}, s)
	if s == "" {
		return "playlist"
	}
	return s
}
