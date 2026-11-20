package server

import (
	"net/http"
	"net/url"
	"strings"
)

// Followed artists: listed in the sidebar (with their library songs) and
// counted as a strong signal in the taste profile.

type FollowedArtist struct {
	Key        string `json:"key"`
	Name       string `json:"name"`
	Image      string `json:"image,omitempty"`
	CoverTrack string `json:"coverTrackId,omitempty"` // a library song with a cover
	TrackCount int    `json:"trackCount"`             // songs in the user's library (featured ones too)
	FollowedAt int64  `json:"followedAt"`
}

// followWeight is how much a follow adds to an artist's affinity (a like adds 3
// spread over the song's artists).
const followWeight = 4.0

// followKey: the loose name, or for names in other scripts (Korean, Japanese…)
// that fold to nothing, the lower-cased name without spaces.
func followKey(name string) string {
	if k := looseName(name); k != "" {
		return k
	}
	return strings.ToLower(strings.Join(strings.Fields(name), ""))
}

func (s *Server) followedKeys(uid string) map[string]string {
	out := map[string]string{}
	rows, err := s.db.Query(`SELECT key, name FROM artist_follows WHERE user_id = ?`, uid)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var k, n string
		if rows.Scan(&k, &n) == nil {
			out[k] = n
		}
	}
	return out
}

func (s *Server) handleListFollows(w http.ResponseWriter, r *http.Request) {
	uid := userOf(r).ID
	rows, err := s.db.Query(`SELECT key, name, image, created_at FROM artist_follows WHERE user_id = ? ORDER BY created_at DESC`, uid)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	out := []FollowedArtist{}
	keys := []string{}
	for rows.Next() {
		var f FollowedArtist
		if err := rows.Scan(&f.Key, &f.Name, &f.Image, &f.FollowedAt); err != nil {
			rows.Close()
			s.internalError(w, r, err)
			return
		}
		out = append(out, f)
		keys = append(keys, f.Key)
	}
	rows.Close()
	if len(out) > 0 {
		lib, err := s.libTracks(uid, `ORDER BY ut.play_count DESC, ut.added_at DESC`)
		if err != nil {
			s.internalError(w, r, err)
			return
		}
		idx := map[string]int{}
		for i, k := range keys {
			idx[k] = i
		}
		for _, t := range lib {
			for _, a := range splitArtists(t.Artist) {
				i, ok := idx[followKey(a)]
				if !ok {
					continue
				}
				out[i].TrackCount++
				if out[i].CoverTrack == "" && t.HasCover {
					out[i].CoverTrack = t.ID
				}
			}
		}
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleFollow(w http.ResponseWriter, r *http.Request) {
	uid := userOf(r).ID
	var body struct {
		Name  string `json:"name"`
		Image string `json:"image"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	name := strings.TrimSpace(body.Name)
	key := followKey(name)
	if key == "" || len(name) > 200 {
		httpError(w, http.StatusBadRequest, "Thiếu tên nghệ sĩ")
		return
	}
	image := strings.TrimSpace(body.Image)
	if u, err := url.Parse(image); image != "" && (err != nil || u.Scheme != "https" || len(image) > 1000) {
		image = "" // only plain https pictures (YouTube Music thumbnails)
	}
	if _, err := s.db.Exec(`INSERT INTO artist_follows(user_id, key, name, image, created_at) VALUES (?, ?, ?, ?, ?)
		ON CONFLICT (user_id, key) DO UPDATE SET image = CASE WHEN excluded.image <> '' THEN excluded.image ELSE artist_follows.image END`,
		uid, key, name, image, nowMs()); err != nil {
		s.internalError(w, r, err)
		return
	}
	s.hub.Publish(uid, "follows", map[string]string{"followed": name})
	writeJSON(w, http.StatusOK, map[string]bool{"following": true})
}

func (s *Server) handleUnfollow(w http.ResponseWriter, r *http.Request) {
	uid := userOf(r).ID
	key := followKey(strings.TrimSpace(r.URL.Query().Get("name")))
	if key == "" {
		httpError(w, http.StatusBadRequest, "Thiếu tên nghệ sĩ")
		return
	}
	if _, err := s.db.Exec(`DELETE FROM artist_follows WHERE user_id = ? AND key = ?`, uid, key); err != nil {
		s.internalError(w, r, err)
		return
	}
	s.hub.Publish(uid, "follows", map[string]string{"unfollowed": key})
	writeJSON(w, http.StatusOK, map[string]bool{"following": false})
}
