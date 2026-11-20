package server

import (
	"context"
	"net/http"
	"strings"
	"time"
)

// Albums and playlists from YouTube Music: look inside before downloading,
// save one as a RiiMusic playlist (its songs download into it, in order), and see
// the full album of a song you only have one track of.

// markResults fills inLibrary (this user has it) and onServer (someone has
// downloaded it: adding is instant).
func (s *Server) markResults(uid string, out []WebResult, loose bool) {
	mine, onServer := map[string]string{}, map[string]bool{}
	if rows, err := s.db.Query(`SELECT t.source_id, t.id, ut.user_id IS NOT NULL FROM tracks t
		LEFT JOIN user_tracks ut ON ut.track_id = t.id AND ut.user_id = ? WHERE t.source_id IS NOT NULL`, uid); err == nil {
		for rows.Next() {
			var sid, id string
			var has bool
			if rows.Scan(&sid, &id, &has) == nil {
				onServer[sid] = true
				if has {
					mine[sid] = id
				}
			}
		}
		rows.Close()
	}
	var lib []Track
	if loose {
		lib, _ = s.libTracks(uid, `ORDER BY ut.added_at DESC`)
	}
	for i := range out {
		out[i].InLibrary = mine[out[i].ID]
		out[i].OnServer = onServer[out[i].ID]
		if out[i].InLibrary == "" && loose && out[i].Kind != "albums" && out[i].Kind != "playlists" {
			out[i].InLibrary = matchLibrary(lib, out[i].Artist, out[i].Title)
		}
	}
}

// handleWebList: GET /api/web/list?id=<playlist id> — songs of a YouTube Music
// album or playlist, marked against the library.
func (s *Server) handleWebList(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	if !listIDRe.MatchString(id) {
		httpError(w, http.StatusBadRequest, "Liên kết không hợp lệ")
		return
	}
	l, err := ytmBrowseList(r.Context(), s.ext.hc, id)
	if err != nil {
		httpError(w, http.StatusBadGateway, "Không đọc được danh sách từ YouTube Music")
		return
	}
	s.markResults(userOf(r).ID, l.Tracks, false)
	l.Saved = s.savedPlaylistID(userOf(r).ID, id)
	writeJSON(w, http.StatusOK, l)
}

func (s *Server) savedPlaylistID(uid, listID string) string {
	var pid string
	s.db.QueryRow(`SELECT id FROM playlists WHERE user_id = ? AND source = ?`, uid, "ytm:"+listID).Scan(&pid)
	return pid
}

// handleSaveWebList: POST /api/web/list/save {id} — keep an album / playlist
// as a RiiMusic playlist. Songs already on the server go in at once, the others
// as they finish downloading. Saving again tops it up.
func (s *Server) handleSaveWebList(w http.ResponseWriter, r *http.Request) {
	u := userOf(r)
	var body struct {
		ID    string `json:"id"`
		Title string `json:"title"` // album headers don't always carry it: the search result's
	}
	if !readJSON(w, r, &body) {
		return
	}
	if !listIDRe.MatchString(body.ID) {
		httpError(w, http.StatusBadRequest, "Liên kết không hợp lệ")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	l, err := ytmBrowseList(ctx, s.ext.hc, body.ID)
	if err != nil || len(l.Tracks) == 0 {
		httpError(w, http.StatusBadGateway, "Không đọc được danh sách từ YouTube Music")
		return
	}
	if used, _ := s.userUsage(u.ID); used >= int64(u.StorageLimitMB)<<20 && !s.loadSettings(u.ID).AutoDownload {
		httpError(w, http.StatusInsufficientStorage, "Thư viện đã đầy giới hạn dung lượng")
		return
	}
	pid := s.savedPlaylistID(u.ID, body.ID)
	now := nowMs()
	if pid == "" {
		name := strings.TrimSpace(firstNonEmpty(l.Title, body.Title))
		if name == "" {
			name = "Playlist YouTube Music"
		}
		if len([]rune(name)) > 200 {
			name = string([]rune(name)[:200])
		}
		pid = newID()
		if _, err := s.db.Exec(`INSERT INTO playlists(id, user_id, name, kind, source, created_at, updated_at) VALUES (?,?,?,'manual',?,?,?)`,
			pid, u.ID, name, "ytm:"+body.ID, now, now); err != nil {
			s.internalError(w, r, err)
			return
		}
	}
	queued, added := 0, 0
	for i, t := range l.Tracks {
		pos := i + 1
		var trackID string
		if s.db.QueryRow(`SELECT id FROM tracks WHERE source_id = ?`, t.ID).Scan(&trackID) == nil {
			s.db.Exec(`INSERT INTO user_tracks(user_id, track_id, origin, added_at) VALUES (?,?,'user',?) ON CONFLICT DO NOTHING`, u.ID, trackID, now)
			s.db.Exec(`INSERT INTO playlist_items(playlist_id, track_id, position, added_at) VALUES (?,?,?,?) ON CONFLICT DO NOTHING`, pid, trackID, pos, now)
			added++
			continue
		}
		j, err := s.insertJobFor(u.ID, "https://www.youtube.com/watch?v="+t.ID, strings.TrimSpace(t.Artist+" - "+t.Title), "user", pid, pos)
		if err != nil {
			continue
		}
		s.dl.enqueue(j.ID)
		queued++
	}
	s.hub.Publish(u.ID, "playlists", map[string]string{"id": pid})
	s.hub.Publish(u.ID, "library", map[string]string{"added": "list"})
	p, _, _ := s.loadPlaylist(u.ID, pid)
	writeJSON(w, http.StatusOK, map[string]any{"playlist": p, "queued": queued, "added": added})
}

// fillPlaylist puts a finished download into the playlist it was saved for.
func (s *Server) fillPlaylist(j *Job) {
	if j.PlaylistID == "" || j.TrackID == "" {
		return
	}
	res, err := s.db.Exec(`INSERT INTO playlist_items(playlist_id, track_id, position, added_at)
		SELECT id, ?, ?, ? FROM playlists WHERE id = ? AND user_id = ? ON CONFLICT DO NOTHING`, j.TrackID, j.PlaylistPos, nowMs(), j.PlaylistID, j.UserID)
	if err == nil {
		if n, _ := res.RowsAffected(); n > 0 {
			s.db.Exec(`UPDATE playlists SET updated_at = ? WHERE id = ?`, nowMs(), j.PlaylistID)
			s.hub.Publish(j.UserID, "playlists", map[string]string{"id": j.PlaylistID})
		}
	}
}

// handleFullAlbum: GET /api/album/full?name=&artist= — the whole album a
// library song belongs to, from YouTube Music, with what you already have.
func (s *Server) handleFullAlbum(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	name, artist := strings.TrimSpace(q.Get("name")), strings.TrimSpace(q.Get("artist"))
	if name == "" {
		httpError(w, http.StatusBadRequest, "Thiếu tên album")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	res, err := ytmSearch(ctx, s.ext.hc, strings.TrimSpace(artist+" "+name), "albums")
	if err != nil {
		httpError(w, http.StatusBadGateway, "Không tìm được album trên YouTube Music")
		return
	}
	var pick *WebResult
	for i := range res {
		a := res[i]
		if looseMatch(baseTitle(a.Title), baseTitle(name)) && (artist == "" || looseMatch(a.Artist, splitArtists(artist)[0])) {
			pick = &res[i]
			break
		}
	}
	if pick == nil {
		writeJSON(w, http.StatusOK, map[string]any{"found": false})
		return
	}
	l, err := ytmBrowseList(ctx, s.ext.hc, pick.ID)
	if err != nil {
		httpError(w, http.StatusBadGateway, "Không đọc được album từ YouTube Music")
		return
	}
	if l.Title == "" {
		l.Title = pick.Title
	}
	if l.Thumbnail == "" {
		l.Thumbnail = pick.Thumbnail
	}
	s.markResults(userOf(r).ID, l.Tracks, true)
	l.Saved = s.savedPlaylistID(userOf(r).ID, pick.ID)
	writeJSON(w, http.StatusOK, map[string]any{"found": true, "album": l})
}
