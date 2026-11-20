package server

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"rii_music/internal/textutil"
)

// Track is a shared song as seen from one user's library (play count, like
// and added date are that user's).
type Track struct {
	ID           string  `json:"id"`
	Title        string  `json:"title"`
	Artist       string  `json:"artist"`
	Album        string  `json:"album"`
	DurationMs   int64   `json:"durationMs"`
	HasCover     bool    `json:"hasCover"`
	GainDb       float64 `json:"gainDb"`
	PlayCount    int64   `json:"playCount"`
	LastPlayedAt int64   `json:"lastPlayedAt"`
	AddedAt      int64   `json:"addedAt"`
	Mime         string  `json:"mime"`
	Liked        bool    `json:"liked"`
	SourceURL    string  `json:"sourceUrl"`
	Lang         string  `json:"lang"` // vi | en | ja | ko | zh | th | ""
	// Genres / tags from Deezer and Last.fm, lowercase ("pop", "ballad"); filled in the background.
	Genres []string `json:"genres"`
}

const trackCols = `SELECT t.id, t.title, t.artist, t.album, t.duration_ms, t.has_cover, t.gain_db,
  ut.play_count, COALESCE(ut.last_played_at, 0), ut.added_at, t.mime, (l.track_id IS NOT NULL), t.source_url, t.lang, t.genres `

// libJoin + "WHERE ut.user_id = ?" selects one user's library.
const libJoin = `FROM user_tracks ut JOIN tracks t ON t.id = ut.track_id
  LEFT JOIN likes l ON l.user_id = ut.user_id AND l.track_id = t.id `

// queryTracks reads every row before returning (single DB connection: no nested queries while iterating).
func (s *Server) queryTracks(q string, args ...any) ([]Track, error) {
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Track{}
	for rows.Next() {
		var t Track
		var genres string
		if err := rows.Scan(&t.ID, &t.Title, &t.Artist, &t.Album, &t.DurationMs, &t.HasCover, &t.GainDb,
			&t.PlayCount, &t.LastPlayedAt, &t.AddedAt, &t.Mime, &t.Liked, &t.SourceURL, &t.Lang, &genres); err != nil {
			return nil, err
		}
		t.Genres = splitGenres(genres)
		out = append(out, t)
	}
	return out, rows.Err()
}

// libTracks queries a user's library; rest starts with AND / ORDER BY / LIMIT.
func (s *Server) libTracks(uid, rest string, args ...any) ([]Track, error) {
	return s.queryTracks(trackCols+libJoin+`WHERE ut.user_id = ? `+rest, append([]any{uid}, args...)...)
}

// getTrack returns a track from the user's library.
func (s *Server) getTrack(uid, id string) (*Track, error) {
	ts, err := s.libTracks(uid, `AND t.id = ?`, id)
	if err != nil {
		return nil, err
	}
	if len(ts) == 0 {
		return nil, errNotFound
	}
	return &ts[0], nil
}

// sharedTrack reads a track from the shared store, without per-user fields.
func (s *Server) sharedTrack(id string) (*Track, error) {
	ts, err := s.queryTracks(`SELECT t.id, t.title, t.artist, t.album, t.duration_ms, t.has_cover, t.gain_db,
		0, 0, t.added_at, t.mime, 0, t.source_url, t.lang, t.genres FROM tracks t WHERE t.id = ?`, id)
	if err != nil {
		return nil, err
	}
	if len(ts) == 0 {
		return nil, errNotFound
	}
	return &ts[0], nil
}

// tracksByIDs returns the user's tracks in the given order, skipping unknown ids.
func (s *Server) tracksByIDs(uid string, ids []string) ([]Track, error) {
	if len(ids) == 0 {
		return []Track{}, nil
	}
	all, err := s.libTracks(uid, "")
	if err != nil {
		return nil, err
	}
	byID := make(map[string]Track, len(all))
	for _, t := range all {
		byID[t.ID] = t
	}
	out := make([]Track, 0, len(ids))
	for _, id := range ids {
		if t, ok := byID[id]; ok {
			out = append(out, t)
		}
	}
	return out, nil
}

var trackOrder = map[string]string{
	"added":  "ut.added_at DESC",
	"title":  "lower(t.title) ASC",
	"artist": "lower(t.artist) ASC, lower(t.album), lower(t.title)",
	"plays":  "ut.play_count DESC, ut.last_played_at DESC",
}

func (s *Server) handleListTracks(w http.ResponseWriter, r *http.Request) {
	order, ok := trackOrder[r.URL.Query().Get("sort")]
	if !ok {
		order = trackOrder["added"]
	}
	ts, err := s.libTracks(userOf(r).ID, `ORDER BY `+order)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, ts)
}

func (s *Server) handleGetTrack(w http.ResponseWriter, r *http.Request) {
	t, err := s.getTrack(userOf(r).ID, r.PathValue("id"))
	if errors.Is(err, errNotFound) {
		httpError(w, http.StatusNotFound, "Không có bài này")
		return
	} else if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, t)
}

func searchText(title, artist, album string) string {
	return textutil.Fold(title + " " + artist + " " + album)
}

// handlePatchTrack edits title / artist / album. Track data is shared, so a
// listener can only edit songs nobody else has; admins can edit any.
func (s *Server) handlePatchTrack(w http.ResponseWriter, r *http.Request) {
	u := userOf(r)
	id := r.PathValue("id")
	var body struct {
		Title  *string `json:"title"`
		Artist *string `json:"artist"`
		Album  *string `json:"album"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	t, err := s.getTrack(u.ID, id)
	if errors.Is(err, errNotFound) {
		httpError(w, http.StatusNotFound, "Không có bài này")
		return
	} else if err != nil {
		s.internalError(w, r, err)
		return
	}
	if !u.IsAdmin() {
		var others int
		s.db.QueryRow(`SELECT COUNT(*) FROM user_tracks WHERE track_id = ? AND user_id != ?`, id, u.ID).Scan(&others)
		if others > 0 {
			httpError(w, http.StatusForbidden, "Bài này người khác cũng có trong thư viện, nhờ admin sửa tên")
			return
		}
	}
	if body.Title != nil {
		t.Title = strings.TrimSpace(*body.Title)
	}
	if body.Artist != nil {
		t.Artist = strings.TrimSpace(*body.Artist)
	}
	if body.Album != nil {
		t.Album = strings.TrimSpace(*body.Album)
	}
	if t.Title == "" || len(t.Title) > 300 || len(t.Artist) > 300 || len(t.Album) > 300 {
		httpError(w, http.StatusBadRequest, "Tên bài không được trống và tối đa 300 ký tự")
		return
	}
	// Edited by hand: MusicBrainz must not "correct" it afterwards.
	_, err = s.db.Exec(`UPDATE tracks SET title=?, artist=?, album=?, search=?, lang=?, meta_source='manual', mb_done=1 WHERE id=?`,
		t.Title, t.Artist, t.Album, searchText(t.Title, t.Artist, t.Album), textutil.DetectLang(t.Title, t.Artist), id)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	s.publishToOwners(id, "library", map[string]string{"trackId": id})
	writeJSON(w, http.StatusOK, t)
}

// publishToOwners notifies every user who has the track.
func (s *Server) publishToOwners(trackID, event string, data any) {
	rows, err := s.db.Query(`SELECT user_id FROM user_tracks WHERE track_id = ?`, trackID)
	if err != nil {
		return
	}
	ids, _ := scanStrings(rows)
	for _, uid := range ids {
		s.hub.Publish(uid, event, data)
	}
}

func (s *Server) handleDeleteTrack(w http.ResponseWriter, r *http.Request) {
	u := userOf(r)
	id := r.PathValue("id")
	if _, err := s.getTrack(u.ID, id); errors.Is(err, errNotFound) {
		httpError(w, http.StatusNotFound, "Không có bài này")
		return
	}
	if err := s.removeFromLibrary(u.ID, id); err != nil {
		s.internalError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// removeFromLibrary takes a track out of one user's library (with their likes
// and playlist entries), remembers it so automatic downloads don't bring it
// back, and deletes the shared file once nobody has it.
func (s *Server) removeFromLibrary(uid, trackID string) error {
	err := s.tx(func(exec func(string, ...any) error) error {
		for _, q := range []string{
			`INSERT INTO removed_tracks(user_id, source_id, artist, title, removed_at)
				SELECT ?, source_id, artist, title, ? FROM tracks WHERE id = ? AND source_id IS NOT NULL
				ON CONFLICT(user_id, source_id) DO UPDATE SET removed_at = excluded.removed_at`,
		} {
			if err := exec(q, uid, nowMs(), trackID); err != nil {
				return err
			}
		}
		if err := exec(`DELETE FROM likes WHERE user_id = ? AND track_id = ?`, uid, trackID); err != nil {
			return err
		}
		if err := exec(`DELETE FROM playlist_items WHERE track_id = ? AND playlist_id IN (SELECT id FROM playlists WHERE user_id = ?)`, trackID, uid); err != nil {
			return err
		}
		return exec(`DELETE FROM user_tracks WHERE user_id = ? AND track_id = ?`, uid, trackID)
	})
	if err != nil {
		return err
	}
	s.hub.Publish(uid, "library", map[string]string{"deleted": trackID})
	s.gcTrack(trackID)
	return nil
}

// gcTrack deletes a shared track and its files when no library holds it.
func (s *Server) gcTrack(id string) bool {
	var n int
	s.db.QueryRow(`SELECT COUNT(*) FROM user_tracks WHERE track_id = ?`, id).Scan(&n)
	if n > 0 {
		return false
	}
	var file string
	if s.db.QueryRow(`SELECT file_path FROM tracks WHERE id = ?`, id).Scan(&file) != nil {
		return false
	}
	if _, err := s.db.Exec(`DELETE FROM tracks WHERE id = ?`, id); err != nil {
		s.log.Warn("gc track", "track", id, "err", err)
		return false
	}
	os.Remove(filepath.Join(s.cfg.DataDir, filepath.FromSlash(file)))
	os.Remove(filepath.Join(s.cfg.CoverDir(), id+".jpg"))
	for _, ext := range []string{".m4a", ".opus", ".webm", ".mp3"} {
		os.Remove(filepath.Join(s.previewDir(), id+ext))
	}
	s.features.markDirty()
	return true
}

// canAccess: a user streams tracks in their library; admins any track.
func (s *Server) canAccess(u *User, trackID string) bool {
	q := `SELECT 1 FROM user_tracks WHERE user_id = ? AND track_id = ?`
	args := []any{u.ID, trackID}
	if u.IsAdmin() {
		q, args = `SELECT 1 FROM tracks WHERE id = ?`, []any{trackID}
	}
	var one int
	if s.db.QueryRow(q, args...).Scan(&one) == nil {
		return true
	}
	// Nghe chung: the songs of the room the user is in.
	return s.roomCanAccess(u.ID, trackID)
}

func (s *Server) handleStream(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !s.canAccess(userOf(r), id) {
		http.NotFound(w, r)
		return
	}
	var file, mime, title, artist string
	if err := s.db.QueryRow(`SELECT file_path, mime, title, artist FROM tracks WHERE id=?`, id).Scan(&file, &mime, &title, &artist); err != nil {
		http.NotFound(w, r)
		return
	}
	f, err := os.Open(filepath.Join(s.cfg.DataDir, filepath.FromSlash(file)))
	if err != nil {
		httpError(w, http.StatusGone, "Thiếu file nhạc")
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	w.Header().Set("Content-Type", mime)
	w.Header().Set("Cache-Control", "private, max-age=86400")
	if r.URL.Query().Get("download") != "" {
		// "Tải về máy": save the file as "Artist - Title.m4a".
		w.Header().Set("Content-Disposition", downloadDisposition(artist, title, filepath.Ext(file)))
	}
	http.ServeContent(w, r, "", st.ModTime(), f) // handles Range
}

// downloadDisposition: attachment with a UTF-8 file name (RFC 6266 / 5987) and
// an accent-free fallback for old clients.
func downloadDisposition(artist, title, ext string) string {
	name := strings.TrimSpace(title)
	if a := strings.TrimSpace(artist); a != "" {
		name = a + " - " + name
	}
	name = strings.Map(func(r rune) rune {
		switch {
		case r < 0x20, strings.ContainsRune(`<>:"/\|?*`, r):
			return '_'
		}
		return r
	}, name)
	if rs := []rune(name); len(rs) > 150 {
		name = string(rs[:150])
	}
	if name == "" {
		name = "track"
	}
	name += ext
	ascii := strings.Map(func(r rune) rune {
		if r < 0x20 || r > 0x7e || r == '"' || r == '\\' {
			return -1
		}
		return r
	}, textutil.Fold(name))
	if strings.TrimSuffix(ascii, ext) == "" {
		ascii = "track" + ext
	}
	return `attachment; filename="` + ascii + `"; filename*=UTF-8''` + url.PathEscape(name)
}

func (s *Server) handleCover(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !isHexID(id) || !s.canAccess(userOf(r), id) {
		http.NotFound(w, r)
		return
	}
	f, err := os.Open(filepath.Join(s.cfg.CoverDir(), id+".jpg"))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	st, _ := f.Stat()
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Cache-Control", "private, max-age=604800")
	http.ServeContent(w, r, "", st.ModTime(), f)
}

func isHexID(s string) bool {
	if len(s) != 24 {
		return false
	}
	for _, c := range s {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

// ── artists & albums (derived from track fields, per library) ─────────

type Artist struct {
	Name       string `json:"name"`
	TrackCount int    `json:"trackCount"`
	AlbumCount int    `json:"albumCount"`
	CoverTrack string `json:"coverTrackId"`
	PlayCount  int64  `json:"playCount"`
}

type Album struct {
	Name       string `json:"name"`
	Artist     string `json:"artist"`
	TrackCount int    `json:"trackCount"`
	CoverTrack string `json:"coverTrackId"`
	AddedAt    int64  `json:"addedAt"`
	DurationMs int64  `json:"durationMs"`
}

func (s *Server) listArtists(uid string) ([]Artist, error) {
	ts, err := s.libTracks(uid, `ORDER BY ut.play_count DESC`)
	if err != nil {
		return nil, err
	}
	acc := map[string]*Artist{}
	albums := map[string]map[string]bool{}
	order := []string{}
	for _, t := range ts {
		if t.Artist == "" {
			continue
		}
		a := acc[t.Artist]
		if a == nil {
			a = &Artist{Name: t.Artist}
			acc[t.Artist] = a
			albums[t.Artist] = map[string]bool{}
			order = append(order, t.Artist)
		}
		a.TrackCount++
		a.PlayCount += t.PlayCount
		if t.Album != "" {
			albums[t.Artist][t.Album] = true
		}
		if a.CoverTrack == "" && t.HasCover {
			a.CoverTrack = t.ID // most played track with a cover
		}
	}
	out := make([]Artist, 0, len(order))
	for _, n := range order {
		a := acc[n]
		a.AlbumCount = len(albums[n])
		out = append(out, *a)
	}
	sort.SliceStable(out, func(i, j int) bool { return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name) })
	return out, nil
}

func (s *Server) listAlbums(uid string, artist string) ([]Album, error) {
	rest, args := `AND t.album != '' ORDER BY ut.added_at`, []any{}
	if artist != "" {
		rest, args = `AND t.album != '' AND t.artist = ? ORDER BY ut.added_at`, []any{artist}
	}
	ts, err := s.libTracks(uid, rest, args...)
	if err != nil {
		return nil, err
	}
	acc := map[string]*Album{}
	order := []string{}
	for _, t := range ts {
		k := t.Album + "\x00" + t.Artist
		a := acc[k]
		if a == nil {
			a = &Album{Name: t.Album, Artist: t.Artist}
			acc[k] = a
			order = append(order, k)
		}
		a.TrackCount++
		a.DurationMs += t.DurationMs
		a.AddedAt = max(a.AddedAt, t.AddedAt)
		if a.CoverTrack == "" && t.HasCover {
			a.CoverTrack = t.ID
		}
	}
	out := make([]Album, 0, len(order))
	for _, k := range order {
		out = append(out, *acc[k])
	}
	sort.SliceStable(out, func(i, j int) bool { return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name) })
	return out, nil
}

func (s *Server) handleListArtists(w http.ResponseWriter, r *http.Request) {
	as, err := s.listArtists(userOf(r).ID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, as)
}

func (s *Server) handleGetArtist(w http.ResponseWriter, r *http.Request) {
	uid := userOf(r).ID
	name := r.URL.Query().Get("name")
	all, err := s.libTracks(uid, `ORDER BY ut.play_count DESC, ut.added_at DESC`)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	// Every song the artist is on, featured ones too ("Rhymastic, SOOBIN, Binz"
	// counts for each), whatever the accents or case.
	key := looseName(name)
	tracks := []Track{}
	for _, t := range all {
		if hasArtist(t.Artist, key) {
			tracks = append(tracks, t)
		}
	}
	if len(tracks) == 0 {
		httpError(w, http.StatusNotFound, "Không có nghệ sĩ này")
		return
	}
	allAlbums, err := s.listAlbums(uid, "")
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	albums := []Album{}
	for _, a := range allAlbums {
		if hasArtist(a.Artist, key) {
			albums = append(albums, a)
		}
	}
	others, err := s.listArtists(uid)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	similar := []Artist{}
	for _, a := range others {
		if looseName(a.Name) != key {
			similar = append(similar, a)
		}
	}
	sort.SliceStable(similar, func(i, j int) bool { return similar[i].PlayCount > similar[j].PlayCount })
	if len(similar) > 8 {
		similar = similar[:8]
	}
	writeJSON(w, http.StatusOK, map[string]any{"name": name, "tracks": tracks, "albums": albums, "others": similar})
}

// hasArtist: one of the artists credited in s is the one with this loose key.
func hasArtist(s, key string) bool {
	for _, a := range splitArtists(s) {
		if looseName(a) == key {
			return true
		}
	}
	return false
}

// handleArtistWeb: the artist's songs and albums on YouTube Music, for the
// artist page (also for artists with nothing in the library yet).
func (s *Server) handleArtistWeb(w http.ResponseWriter, r *http.Request) {
	uid := userOf(r).ID
	name := strings.TrimSpace(r.URL.Query().Get("name"))
	if name == "" || len(name) > 200 {
		httpError(w, http.StatusBadRequest, "Thiếu tên nghệ sĩ")
		return
	}
	key := looseName(name)
	var songs, albums []WebResult
	var songErr, albumErr error
	done := make(chan struct{}, 2)
	go func() { songs, songErr = ytmSearch(r.Context(), s.ext.hc, name, "songs"); done <- struct{}{} }()
	go func() { albums, albumErr = ytmSearch(r.Context(), s.ext.hc, name, "albums"); done <- struct{}{} }()
	<-done
	<-done
	if songErr != nil && albumErr != nil {
		httpError(w, http.StatusBadGateway, "Tìm trên YouTube Music lỗi: "+songErr.Error())
		return
	}
	keep := func(in []WebResult, n int) []WebResult {
		out := []WebResult{}
		for _, x := range in {
			if len(out) < n && hasArtist(x.Artist, key) {
				out = append(out, x)
			}
		}
		return out
	}
	songs, albums = keep(songs, 20), keep(albums, 20)
	s.markResults(uid, songs, true)
	for i := range albums {
		albums[i].InLibrary = s.savedPlaylistID(uid, albums[i].ID)
	}
	writeJSON(w, http.StatusOK, map[string]any{"songs": songs, "albums": albums})
}

func (s *Server) handleListAlbums(w http.ResponseWriter, r *http.Request) {
	as, err := s.listAlbums(userOf(r).ID, "")
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, as)
}

func (s *Server) handleGetAlbum(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	tracks, err := s.libTracks(userOf(r).ID, `AND t.album = ? AND t.artist = ? ORDER BY ut.added_at ASC`, q.Get("name"), q.Get("artist"))
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if len(tracks) == 0 {
		httpError(w, http.StatusNotFound, "Không có album này")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"name": q.Get("name"), "artist": q.Get("artist"), "tracks": tracks})
}

// ── search ──────────────────────────────────────────────────────────────

func (s *Server) handleSearch(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" || len(q) > 200 {
		httpError(w, http.StatusBadRequest, "Từ khoá trống hoặc quá dài")
		return
	}
	if r.URL.Query().Get("scope") == "web" {
		s.searchWeb(w, r, q)
		return
	}
	uid := userOf(r).ID
	terms := textutil.Terms(q)
	where := []string{}
	args := []any{}
	for _, t := range terms {
		where = append(where, `t.search LIKE ? ESCAPE '\'`)
		args = append(args, "%"+likeEscape(t)+"%")
	}
	tracks, err := s.libTracks(uid, `AND `+strings.Join(where, " AND ")+` ORDER BY ut.play_count DESC LIMIT 100`, args...)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	match := func(s string) bool {
		f := textutil.Fold(s)
		for _, t := range terms {
			if !strings.Contains(f, t) {
				return false
			}
		}
		return true
	}
	artists, err := s.listArtists(uid)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	albums, err := s.listAlbums(uid, "")
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	pls, err := s.listPlaylists(uid)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	ra, rb, rp := []Artist{}, []Album{}, []Playlist{}
	for _, a := range artists {
		if match(a.Name) {
			ra = append(ra, a)
		}
	}
	for _, a := range albums {
		if match(a.Name + " " + a.Artist) {
			rb = append(rb, a)
		}
	}
	for _, p := range pls {
		if match(p.Name) {
			rp = append(rp, p)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"tracks": tracks, "artists": ra, "albums": rb, "playlists": rp})
}

func likeEscape(s string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(s)
}

type WebResult struct {
	ID        string  `json:"id"`
	Title     string  `json:"title"`
	Channel   string  `json:"channel"`
	Duration  float64 `json:"duration"`
	Thumbnail string  `json:"thumbnail"`
	URL       string  `json:"url"`
	InLibrary string  `json:"inLibrary"` // track id when already in the user's library
	OnServer  bool    `json:"onServer"`  // already downloaded by someone: adding it is instant
	Artist    string  `json:"artist,omitempty"`
	Album     string  `json:"album,omitempty"`
	Kind      string  `json:"kind"` // songs | videos | albums | playlists (YouTube Music) | youtube (yt-dlp fallback)
}

func (s *Server) searchWeb(w http.ResponseWriter, r *http.Request, q string) {
	uid := userOf(r).ID
	kind := r.URL.Query().Get("kind")
	if _, ok := ytmFilters[kind]; !ok {
		kind = "songs"
	}
	out, err := ytmSearch(r.Context(), s.ext.hc, q, kind)
	source := "ytmusic"
	if (err != nil || len(out) == 0) && (kind == "songs" || kind == "videos") {
		if err != nil {
			s.log.Warn("YouTube Music search failed, falling back to yt-dlp", "err", err)
		}
		out, err = s.searchYTDLP(r.Context(), q)
		source = "youtube"
		if err != nil {
			s.log.Warn("web search failed", "err", err)
			httpError(w, http.StatusBadGateway, "Tìm trên YouTube lỗi: "+err.Error())
			return
		}
	}
	if err != nil {
		httpError(w, http.StatusBadGateway, "Tìm trên YouTube Music lỗi: "+err.Error())
		return
	}
	// Same video id, or (another upload of) the same song: the library may hold
	// the MV while YouTube Music lists the audio.
	s.markResults(uid, out, kind == "songs" || kind == "videos")
	for i := range out {
		if out[i].Kind == "albums" || out[i].Kind == "playlists" {
			out[i].InLibrary = s.savedPlaylistID(uid, out[i].ID) // saved as a playlist
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"results": out, "source": source})
}

// searchYTDLP is the slower fallback: a plain YouTube search through yt-dlp.
func (s *Server) searchYTDLP(ctx context.Context, q string) ([]WebResult, error) {
	res, err := s.yt.Flat(ctx, "ytsearch15:"+q)
	if err != nil {
		return nil, err
	}
	out := []WebResult{}
	for _, e := range res.Entries {
		if !videoIDRe.MatchString(e.ID) {
			continue
		}
		out = append(out, WebResult{
			ID: e.ID, Title: e.Title, Channel: firstNonEmpty(e.Channel, e.Uploader), Duration: e.Duration,
			Thumbnail: e.Thumbnail, URL: "https://www.youtube.com/watch?v=" + e.ID, Kind: "youtube",
		})
	}
	return out, nil
}

func firstNonEmpty(v ...string) string {
	for _, s := range v {
		if s != "" {
			return s
		}
	}
	return ""
}

// ── likes ───────────────────────────────────────────────────────────────

func (s *Server) handleLike(w http.ResponseWriter, r *http.Request) {
	uid := userOf(r).ID
	id := r.PathValue("id")
	res, err := s.db.Exec(`INSERT INTO likes(user_id, track_id, created_at)
		SELECT ?, track_id, ? FROM user_tracks WHERE user_id = ? AND track_id = ? ON CONFLICT DO NOTHING`, uid, nowMs(), uid, id)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		if _, err := s.getTrack(uid, id); err != nil {
			httpError(w, http.StatusNotFound, "Không có bài này")
			return
		}
	}
	s.hub.Publish(uid, "library", map[string]string{"liked": id})
	writeJSON(w, http.StatusOK, map[string]bool{"liked": true})
}

func (s *Server) handleUnlike(w http.ResponseWriter, r *http.Request) {
	uid := userOf(r).ID
	if _, err := s.db.Exec(`DELETE FROM likes WHERE user_id = ? AND track_id = ?`, uid, r.PathValue("id")); err != nil {
		s.internalError(w, r, err)
		return
	}
	s.hub.Publish(uid, "library", map[string]string{"unliked": r.PathValue("id")})
	writeJSON(w, http.StatusOK, map[string]bool{"liked": false})
}

// matchLibrary finds a library track by artist and title, loosely: "Tìm Em
// (cùng với Bảo Anh)" by Hngle matches "Tìm em ft. Bảo Anh" by Hngle.
func matchLibrary(lib []Track, artist, title string) string {
	bt := looseName(baseTitle(title))
	if bt == "" || artist == "" {
		return ""
	}
	for _, t := range lib {
		if !looseMatch(t.Artist, artist) && !looseMatch(t.Title, artist) {
			continue
		}
		lt, lb := looseName(t.Title), looseName(baseTitle(t.Title))
		if strings.Contains(lt, bt) || len(lb) >= 4 && strings.Contains(bt, lb) {
			return t.ID
		}
	}
	return ""
}
