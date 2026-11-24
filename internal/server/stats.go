package server

import (
	"hash/fnv"
	"math"
	"math/rand/v2"
	"net/http"
	"slices"
	"sort"
	"strconv"
	"time"
)

// ── listen events ───────────────────────────────────────────────────────

func (s *Server) handleListen(w http.ResponseWriter, r *http.Request) {
	uid := userOf(r).ID
	var body struct {
		TrackID   string `json:"trackId"`
		PlayedMs  int64  `json:"playedMs"`
		Action    string `json:"action"`
		Source    string `json:"source"`
		StartedAt int64  `json:"startedAt"`
		Hour      *int   `json:"hour"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	switch body.Action {
	case "finish", "skip", "repeat":
	default:
		httpError(w, http.StatusBadRequest, "action không hợp lệ")
		return
	}
	now := nowMs()
	if body.StartedAt <= 0 || body.StartedAt > now {
		body.StartedAt = now
	}
	body.PlayedMs = max(0, min(body.PlayedMs, 6*3600*1000))
	hour := time.UnixMilli(body.StartedAt).Hour()
	if body.Hour != nil && *body.Hour >= 0 && *body.Hour <= 23 {
		hour = *body.Hour // client's local hour
	}
	if len(body.Source) > 100 {
		body.Source = body.Source[:100]
	}
	res, err := s.db.Exec(`INSERT INTO listen_events(user_id, track_id, started_at, played_ms, action, hour, source)
		SELECT user_id, track_id, ?, ?, ?, ?, ? FROM user_tracks WHERE user_id = ? AND track_id = ?`,
		body.StartedAt, body.PlayedMs, body.Action, hour, body.Source, uid, body.TrackID)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		httpError(w, http.StatusNotFound, "Không có bài này")
		return
	}
	if body.Action != "skip" || body.PlayedMs >= 30000 {
		s.db.Exec(`UPDATE user_tracks SET play_count = play_count + 1, last_played_at = ? WHERE user_id = ? AND track_id = ?`, now, uid, body.TrackID)
	} else {
		s.db.Exec(`UPDATE user_tracks SET last_played_at = ? WHERE user_id = ? AND track_id = ?`, now, uid, body.TrackID)
	}
	w.WriteHeader(http.StatusNoContent)
}

type HistoryItem struct {
	Track     Track  `json:"track"`
	StartedAt int64  `json:"startedAt"`
	PlayedMs  int64  `json:"playedMs"`
	Action    string `json:"action"`
}

func (s *Server) handleHistory(w http.ResponseWriter, r *http.Request) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	out, err := s.historyFor(userOf(r).ID, limit)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// historyFor lists a user's latest listens (also used by the admin page).
func (s *Server) historyFor(uid string, limit int) ([]HistoryItem, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	type ev struct {
		tid        string
		at, played int64
		action     string
	}
	rows, err := s.db.Query(`SELECT track_id, started_at, played_ms, action FROM listen_events WHERE user_id = ? ORDER BY started_at DESC LIMIT ?`, uid, limit)
	if err != nil {
		return nil, err
	}
	evs := []ev{}
	for rows.Next() {
		var e ev
		if rows.Scan(&e.tid, &e.at, &e.played, &e.action) == nil {
			evs = append(evs, e)
		}
	}
	rows.Close()
	all, err := s.libTracks(uid, "")
	if err != nil {
		return nil, err
	}
	byID := map[string]Track{}
	for _, t := range all {
		byID[t.ID] = t
	}
	out := []HistoryItem{}
	for _, e := range evs {
		if t, ok := byID[e.tid]; ok {
			out = append(out, HistoryItem{Track: t, StartedAt: e.at, PlayedMs: e.played, Action: e.action})
		}
	}
	return out, nil
}

type countedTrack struct {
	Track
	Plays int `json:"plays"`
}

type countedArtist struct {
	Name       string `json:"name"`
	Plays      int    `json:"plays"`
	CoverTrack string `json:"coverTrackId"`
}

// handleStats aggregates listening over the last N days, bucketed by the client's local day.
func (s *Server) handleStats(w http.ResponseWriter, r *http.Request) {
	days, _ := strconv.Atoi(r.URL.Query().Get("days"))
	tzMin, _ := strconv.Atoi(r.URL.Query().Get("tz")) // JS getTimezoneOffset(): UTC - local, minutes
	out, err := s.statsFor(userOf(r).ID, days, tzMin)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// statsFor aggregates one user's listening (also used by the admin page).
func (s *Server) statsFor(uid string, days, tzMin int) (map[string]any, error) {
	if days <= 0 || days > 366 {
		days = 7
	}
	loc := time.FixedZone("client", -tzMin*60)
	now := time.Now().In(loc)
	startDay := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, loc).AddDate(0, 0, -(days - 1))

	rows, err := s.db.Query(`SELECT track_id, started_at, played_ms, action FROM listen_events WHERE user_id = ? AND started_at >= ?`, uid, startDay.UnixMilli())
	if err != nil {
		return nil, err
	}
	type ev struct {
		tid    string
		at, ms int64
		action string
	}
	evs := []ev{}
	for rows.Next() {
		var e ev
		if rows.Scan(&e.tid, &e.at, &e.ms, &e.action) == nil {
			evs = append(evs, e)
		}
	}
	rows.Close()
	all, err := s.libTracks(uid, "")
	if err != nil {
		return nil, err
	}
	byID := map[string]Track{}
	for _, t := range all {
		byID[t.ID] = t
	}

	type day struct {
		Date    string  `json:"date"`
		Minutes float64 `json:"minutes"`
	}
	buckets := make([]day, days)
	for i := range buckets {
		buckets[i].Date = startDay.AddDate(0, 0, i).Format("2006-01-02")
	}
	trackPlays := map[string]int{}
	artistPlays := map[string]int{}
	artistCover := map[string]string{}
	var totalMs int64
	plays, skips := 0, 0
	hours := make([]int, 24)
	for _, e := range evs {
		t := time.UnixMilli(e.at).In(loc)
		idx := int(t.Sub(startDay).Hours() / 24)
		if idx >= 0 && idx < days {
			buckets[idx].Minutes += float64(e.ms) / 60000
		}
		totalMs += e.ms
		counted := e.action != "skip" || e.ms >= 30000
		if !counted {
			skips++
			continue
		}
		plays++
		hours[t.Hour()]++
		trackPlays[e.tid]++
		if tr, ok := byID[e.tid]; ok && tr.Artist != "" {
			artistPlays[tr.Artist]++
			if tr.HasCover && artistCover[tr.Artist] == "" {
				artistCover[tr.Artist] = tr.ID
			}
		}
	}
	for i := range buckets {
		buckets[i].Minutes = math.Round(buckets[i].Minutes*10) / 10
	}
	topTracks := []countedTrack{}
	for id, n := range trackPlays {
		if t, ok := byID[id]; ok {
			topTracks = append(topTracks, countedTrack{t, n})
		}
	}
	sort.Slice(topTracks, func(i, j int) bool { return topTracks[i].Plays > topTracks[j].Plays })
	if len(topTracks) > 20 {
		topTracks = topTracks[:20]
	}
	topArtists := []countedArtist{}
	for a, n := range artistPlays {
		topArtists = append(topArtists, countedArtist{a, n, artistCover[a]})
	}
	sort.Slice(topArtists, func(i, j int) bool { return topArtists[i].Plays > topArtists[j].Plays })
	if len(topArtists) > 10 {
		topArtists = topArtists[:10]
	}
	return map[string]any{
		"days": buckets, "totalMinutes": math.Round(float64(totalMs) / 60000), "plays": plays, "skips": skips,
		"topTracks": topTracks, "topArtists": topArtists, "hours": hours, "libraryCount": len(all),
	}, nil
}

// ── home & simple recommendations ──────────────────────────────────────
//
// These are heuristics over the local listening history (no external data):
// enough to make the home page useful before the V2 recommender exists.

type Mix struct {
	ID     string  `json:"id"`
	Name   string  `json:"name"`
	Reason string  `json:"reason"`
	Tracks []Track `json:"tracks"`
}

func hashSeed(parts ...string) uint64 {
	h := fnv.New64a()
	for _, p := range parts {
		h.Write([]byte(p))
		h.Write([]byte{0})
	}
	return h.Sum64()
}

func (s *Server) handleHome(w http.ResponseWriter, r *http.Request) {
	uid := userOf(r).ID
	all, err := s.libTracks(uid, `ORDER BY ut.added_at DESC`)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	// Send each track's resolved language (artist majority beats a weak
	// title guess) so the client can keep a queue in one language.
	langs := resolveLangs(all)
	byID := map[string]Track{}
	for i := range all {
		all[i].Lang = langs[all[i].ID]
		byID[all[i].ID] = all[i]
	}

	// Continue listening: most recent distinct tracks.
	rows, err := s.db.Query(`SELECT track_id FROM listen_events WHERE user_id = ? GROUP BY track_id ORDER BY MAX(started_at) DESC LIMIT 12`, uid)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	recentIDs, err := scanStrings(rows)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	cont := []Track{}
	for _, id := range recentIDs {
		if t, ok := byID[id]; ok {
			cont = append(cont, t)
		}
	}

	recent := all
	if len(recent) > 12 {
		recent = recent[:12]
	}

	// Top artists over 30 days, falling back to library size.
	since := nowMs() - 30*24*3600*1000
	type ac struct {
		name  string
		score float64
	}
	scores := map[string]float64{}
	rows, err = s.db.Query(`SELECT t.artist, COUNT(*) FROM listen_events e JOIN tracks t ON t.id = e.track_id
		WHERE e.user_id = ? AND e.started_at >= ? AND t.artist != '' AND (e.action != 'skip' OR e.played_ms >= 30000) GROUP BY t.artist`, uid, since)
	if err == nil {
		for rows.Next() {
			var a string
			var n float64
			if rows.Scan(&a, &n) == nil {
				scores[a] += n * 10
			}
		}
		rows.Close()
	}
	for _, t := range all {
		if t.Artist != "" {
			scores[t.Artist] += 1
			if t.Liked {
				scores[t.Artist] += 3
			}
		}
	}
	ranked := []ac{}
	for a, sc := range scores {
		ranked = append(ranked, ac{a, sc})
	}
	sort.Slice(ranked, func(i, j int) bool { return ranked[i].score > ranked[j].score })
	artists, _ := s.listArtists(uid)
	artistByName := map[string]Artist{}
	for _, a := range artists {
		artistByName[a.Name] = a
	}
	topArtists := []Artist{}
	for _, a := range ranked {
		if ar, ok := artistByName[a.name]; ok {
			topArtists = append(topArtists, ar)
		}
		if len(topArtists) == 10 {
			break
		}
	}

	// V2 recommenders, from cached external data only so the page stays fast;
	// missing similar-artist data is fetched in the background.
	mixes := []Mix{}
	forYou := []RecTrack{}
	var similar map[string]any
	rc, rcErr := s.newRecCtx(r.Context(), uid, false)
	if rcErr == nil {
		mixes = s.dailyMixes(rc, 4)
		forYou = s.forYou(rc, 20)
		for i := range forYou {
			forYou[i].Lang = langs[forYou[i].ID]
		}
		seeds := rc.taste.seeds(8)
		if len(rc.similar) < len(seeds) {
			go s.warmRecs(uid)
		}
		for _, seed := range seeds {
			list := []map[string]any{}
			for _, a := range rc.similar[seed] {
				list = append(list, map[string]any{"name": a.Name, "image": a.Image, "inLibrary": rc.inLib[looseName(a.Name)]})
				if len(list) == 12 {
					break
				}
			}
			if len(list) >= 3 {
				similar = map[string]any{"seed": rc.taste.name(seed), "artists": list}
				break
			}
		}
	}

	// Fallback mixes (no listening history yet): one per artist, seeded by date.
	day := time.Now().Format("2006-01-02")
	for i, a := range topArtists {
		if len(mixes) == 4 {
			break
		}
		if a.TrackCount < 2 && len(all) < 8 {
			continue
		}
		rng := rand.New(rand.NewPCG(hashSeed(day, a.Name), uint64(i)))
		tracks := buildMix(all, a.Name, rng, 30)
		if rcErr == nil {
			tracks = slices.DeleteFunc(tracks, rc.taste.trackDisliked)
			tracks = rc.taste.dropRecent(tracks, 10)
		}
		if len(tracks) < 4 {
			continue
		}
		mixes = append(mixes, Mix{ID: strconv.Itoa(i + 1), Name: "Mix " + strconv.Itoa(len(mixes)+1), Reason: "Vì bạn hay nghe " + a.Name, Tracks: tracks})
	}

	// Time of day: what you play around this hour.
	hour := time.Now().Hour()
	if hs := r.URL.Query().Get("hour"); hs != "" {
		if h, err := strconv.Atoi(hs); err == nil && h >= 0 && h < 24 {
			hour = h
		}
	}
	label, cond := partOfDay(hour)
	rows, err = s.db.Query(`SELECT track_id FROM listen_events WHERE user_id = ? AND `+cond+` AND (action != 'skip' OR played_ms >= 30000)
		GROUP BY track_id ORDER BY COUNT(*) DESC LIMIT 12`, uid)
	todIDs := []string{}
	if err == nil {
		todIDs, _ = scanStrings(rows)
	}
	tod := []Track{}
	for _, id := range todIDs {
		if t, ok := byID[id]; ok {
			tod = append(tod, t)
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"continue": cont, "recentlyAdded": recent, "topArtists": topArtists, "mixes": mixes,
		"timeOfDay": map[string]any{"label": label, "tracks": tod}, "libraryCount": len(all),
		"forYou": forYou, "similarArtists": similar,
	})
}

func partOfDay(h int) (label, cond string) {
	switch {
	case h >= 5 && h < 11:
		return "Hay nghe buổi sáng", "hour >= 5 AND hour < 11"
	case h >= 11 && h < 17:
		return "Hay nghe buổi chiều", "hour >= 11 AND hour < 17"
	case h >= 17 && h < 22:
		return "Hay nghe buổi tối", "hour >= 17 AND hour < 22"
	default:
		return "Hay nghe đêm khuya", "(hour >= 22 OR hour < 5)"
	}
}

// buildMix interleaves the seed artist's tracks with weighted picks from the rest.
func buildMix(all []Track, artist string, rng *rand.Rand, n int) []Track {
	own, rest := []Track{}, []Track{}
	for _, t := range all {
		if t.Artist == artist {
			own = append(own, t)
		} else {
			rest = append(rest, t)
		}
	}
	weight := func(t Track) float64 {
		w := 1 + math.Log1p(float64(t.PlayCount))
		if t.Liked {
			w += 1.5
		}
		return w * rng.Float64()
	}
	shuffleWeighted(own, weight)
	shuffleWeighted(rest, weight)
	out := []Track{}
	oi, ri := 0, 0
	for len(out) < n && (oi < len(own) || ri < len(rest)) {
		// roughly 1 seed-artist track for every 2 others
		if oi < len(own) && (len(out)%3 == 0 || ri >= len(rest)) {
			out = append(out, own[oi])
			oi++
		} else if ri < len(rest) {
			out = append(out, rest[ri])
			ri++
		}
	}
	return out
}

func shuffleWeighted(ts []Track, key func(Track) float64) {
	k := make(map[string]float64, len(ts))
	for _, t := range ts {
		k[t.ID] = key(t)
	}
	sort.SliceStable(ts, func(i, j int) bool { return k[ts[i].ID] > k[ts[j].ID] })
}

// handleRadio builds a queue around one track from all three tiers: same
// artist, similar artists in the library (tier 1), co-listened tracks (tier 2)
// and sound-alikes (tier 3), sampled with weights so each radio differs.
func (s *Server) handleRadio(w http.ResponseWriter, r *http.Request) {
	uid := userOf(r).ID
	seed, err := s.getTrack(uid, r.URL.Query().Get("seed"))
	if err != nil {
		httpError(w, http.StatusNotFound, "Không có bài này")
		return
	}
	rc, err := s.newRecCtx(r.Context(), uid, false)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	score := map[string]float64{}
	seedArtists := map[string]bool{}
	for _, a := range splitArtists(seed.Artist) {
		seedArtists[looseName(a)] = true
	}
	// Autoplay asks with autoplay=1: only real matches (no random filler), so
	// there is room for new songs.
	forAutoplay := r.URL.Query().Get("autoplay") == "1"
	seedKind := kindOf(seed.Title, seed.DurationMs)
	styles := librarySongStyles(rc.all)
	seedStyle := styles[seed.ID]
	related := map[string]float64{}
	for _, a := range splitArtists(seed.Artist) {
		list, _ := s.ext.Similar(r.Context(), a, false)
		for _, x := range list {
			related[looseName(x.Name)] = math.Max(related[looseName(x.Name)], x.Match)
		}
	}
	for _, t := range rc.all {
		if t.ID == seed.ID || rc.taste.trackDisliked(t) {
			continue
		}
		for _, a := range splitArtists(t.Artist) {
			k := looseName(a)
			if seedArtists[k] {
				score[t.ID] += 0.8
			} else if m, ok := related[k]; ok {
				score[t.ID] += 0.7 * m
			}
		}
		if seed.Album != "" && t.Album == seed.Album {
			score[t.ID] += 0.3
		}
		score[t.ID] += 0.1 * math.Max(rc.taste.track[t.ID], 0) // a little of what you like
	}
	for b, v := range rc.co[seed.ID] {
		score[b] += v * 2
	}
	for _, nb := range s.audioNeighbors(seed.ID, 40) {
		if nb.Score > 0.3 {
			score[nb.ID] += nb.Score
		}
	}
	// One language per radio: start a Vietnamese song, get Vietnamese songs;
	// a Japanese one, Japanese songs.
	seedLang := rc.lang[seed.ID]
	for id := range score {
		if !sameLang(seedLang, rc.lang[id]) {
			delete(score, id)
			continue
		}
		// Same kind (no lofi mixes after a 4-minute song) and close style
		// (no V-pop after bolero), when the genres are known.
		if t, ok := rc.byID[id]; ok {
			if !kindCompatible(seedKind, kindOf(t.Title, t.DurationMs)) {
				delete(score, id)
				continue
			}
			score[id] *= styleFactor(seedStyle, styles[id])
		}
	}
	// A clearly different style (bolero → V-pop) is left out entirely as long
	// as enough songs of a close style remain.
	close := 0
	for id := range score {
		if !styleConflict(seedStyle, styles[id]) {
			close++
		}
	}
	if close >= 5 {
		for id := range score {
			if styleConflict(seedStyle, styles[id]) {
				delete(score, id)
			}
		}
	}
	rng := rand.New(rand.NewPCG(uint64(time.Now().UnixNano()), hashSeed(seed.ID)))
	ids := []string{}
	keys := map[string]float64{}
	for id, sc := range score {
		if sc <= 0 {
			continue
		}
		ids = append(ids, id)
		keys[id] = math.Pow(rng.Float64(), 1/sc) // weighted sampling without replacement
	}
	sort.Slice(ids, func(i, j int) bool { return keys[ids[i]] > keys[ids[j]] })
	out := []Track{*seed}
	for _, id := range ids {
		if len(out) == 50 {
			break
		}
		// Sound-alikes and co-listens come from every user's tracks: keep only
		// what is in this user's library (an empty track breaks the queue).
		if tr, ok := rc.byID[id]; ok {
			out = append(out, tr)
		}
	}
	// Small library or no signal yet: pad with the rest, shuffled (not for
	// autoplay, which fills the gap with new songs instead).
	if len(out) < 20 && !forAutoplay {
		in := map[string]bool{}
		for _, t := range out {
			in[t.ID] = true
		}
		rest := []Track{}
		for _, t := range rc.all {
			if !in[t.ID] && !rc.taste.trackDisliked(t) && sameLang(seedLang, rc.lang[t.ID]) &&
				kindCompatible(seedKind, kindOf(t.Title, t.DurationMs)) && !styleConflict(seedStyle, styles[t.ID]) {
				rest = append(rest, t)
			}
		}
		rng.Shuffle(len(rest), func(i, j int) { rest[i], rest[j] = rest[j], rest[i] })
		for _, t := range rest {
			if len(out) == 50 {
				break
			}
			out = append(out, t)
		}
	}
	// Nothing played to the end in the last 3 hours (the seed stays first).
	out = append([]Track{out[0]}, rc.taste.dropRecent(out[1:], 10)...)
	writeJSON(w, http.StatusOK, map[string]any{"name": "Radio: " + seed.Title, "tracks": out, "discover": s.discoverCount(len(rc.all))})
}
