package server

import (
	"context"
	"errors"
	"math"
	"math/rand/v2"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Recommendations (V2).
//
//   Taste profile  listen events (finish +1, repeat +2, early skip −1.5), likes,
//                  playlist membership, explicit feedback; 30-day half-life.
//   Tier 1         similar artists from Deezer / Last.fm (external.go).
//   Tier 2         item-item: tracks played near each other in the same session.
//   Tier 3         audio feature similarity (features.go).
//
// Every recommendation carries a short reason ("Vì bạn hay nghe X").

type taste struct {
	artist      map[string]float64 // looseName(artist) → affinity
	display     map[string]string  // looseName → best display name
	track       map[string]float64 // track id → affinity
	dislikedArt map[string]bool
	dislikedTrk map[string]bool
	recent      map[string]int64 // track id → last played (ms)
}

const halfLife = 30 * 24 * time.Hour

func decay(at int64) float64 {
	return math.Pow(0.5, float64(time.Since(time.UnixMilli(at)))/float64(halfLife))
}

func (s *Server) buildTaste(uid string, all []Track) (*taste, error) {
	t := &taste{artist: map[string]float64{}, display: map[string]string{}, track: map[string]float64{},
		dislikedArt: map[string]bool{}, dislikedTrk: map[string]bool{}, recent: map[string]int64{}}
	byID := map[string]Track{}
	for _, tr := range all {
		byID[tr.ID] = tr
		for _, a := range splitArtists(tr.Artist) {
			if _, ok := t.display[looseName(a)]; !ok {
				t.display[looseName(a)] = a
			}
		}
	}
	credit := func(tr Track, w float64) {
		t.track[tr.ID] += w
		parts := splitArtists(tr.Artist)
		for _, a := range parts {
			t.artist[looseName(a)] += w / float64(len(parts))
		}
	}

	since := time.Now().Add(-180 * 24 * time.Hour).UnixMilli()
	rows, err := s.db.Query(`SELECT track_id, started_at, played_ms, action FROM listen_events WHERE user_id = ? AND started_at >= ?`, uid, since)
	if err != nil {
		return nil, err
	}
	type ev struct {
		id         string
		at, played int64
		action     string
	}
	evs := []ev{}
	for rows.Next() {
		var e ev
		if rows.Scan(&e.id, &e.at, &e.played, &e.action) == nil {
			evs = append(evs, e)
		}
	}
	rows.Close()
	for _, e := range evs {
		tr, ok := byID[e.id]
		if !ok {
			continue
		}
		if e.at > t.recent[e.id] {
			t.recent[e.id] = e.at
		}
		d := decay(e.at)
		switch {
		case e.action == "repeat":
			credit(tr, 2*d)
		case e.action == "finish" || e.played >= 30000:
			credit(tr, 1*d)
		default: // skipped early
			t.track[tr.ID] -= 1.5 * d
			for _, a := range splitArtists(tr.Artist) {
				t.artist[looseName(a)] -= 0.3 * d
			}
		}
	}
	for _, tr := range all {
		if tr.Liked {
			credit(tr, 3)
		}
	}
	rows, err = s.db.Query(`SELECT pi.track_id FROM playlist_items pi JOIN playlists p ON p.id = pi.playlist_id WHERE p.user_id = ? AND p.kind = 'manual'`, uid)
	if err == nil {
		ids, _ := scanStrings(rows)
		for _, id := range ids {
			if tr, ok := byID[id]; ok {
				credit(tr, 1)
			}
		}
	}
	rows, err = s.db.Query(`SELECT kind, key, value FROM feedback WHERE user_id = ?`, uid)
	if err == nil {
		for rows.Next() {
			var kind, key string
			var v int
			if rows.Scan(&kind, &key, &v) != nil || v >= 0 {
				continue
			}
			if kind == "artist" {
				t.dislikedArt[key] = true
			} else {
				t.dislikedTrk[key] = true
			}
		}
		rows.Close()
	}
	return t, nil
}

// seeds returns the strongest positive artists, best first.
func (t *taste) seeds(n int) []string {
	type kv struct {
		k string
		v float64
	}
	xs := []kv{}
	for k, v := range t.artist {
		if v > 0 && !t.dislikedArt[k] {
			xs = append(xs, kv{k, v})
		}
	}
	sort.Slice(xs, func(i, j int) bool { return xs[i].v > xs[j].v })
	out := []string{}
	for _, x := range xs {
		out = append(out, x.k)
		if len(out) == n {
			break
		}
	}
	return out
}

func (t *taste) name(k string) string {
	if d, ok := t.display[k]; ok {
		return d
	}
	return k
}

func (t *taste) trackDisliked(tr Track) bool {
	if t.dislikedTrk[tr.ID] {
		return true
	}
	for _, a := range splitArtists(tr.Artist) {
		if t.dislikedArt[looseName(a)] {
			return true
		}
	}
	return false
}

// ── tier 2: co-listening ────────────────────────────────────────────────

type coIndex struct {
	mu sync.Mutex
	m  map[string]coEntry // per user
}

type coEntry struct {
	key  int64
	sims map[string]map[string]float64
}

// coListen builds item-item similarities from one user's listening sessions
// (a gap of 30 min starts a new session); cached until new events arrive.
func (s *Server) coListen(uid string) map[string]map[string]float64 {
	var n, maxID int64
	s.db.QueryRow(`SELECT COUNT(*), COALESCE(MAX(id), 0) FROM listen_events WHERE user_id = ?`, uid).Scan(&n, &maxID)
	s.co.mu.Lock()
	defer s.co.mu.Unlock()
	if s.co.m == nil {
		s.co.m = map[string]coEntry{}
	}
	if e, ok := s.co.m[uid]; ok && e.key == n*1_000_003+maxID {
		return e.sims
	}
	rows, err := s.db.Query(`SELECT track_id, started_at FROM listen_events WHERE user_id = ? AND (action != 'skip' OR played_ms >= 30000) ORDER BY started_at`, uid)
	if err != nil {
		return map[string]map[string]float64{}
	}
	type ev struct {
		id string
		at int64
	}
	evs := []ev{}
	for rows.Next() {
		var e ev
		if rows.Scan(&e.id, &e.at) == nil {
			evs = append(evs, e)
		}
	}
	rows.Close()

	co := map[string]map[string]float64{}
	count := map[string]float64{}
	add := func(a, b string, w float64) {
		if co[a] == nil {
			co[a] = map[string]float64{}
		}
		co[a][b] += w
	}
	start := 0
	for i := 1; i <= len(evs); i++ {
		if i == len(evs) || evs[i].at-evs[i-1].at > 30*60*1000 {
			sess := evs[start:i]
			for x := range sess {
				count[sess[x].id]++
				for y := x + 1; y < len(sess) && y <= x+6; y++ {
					if sess[x].id != sess[y].id {
						w := 1 / float64(y-x)
						add(sess[x].id, sess[y].id, w)
						add(sess[y].id, sess[x].id, w)
					}
				}
			}
			start = i
		}
	}
	for a, m := range co {
		for b, v := range m {
			m[b] = v / math.Sqrt(count[a]*count[b])
		}
	}
	s.co.m[uid] = coEntry{key: n*1_000_003 + maxID, sims: co}
	return co
}

// ── shared recommendation context ──────────────────────────────────────

type recCtx struct {
	uid      string
	lang     map[string]string  // track id → language
	langPref map[string]float64 // language → share of what the user likes
	all      []Track
	byID     map[string]Track
	taste    *taste
	similar  map[string][]ExtArtist // seed (loose) → similar artists
	co       map[string]map[string]float64
	inLib    map[string]bool // looseName(artist) present in library
}

func (s *Server) newRecCtx(ctx context.Context, uid string, fetch bool) (*recCtx, error) {
	all, err := s.libTracks(uid, "")
	if err != nil {
		return nil, err
	}
	t, err := s.buildTaste(uid, all)
	if err != nil {
		return nil, err
	}
	st := s.loadSettings(uid)
	// No history yet: start from the artists picked at onboarding.
	if len(t.seeds(1)) == 0 {
		for i, a := range st.PrefArtists {
			k := looseName(a)
			t.artist[k] = 1 - float64(i)*0.02
			t.display[k] = a
		}
	}
	rc := &recCtx{uid: uid, all: all, byID: map[string]Track{}, taste: t, similar: map[string][]ExtArtist{}, co: s.coListen(uid), inLib: map[string]bool{}}
	rc.lang = resolveLangs(all)
	rc.langPref = langPrefs(all, rc.lang, t, st)
	for _, tr := range all {
		rc.byID[tr.ID] = tr
		for _, a := range splitArtists(tr.Artist) {
			rc.inLib[looseName(a)] = true
		}
	}
	for _, seed := range t.seeds(8) {
		sim, err := s.ext.Similar(ctx, t.name(seed), !fetch)
		if err != nil {
			s.log.Debug("similar artists", "artist", seed, "err", err)
			continue
		}
		rc.similar[seed] = sim
	}
	return rc, nil
}

type RecTrack struct {
	Track
	Reason string  `json:"reason"`
	Score  float64 `json:"-"`
}

// forYou ranks library tracks: artist affinity (direct and via similar
// artists), co-listening with recent favourites, sound-alikes of loved tracks,
// a novelty bonus for rarely played tracks, and a penalty for very recent plays.
func (s *Server) forYou(rc *recCtx, n int) []RecTrack {
	t := rc.taste
	score := map[string]float64{}
	reason := map[string]string{}
	best := map[string]float64{}
	bump := func(id string, v float64, why string) {
		score[id] += v
		if v > best[id] {
			best[id], reason[id] = v, why
		}
	}

	// Affinity to similar artists (tier 1).
	simAff := map[string]float64{}
	simWhy := map[string]string{}
	for seed, list := range rc.similar {
		for _, a := range list {
			k := looseName(a.Name)
			v := t.artist[seed] * a.Match * 0.6
			if v > simAff[k] {
				simAff[k], simWhy[k] = v, "Giống "+t.name(seed)+", nghệ sĩ bạn hay nghe"
			}
		}
	}
	// Favourite tracks drive tier 2 and tier 3.
	favs := topTracks(t.track, 12)
	for _, tr := range rc.all {
		if t.trackDisliked(tr) {
			continue
		}
		for _, a := range splitArtists(tr.Artist) {
			k := looseName(a)
			if v := t.artist[k]; v > 0 {
				bump(tr.ID, v*0.5, "Vì bạn hay nghe "+t.name(k))
			}
			if v := simAff[k]; v > 0 {
				bump(tr.ID, v, simWhy[k])
			}
		}
	}
	for _, f := range favs {
		ft := rc.byID[f]
		for b, sim := range rc.co[f] {
			bump(b, sim*2, "Hay được nghe cùng “"+ft.Title+"”")
		}
		for _, nb := range s.audioNeighbors(f, 15) {
			if nb.Score > 0.5 {
				bump(nb.ID, (nb.Score-0.5)*3, "Âm thanh giống “"+ft.Title+"”")
			}
		}
	}
	now := time.Now().UnixMilli()
	out := []RecTrack{}
	for id, sc := range score {
		tr, ok := rc.byID[id]
		if !ok || t.trackDisliked(tr) {
			continue
		}
		if last := t.recent[id]; last > 0 {
			hours := float64(now-last) / 3.6e6
			sc -= 2 * math.Exp(-hours/24) // heard today: push down
		}
		if tr.PlayCount == 0 {
			sc += 0.4
			if reason[id] == "" {
				reason[id] = "Bạn chưa nghe bài này"
			}
		}
		sc *= rc.langFactor(id)
		if sc <= 0 {
			continue
		}
		out = append(out, RecTrack{Track: tr, Reason: reason[id], Score: sc})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Score > out[j].Score })
	// Keep variety: at most 3 tracks per artist in the list.
	perArtist := map[string]int{}
	res := []RecTrack{}
	for _, r := range out {
		k := looseName(r.Artist)
		if perArtist[k] >= 3 {
			continue
		}
		perArtist[k]++
		res = append(res, r)
		if len(res) == n {
			break
		}
	}
	return res
}

func topTracks(m map[string]float64, n int) []string {
	ids := []string{}
	for id, v := range m {
		if v > 0 {
			ids = append(ids, id)
		}
	}
	sort.Slice(ids, func(i, j int) bool { return m[ids[i]] > m[ids[j]] })
	if len(ids) > n {
		ids = ids[:n]
	}
	return ids
}

// ── discovery (outside the library) ────────────────────────────────────

type DiscoverArtist struct {
	Name      string  `json:"name"`
	Image     string  `json:"image"`
	Reason    string  `json:"reason"`
	InLibrary bool    `json:"inLibrary"`
	Score     float64 `json:"-"`
	best      float64
}

type DiscoverTrack struct {
	ExtTrack
	Reason string `json:"reason"`
	Query  string `json:"query"` // what to send to the downloader
}

func (s *Server) discoverArtists(rc *recCtx) []DiscoverArtist {
	t := rc.taste
	acc := map[string]*DiscoverArtist{}
	for seed, list := range rc.similar {
		for _, a := range list {
			k := looseName(a.Name)
			if k == seed || t.dislikedArt[k] {
				continue
			}
			v := math.Max(t.artist[seed], 0.1) * a.Match
			d := acc[k]
			if d == nil {
				d = &DiscoverArtist{Name: a.Name, Image: a.Image, InLibrary: rc.inLib[k]}
				acc[k] = d
			}
			if v > d.best { // reason = the seed that contributes most
				d.best, d.Reason = v, "Giống "+t.name(seed)
			}
			d.Score += v
			if d.Image == "" {
				d.Image = a.Image
			}
		}
	}
	out := []DiscoverArtist{}
	for _, d := range acc {
		out = append(out, *d)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Score > out[j].Score })
	return out
}

func (s *Server) handleDiscover(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
	defer cancel()
	rc, err := s.newRecCtx(ctx, userOf(r).ID, true)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if len(rc.taste.seeds(1)) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{"artists": []any{}, "tracks": []any{}, "provider": s.ext.provider(), "needHistory": true})
		return
	}
	artists := s.discoverArtists(rc)
	// Known titles, to hide tracks already downloaded.
	have := map[string]bool{}
	for _, tr := range rc.all {
		have[looseName(tr.Title)] = true
	}
	tracks := []DiscoverTrack{}
	newArtists := []DiscoverArtist{}
	failed := false
	for _, a := range artists {
		if !a.InLibrary {
			newArtists = append(newArtists, a)
		}
		if len(tracks) >= 36 || len(newArtists) > 14 && a.InLibrary {
			continue
		}
		top, err := s.ext.TopTracks(ctx, a.Name, false)
		if err != nil {
			failed = true
			if errors.Is(err, context.DeadlineExceeded) {
				break
			}
			continue
		}
		added := 0
		for _, tt := range top {
			if have[looseName(tt.Title)] || added == 3 {
				continue
			}
			tracks = append(tracks, DiscoverTrack{ExtTrack: tt, Reason: a.Reason, Query: tt.Artist + " - " + tt.Title})
			added++
		}
	}
	if len(newArtists) > 20 {
		newArtists = newArtists[:20]
	}
	resp := map[string]any{"artists": newArtists, "tracks": tracks, "provider": s.ext.provider()}
	if failed && len(tracks) == 0 {
		resp["error"] = errExtUnavailable.Error()
	}
	writeJSON(w, http.StatusOK, resp)
}

// handleForYou: in-library recommendations (fetches external data if missing).
func (s *Server) handleForYou(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	rc, err := s.newRecCtx(ctx, userOf(r).ID, true)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"tracks": s.forYou(rc, 50)})
}

// handleArtistSimilar: tier-1 similar artists for an artist page.
func (s *Server) handleArtistSimilar(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	if name == "" {
		httpError(w, http.StatusBadRequest, "Thiếu tên nghệ sĩ")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	list, err := s.ext.Similar(ctx, splitArtists(name)[0], false)
	if err != nil {
		httpError(w, http.StatusBadGateway, err.Error())
		return
	}
	artists, _ := s.listArtists(userOf(r).ID)
	lib := map[string]Artist{}
	for _, a := range artists {
		for _, p := range splitArtists(a.Name) {
			if _, ok := lib[looseName(p)]; !ok {
				lib[looseName(p)] = a
			}
		}
	}
	type item struct {
		Name        string `json:"name"`
		Image       string `json:"image"`
		LibraryName string `json:"libraryName"`
		CoverTrack  string `json:"coverTrackId"`
		TrackCount  int    `json:"trackCount"`
	}
	out := []item{}
	for _, a := range list {
		it := item{Name: a.Name, Image: a.Image}
		if la, ok := lib[looseName(a.Name)]; ok {
			it.LibraryName, it.CoverTrack, it.TrackCount = la.Name, la.CoverTrack, la.TrackCount
		}
		out = append(out, it)
	}
	writeJSON(w, http.StatusOK, map[string]any{"artists": out, "provider": s.ext.provider()})
}

// handleTrackSimilar: "Bài nghe giống" — tier 2 + tier 3 neighbours of one track.
func (s *Server) handleTrackSimilar(w http.ResponseWriter, r *http.Request) {
	uid := userOf(r).ID
	id := r.PathValue("id")
	seed, err := s.getTrack(uid, id)
	if err != nil {
		httpError(w, http.StatusNotFound, "Không có bài này")
		return
	}
	all, err := s.libTracks(uid, "")
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	byID := map[string]Track{}
	for _, t := range all {
		byID[t.ID] = t
	}
	score := map[string]float64{}
	why := map[string]string{}
	for b, v := range s.coListen(uid)[id] {
		score[b] += v * 2
		why[b] = "Hay được nghe cùng"
	}
	for _, nb := range s.audioNeighbors(id, 30) {
		score[nb.ID] += nb.Score
		if why[nb.ID] == "" {
			why[nb.ID] = "Âm thanh giống"
		}
	}
	out := []RecTrack{}
	for b, sc := range score {
		if t, ok := byID[b]; ok && sc > 0 {
			out = append(out, RecTrack{Track: t, Reason: why[b], Score: sc})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Score > out[j].Score })
	if len(out) > 30 {
		out = out[:30]
	}
	f := s.loadFeatures()
	writeJSON(w, http.StatusOK, map[string]any{"seed": seed, "tracks": out, "featuresPending": f.pending})
}

// ── feedback ────────────────────────────────────────────────────────────

func (s *Server) handleFeedback(w http.ResponseWriter, r *http.Request) {
	uid := userOf(r).ID
	var body struct {
		Kind  string `json:"kind"`
		Key   string `json:"key"`
		Value int    `json:"value"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if (body.Kind != "artist" && body.Kind != "track") || strings.TrimSpace(body.Key) == "" || body.Value < -1 || body.Value > 1 {
		httpError(w, http.StatusBadRequest, "Phản hồi không hợp lệ")
		return
	}
	key := body.Key
	if body.Kind == "artist" {
		key = looseName(key)
	}
	var err error
	if body.Value == 0 {
		_, err = s.db.Exec(`DELETE FROM feedback WHERE user_id = ? AND kind = ? AND key = ?`, uid, body.Kind, key)
	} else {
		_, err = s.db.Exec(`INSERT INTO feedback(user_id, kind, key, value, created_at) VALUES (?,?,?,?,?)
			ON CONFLICT(user_id, kind, key) DO UPDATE SET value = excluded.value, created_at = excluded.created_at`, uid, body.Kind, key, body.Value, nowMs())
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ── mixes & radio built on the recommenders ────────────────────────────

// dailyMixes: one mix per top seed artist — the seed's tracks, tracks by its
// similar artists in the library, co-listened tracks and sound-alikes —
// shuffled with a per-day seed so a mix stays stable for the day.
func (s *Server) dailyMixes(rc *recCtx, n int) []Mix {
	t := rc.taste
	day := time.Now().Format("2006-01-02")
	mixes := []Mix{}
	used := map[string]bool{}
	for _, seed := range t.seeds(12) {
		if len(mixes) == n || used[seed] {
			continue
		}
		related := map[string]float64{seed: 1}
		for _, a := range rc.similar[seed] {
			related[looseName(a.Name)] = a.Match
		}
		score := map[string]float64{}
		for _, tr := range rc.all {
			if t.trackDisliked(tr) {
				continue
			}
			for _, a := range splitArtists(tr.Artist) {
				if v, ok := related[looseName(a)]; ok {
					score[tr.ID] = math.Max(score[tr.ID], v)
				}
			}
		}
		seedTracks := []string{}
		for id, v := range score {
			if v == 1 {
				seedTracks = append(seedTracks, id)
			}
		}
		for _, id := range seedTracks {
			for b, v := range rc.co[id] {
				score[b] += v * 0.5
			}
			for _, nb := range s.audioNeighbors(id, 5) {
				if nb.Score > 0.6 {
					score[nb.ID] += (nb.Score - 0.6)
				}
			}
		}
		// One language per mix: the seed artist's.
		langN := map[string]int{}
		for _, id := range seedTracks {
			if l := rc.lang[id]; l != "" {
				langN[l]++
			}
		}
		mixLang, best := "", 0
		for l, n := range langN {
			if n > best {
				mixLang, best = l, n
			}
		}
		for id := range score {
			if !sameLang(mixLang, rc.lang[id]) {
				delete(score, id)
			}
		}
		if len(score) < 5 {
			continue
		}
		rng := rand.New(rand.NewPCG(hashSeed(day, seed), 7))
		ids := []string{}
		for id := range score {
			ids = append(ids, id)
		}
		keys := map[string]float64{}
		for _, id := range ids {
			keys[id] = (0.5 + score[id]) * rng.Float64()
		}
		sort.Slice(ids, func(i, j int) bool { return keys[ids[i]] > keys[ids[j]] })
		if len(ids) > 40 {
			ids = ids[:40]
		}
		tracks := []Track{}
		for _, id := range ids {
			if tr, ok := rc.byID[id]; ok { // sound-alikes may be other users' tracks
				tracks = append(tracks, tr)
			}
		}
		used[seed] = true
		mixes = append(mixes, Mix{ID: seed, Name: "Mix " + strconv.Itoa(len(mixes)+1), Reason: "Vì bạn hay nghe " + t.name(seed), Tracks: tracks})
	}
	return mixes
}
