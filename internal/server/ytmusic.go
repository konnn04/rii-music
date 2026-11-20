package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"

	"vang/internal/textutil"
)

// YouTube Music search through its InnerTube endpoint, the same one
// ytmusicapi and youtubei.js call. Unlike "ytsearch" through yt-dlp it answers
// in well under a second and, filtered to songs, returns only music with
// proper artist / album / duration fields and square covers.

const (
	ytmEndpoint      = "https://music.youtube.com/youtubei/v1/search?prettyPrint=false"
	ytmClientVersion = "1.20251110.01.00"
	// Search filters ("params") as sent by the YouTube Music web client.
	ytmFilterSongs     = "EgWKAQIIAWoMEA4QChADEAQQCRAF"
	ytmFilterVideos    = "EgWKAQIQAWoMEA4QChADEAQQCRAF"
	ytmFilterAlbums    = "EgWKAQIYAWoMEA4QChADEAQQCRAF"
	ytmFilterPlaylists = "EgeKAQQoAEABagwQDhAKEAMQBBAJEAU=" // community playlists
)

var ytmFilters = map[string]string{
	"songs": ytmFilterSongs, "videos": ytmFilterVideos, "albums": ytmFilterAlbums, "playlists": ytmFilterPlaylists,
}

var (
	ytmDurationRe = regexp.MustCompile(`^\d{1,2}(:\d{2}){1,2}$`)
	ytmThumbSize  = regexp.MustCompile(`=w\d+-h\d+[^/]*$`)
)

type ytmRun struct {
	Text               string `json:"text"`
	NavigationEndpoint *struct {
		WatchEndpoint *struct {
			VideoID string `json:"videoId"`
		} `json:"watchEndpoint"`
		BrowseEndpoint *struct {
			BrowseID string `json:"browseId"`
			Config   struct {
				Page struct {
					PageType string `json:"pageType"`
				} `json:"browseEndpointContextMusicConfig"`
			} `json:"browseEndpointContextSupportedConfigs"`
		} `json:"browseEndpoint"`
	} `json:"navigationEndpoint"`
}

type ytmItem struct {
	FixedColumns []struct {
		Col struct {
			Text struct {
				Runs []ytmRun `json:"runs"`
			} `json:"text"`
		} `json:"musicResponsiveListItemFixedColumnRenderer"`
	} `json:"fixedColumns"`
	FlexColumns []struct {
		Col struct {
			Text struct {
				Runs []ytmRun `json:"runs"`
			} `json:"text"`
		} `json:"musicResponsiveListItemFlexColumnRenderer"`
	} `json:"flexColumns"`
	Overlay struct {
		R struct {
			Content struct {
				Button struct {
					Play struct {
						WatchPlaylist *struct {
							PlaylistID string `json:"playlistId"`
						} `json:"watchPlaylistEndpoint"`
					} `json:"playNavigationEndpoint"`
				} `json:"musicPlayButtonRenderer"`
			} `json:"content"`
		} `json:"musicItemThumbnailOverlayRenderer"`
	} `json:"overlay"`
	NavigationEndpoint *struct {
		BrowseEndpoint *struct {
			BrowseID string `json:"browseId"`
		} `json:"browseEndpoint"`
	} `json:"navigationEndpoint"`
	PlaylistItemData *struct {
		VideoID string `json:"videoId"`
	} `json:"playlistItemData"`
	Thumbnail struct {
		R struct {
			Thumbnail struct {
				Thumbnails []struct {
					URL   string `json:"url"`
					Width int    `json:"width"`
				} `json:"thumbnails"`
			} `json:"thumbnail"`
		} `json:"musicThumbnailRenderer"`
	} `json:"thumbnail"`
}

// ytmSearch returns songs, videos, albums or playlists (kind).
func ytmSearch(ctx context.Context, hc *http.Client, q, kind string) ([]WebResult, error) {
	params, ok := ytmFilters[kind]
	if !ok {
		kind, params = "songs", ytmFilterSongs
	}
	body, _ := json.Marshal(map[string]any{
		"context": map[string]any{"client": map[string]any{
			"clientName": "WEB_REMIX", "clientVersion": ytmClientVersion, "hl": "vi", "gl": "VN", // "en" mangles Vietnamese queries

		}},
		"query":  q,
		"params": params,
	})
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, ytmEndpoint, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "https://music.youtube.com")
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36")
	res, err := hc.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("YouTube Music trả %s", res.Status)
	}
	var raw any
	if err := json.NewDecoder(res.Body).Decode(&raw); err != nil {
		return nil, err
	}
	out := []WebResult{}
	seen := map[string]bool{}
	for _, it := range collectYTMItems(raw) {
		parse := parseYTMItem
		if kind == "albums" || kind == "playlists" {
			parse = parseYTMCollection
		}
		if r, ok := parse(it, kind); ok && !seen[r.ID] {
			seen[r.ID] = true
			out = append(out, r)
		}
	}
	return out, nil
}

// collectYTMItems finds every musicResponsiveListItemRenderer in the response;
// walking the tree is sturdier than following YouTube's exact nesting.
func collectYTMItems(v any) []ytmItem {
	var items []ytmItem
	var walk func(any)
	walk = func(v any) {
		switch t := v.(type) {
		case map[string]any:
			if r, ok := t["musicResponsiveListItemRenderer"]; ok {
				b, _ := json.Marshal(r)
				var it ytmItem
				if json.Unmarshal(b, &it) == nil {
					items = append(items, it)
				}
				return
			}
			for _, c := range t {
				walk(c)
			}
		case []any:
			for _, c := range t {
				walk(c)
			}
		}
	}
	walk(v)
	return items
}

func parseYTMItem(it ytmItem, kind string) (WebResult, bool) {
	if len(it.FlexColumns) < 2 {
		return WebResult{}, false
	}
	titleRuns := it.FlexColumns[0].Col.Text.Runs
	var id string
	if it.PlaylistItemData != nil {
		id = it.PlaylistItemData.VideoID
	}
	if id == "" && len(titleRuns) > 0 && titleRuns[0].NavigationEndpoint != nil && titleRuns[0].NavigationEndpoint.WatchEndpoint != nil {
		id = titleRuns[0].NavigationEndpoint.WatchEndpoint.VideoID
	}
	if !videoIDRe.MatchString(id) {
		return WebResult{}, false
	}
	var title strings.Builder
	for _, r := range titleRuns {
		title.WriteString(r.Text)
	}

	// Second column: "Artist & Artist • Album • 3:45" (songs) or
	// "Artist • 12M views • 3:45" (videos), as runs split by " • ".
	var groups [][]ytmRun
	cur := []ytmRun{}
	for _, r := range it.FlexColumns[1].Col.Text.Runs {
		if strings.TrimSpace(r.Text) == "•" {
			groups = append(groups, cur)
			cur = []ytmRun{}
			continue
		}
		cur = append(cur, r)
	}
	groups = append(groups, cur)
	// Artists are the group linking to an artist page or channel; usually the
	// first, but some rows lead with a type label or an upload date.
	ag := 0
	for gi, g := range groups {
		if hasArtistLink(g) {
			ag = gi
			break
		}
	}
	var artists []string
	for _, r := range groups[ag] {
		t := strings.TrimSpace(r.Text)
		if t != "" && t != "&" && t != "," && t != "và" && t != "and" {
			artists = append(artists, t)
		}
	}
	var album string
	var duration float64
	for gi, g := range groups {
		if gi == ag {
			continue
		}
		text := strings.TrimSpace(joinRuns(g))
		switch {
		case ytmDurationRe.MatchString(text):
			duration = parseClock(text)
		case len(g) == 1 && pageType(g[0]) == "MUSIC_PAGE_TYPE_ALBUM":
			album = text
		}
	}

	thumb := ""
	if th := it.Thumbnail.R.Thumbnail.Thumbnails; len(th) > 0 {
		thumb = th[len(th)-1].URL
		if strings.Contains(thumb, "googleusercontent.com") {
			thumb = ytmThumbSize.ReplaceAllString(thumb, "=w240-h240-l90-rj")
		}
	}
	if kind == "videos" || thumb == "" {
		thumb = "https://i.ytimg.com/vi/" + id + "/mqdefault.jpg"
	}
	artist := strings.Join(artists, ", ")
	return WebResult{
		ID: id, Title: title.String(), Channel: artist, Artist: artist, Album: album, Duration: duration,
		Thumbnail: thumb, URL: "https://music.youtube.com/watch?v=" + id, Kind: kind,
	}, true
}

// parseYTMCollection reads an album ("Album • Artist • 2017") or playlist
// ("Owner • 1,2 Tr lượt xem") row. ID is the playlist id yt-dlp downloads.
func parseYTMCollection(it ytmItem, kind string) (WebResult, bool) {
	if len(it.FlexColumns) < 2 {
		return WebResult{}, false
	}
	var id string
	if wp := it.Overlay.R.Content.Button.Play.WatchPlaylist; wp != nil {
		id = wp.PlaylistID
	}
	if id == "" && kind == "playlists" && it.NavigationEndpoint != nil && it.NavigationEndpoint.BrowseEndpoint != nil {
		id = strings.TrimPrefix(it.NavigationEndpoint.BrowseEndpoint.BrowseID, "VL")
	}
	if !listIDRe.MatchString(id) {
		return WebResult{}, false
	}
	var owner, meta []string
	for _, r := range it.FlexColumns[1].Col.Text.Runs {
		t := strings.TrimSpace(r.Text)
		switch {
		case t == "" || t == "•" || t == "&" || t == "," || t == "và":
		case r.NavigationEndpoint != nil && r.NavigationEndpoint.BrowseEndpoint != nil:
			owner = append(owner, t)
		default:
			meta = append(meta, strings.ReplaceAll(t, " ", " "))
		}
	}
	thumb := ""
	if th := it.Thumbnail.R.Thumbnail.Thumbnails; len(th) > 0 {
		thumb = th[len(th)-1].URL
		if strings.Contains(thumb, "googleusercontent.com") {
			thumb = ytmThumbSize.ReplaceAllString(thumb, "=w240-h240-l90-rj")
		}
	}
	artist := strings.Join(owner, ", ")
	if artist == "" && len(meta) > 1 { // artist without a channel link
		artist, meta = meta[1], append(meta[:1:1], meta[2:]...)
	}
	return WebResult{
		ID: id, Title: joinRuns(it.FlexColumns[0].Col.Text.Runs), Channel: artist, Artist: artist,
		Album: strings.Join(meta, " · "), Thumbnail: thumb,
		URL: "https://music.youtube.com/playlist?list=" + id, Kind: kind,
	}, true
}

func joinRuns(rs []ytmRun) string {
	var b strings.Builder
	for _, r := range rs {
		b.WriteString(r.Text)
	}
	return b.String()
}

func hasArtistLink(g []ytmRun) bool {
	for _, r := range g {
		if r.NavigationEndpoint != nil && r.NavigationEndpoint.BrowseEndpoint != nil && pageType(r) != "MUSIC_PAGE_TYPE_ALBUM" {
			return true
		}
	}
	return false
}

func pageType(r ytmRun) string {
	if r.NavigationEndpoint == nil || r.NavigationEndpoint.BrowseEndpoint == nil {
		return ""
	}
	return r.NavigationEndpoint.BrowseEndpoint.Config.Page.PageType
}

// parseClock turns "3:45" or "1:02:03" into seconds.
func parseClock(s string) float64 {
	var total float64
	for _, p := range strings.Split(s, ":") {
		n := 0
		for _, c := range p {
			n = n*10 + int(c-'0')
		}
		total = total*60 + float64(n)
	}
	return total
}

// ── track metadata by video id ─────────────────────────────────────────

// YTMVideo is what YouTube Music knows about a video: for official songs
// (ATV) clean title / artists / album; for official music videos (OMV) the
// linked artists (the title may still be the raw video title); for user
// uploads (UGC) only the channel.
type YTMVideo struct {
	Title   string
	Artists []string
	Album   string
	Type    string // MUSIC_VIDEO_TYPE_ATV | _OMV | _UGC | …
}

const ytmNextEndpoint = "https://music.youtube.com/youtubei/v1/next?prettyPrint=false"

func ytmVideoMeta(ctx context.Context, hc *http.Client, videoID string) (*YTMVideo, error) {
	body, _ := json.Marshal(map[string]any{
		"context": map[string]any{"client": map[string]any{
			"clientName": "WEB_REMIX", "clientVersion": ytmClientVersion, "hl": "vi", "gl": "VN",
		}},
		"videoId": videoID,
	})
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, ytmNextEndpoint, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "https://music.youtube.com")
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36")
	res, err := hc.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("YouTube Music trả %s", res.Status)
	}
	var raw any
	if err := json.NewDecoder(res.Body).Decode(&raw); err != nil {
		return nil, err
	}
	v, ok := parseYTMNext(raw, videoID)
	if !ok {
		return nil, errors.New("YouTube Music không có thông tin bài này")
	}
	return v, nil
}

// parseYTMNext finds the queue entry for videoID in a /next response.
func parseYTMNext(raw any, videoID string) (*YTMVideo, bool) {
	var found map[string]any
	var walk func(any)
	walk = func(v any) {
		if found != nil {
			return
		}
		switch t := v.(type) {
		case map[string]any:
			if r, ok := t["playlistPanelVideoRenderer"].(map[string]any); ok && r["videoId"] == videoID {
				found = r
				return
			}
			for _, c := range t {
				walk(c)
			}
		case []any:
			for _, c := range t {
				walk(c)
			}
		}
	}
	walk(raw)
	if found == nil {
		return nil, false
	}
	b, _ := json.Marshal(found)
	var r struct {
		Title struct {
			Runs []ytmRun `json:"runs"`
		} `json:"title"`
		Byline struct {
			Runs []ytmRun `json:"runs"`
		} `json:"longBylineText"`
		Nav struct {
			Watch struct {
				Configs struct {
					Music struct {
						Type string `json:"musicVideoType"`
					} `json:"watchEndpointMusicConfig"`
				} `json:"watchEndpointMusicSupportedConfigs"`
			} `json:"watchEndpoint"`
		} `json:"navigationEndpoint"`
	}
	if json.Unmarshal(b, &r) != nil {
		return nil, false
	}
	v := &YTMVideo{Title: strings.TrimSpace(joinRuns(r.Title.Runs)), Type: r.Nav.Watch.Configs.Music.Type}
	for _, run := range r.Byline.Runs {
		switch pageType(run) {
		case "MUSIC_PAGE_TYPE_ARTIST", "MUSIC_PAGE_TYPE_USER_CHANNEL":
			v.Artists = append(v.Artists, strings.TrimSpace(run.Text))
		case "MUSIC_PAGE_TYPE_ALBUM":
			v.Album = strings.TrimSpace(run.Text)
		}
	}
	if v.Title == "" {
		return nil, false
	}
	return v, true
}

// trackMeta names a downloaded track: YouTube Music's own data when it has
// it (official songs and music videos), else the cleaned YouTube title.
func trackMeta(v *YTMVideo, m textutil.Meta) (artist, title, album string) {
	if v != nil && len(v.Artists) > 0 {
		joined := strings.Join(v.Artists, ", ")
		album := firstNonEmpty(v.Album, m.Album)
		switch v.Type {
		case "MUSIC_VIDEO_TYPE_ATV":
			return textutil.CleanMeta(textutil.Meta{Track: v.Title, Artists: v.Artists, Album: album})
		case "MUSIC_VIDEO_TYPE_OMV":
			// The artists are linked, so they are right; the title can still be
			// the raw video title ("Bài - Nghệ sĩ ft. X (Official MV)"), and the
			// known artist tells which side of the dash is which.
			a, t, al := textutil.CleanMeta(textutil.Meta{Title: v.Title, Artist: joined, Uploader: joined, Album: album})
			if a == "" {
				a = joined
			}
			return a, t, al
		}
	}
	return textutil.CleanMeta(m)
}

// ── album / playlist contents ──────────────────────────────────────────

const ytmBrowseEndpoint = "https://music.youtube.com/youtubei/v1/browse?prettyPrint=false"

// YTMList is an album or playlist as YouTube Music lists it.
type YTMList struct {
	ID        string      `json:"id"`
	Title     string      `json:"title"`
	Subtitle  string      `json:"subtitle"`
	Thumbnail string      `json:"thumbnail"`
	Tracks    []WebResult `json:"tracks"`
	Saved     string      `json:"saved,omitempty"` // id of the RiiMusic playlist it was saved as
}

// ytmBrowseList reads the songs of an album or playlist by its playlist id
// (OLAK5uy_… for albums, PL… for playlists). First page only (~100 songs).
func ytmBrowseList(ctx context.Context, hc *http.Client, listID string) (*YTMList, error) {
	body, _ := json.Marshal(map[string]any{
		"context":  map[string]any{"client": map[string]any{"clientName": "WEB_REMIX", "clientVersion": ytmClientVersion, "hl": "vi", "gl": "VN"}},
		"browseId": "VL" + listID,
	})
	ctx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, ytmBrowseEndpoint, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "https://music.youtube.com")
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36")
	res, err := hc.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("YouTube Music trả %s", res.Status)
	}
	var raw any
	if err := json.NewDecoder(res.Body).Decode(&raw); err != nil {
		return nil, err
	}
	return parseYTMBrowse(raw, listID), nil
}

func parseYTMBrowse(raw any, listID string) *YTMList {
	l := &YTMList{ID: listID, Tracks: []WebResult{}}
	// Header: title, subtitle ("Đĩa nhạc • 2017"), artist strapline, picture.
	for _, key := range []string{"musicResponsiveHeaderRenderer", "musicDetailHeaderRenderer", "musicEditablePlaylistDetailHeaderRenderer"} {
		if h := findKey(raw, key); h != nil {
			b, _ := json.Marshal(h)
			var hr struct {
				Title     struct{ Runs []ytmRun } `json:"title"`
				Subtitle  struct{ Runs []ytmRun } `json:"subtitle"`
				Strapline struct{ Runs []ytmRun } `json:"straplineTextOne"`
			}
			json.Unmarshal(b, &hr)
			l.Title = strings.TrimSpace(joinRuns(hr.Title.Runs))
			l.Subtitle = strings.TrimSpace(joinRuns(hr.Subtitle.Runs))
			if a := strings.TrimSpace(joinRuns(hr.Strapline.Runs)); a != "" {
				l.Subtitle = a + " · " + l.Subtitle
			}
			if th := lastThumb(h); th != "" {
				l.Thumbnail = ytmThumbSize.ReplaceAllString(th, "=w544-h544-l90-rj")
			}
			break
		}
	}
	seen := map[string]bool{}
	for _, it := range collectYTMItems(raw) {
		if it.PlaylistItemData == nil || !videoIDRe.MatchString(it.PlaylistItemData.VideoID) || seen[it.PlaylistItemData.VideoID] || len(it.FlexColumns) == 0 {
			continue
		}
		id := it.PlaylistItemData.VideoID
		seen[id] = true
		r := WebResult{ID: id, Title: strings.TrimSpace(joinRuns(it.FlexColumns[0].Col.Text.Runs)), Kind: "songs",
			URL: "https://music.youtube.com/watch?v=" + id, Thumbnail: "https://i.ytimg.com/vi/" + id + "/mqdefault.jpg"}
		if len(it.FlexColumns) > 1 {
			var as []string
			for _, run := range it.FlexColumns[1].Col.Text.Runs {
				if t := strings.TrimSpace(run.Text); t != "" && t != "&" && t != "," && t != "và" && t != "•" {
					as = append(as, t)
				}
			}
			r.Artist = strings.Join(as, ", ")
		}
		if len(it.FlexColumns) > 2 {
			for _, run := range it.FlexColumns[2].Col.Text.Runs {
				if pageType(run) == "MUSIC_PAGE_TYPE_ALBUM" {
					r.Album = strings.TrimSpace(run.Text)
				}
			}
		}
		for _, fc := range it.FixedColumns {
			if t := strings.TrimSpace(joinRuns(fc.Col.Text.Runs)); ytmDurationRe.MatchString(t) {
				r.Duration = parseClock(t)
			}
		}
		if th := it.Thumbnail.R.Thumbnail.Thumbnails; len(th) > 0 && strings.Contains(th[len(th)-1].URL, "googleusercontent.com") {
			r.Thumbnail = ytmThumbSize.ReplaceAllString(th[len(th)-1].URL, "=w240-h240-l90-rj")
		} else if l.Thumbnail != "" && r.Album != "" {
			r.Thumbnail = l.Thumbnail
		}
		r.Channel = r.Artist
		l.Tracks = append(l.Tracks, r)
	}
	// Album rows often omit the artist: it is the album's.
	if strings.HasPrefix(listID, "OLAK5uy_") {
		albumArtist, _, _ := strings.Cut(l.Subtitle, " · ")
		for i := range l.Tracks {
			if l.Tracks[i].Artist == "" && albumArtist != "" && !strings.Contains(albumArtist, "•") {
				l.Tracks[i].Artist, l.Tracks[i].Channel = albumArtist, albumArtist
			}
			if l.Tracks[i].Album == "" {
				l.Tracks[i].Album = l.Title
			}
		}
	}
	return l
}

func findKey(v any, key string) any {
	switch t := v.(type) {
	case map[string]any:
		if x, ok := t[key]; ok {
			return x
		}
		for _, c := range t {
			if r := findKey(c, key); r != nil {
				return r
			}
		}
	case []any:
		for _, c := range t {
			if r := findKey(c, key); r != nil {
				return r
			}
		}
	}
	return nil
}

// lastThumb finds the largest thumbnail URL under v.
func lastThumb(v any) string {
	th := findKey(v, "thumbnails")
	list, ok := th.([]any)
	if !ok || len(list) == 0 {
		return ""
	}
	if m, ok := list[len(list)-1].(map[string]any); ok {
		u, _ := m["url"].(string)
		return u
	}
	return ""
}
