package server

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Stream API: play a YouTube video's audio without downloading it into the
// library first (for bots, e.g. Discord). yt-dlp resolves the googlevideo URL
// of the best audio format; the server proxies it, Range requests included,
// so clients never talk to YouTube (the URL is bound to the server's IP).
//
//   GET /api/stream/{videoId}        audio, proxied (Range supported)
//   GET /api/stream/{videoId}/info   title, artist, duration, format, links
//
// A song already in the caller's library is served from disk instead.
// Resolved URLs are cached for 4 h (googlevideo links last about 6 h) and
// concurrent requests for the same video share one yt-dlp run.

const streamURLTTL = 4 * time.Hour

type streamInfo struct {
	VideoID    string `json:"videoId"`
	Title      string `json:"title"`
	Artist     string `json:"artist"`
	DurationMs int64  `json:"durationMs"`
	Ext        string `json:"ext"`
	Mime       string `json:"mime"`
	Codec      string `json:"codec"`
	Bitrate    int    `json:"bitrateKbps,omitempty"`
	url        string
	expires    time.Time
}

type streamCache struct {
	mu       sync.Mutex
	m        map[string]*streamInfo
	inflight map[string]*streamCall
}

type streamCall struct {
	done chan struct{}
	info *streamInfo
	err  error
}

// resolve returns the cached info or runs yt-dlp once for all concurrent callers.
func (s *Server) streamResolve(ctx context.Context, id string, fresh bool) (*streamInfo, error) {
	c := &s.streams
	c.mu.Lock()
	if c.m == nil {
		c.m, c.inflight = map[string]*streamInfo{}, map[string]*streamCall{}
	}
	if in, ok := c.m[id]; ok && !fresh && time.Now().Before(in.expires) {
		c.mu.Unlock()
		return in, nil
	}
	if call, ok := c.inflight[id]; ok {
		c.mu.Unlock()
		select {
		case <-call.done:
			return call.info, call.err
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	call := &streamCall{done: make(chan struct{})}
	c.inflight[id] = call
	c.mu.Unlock()

	call.info, call.err = s.streamExtract(id)
	c.mu.Lock()
	delete(c.inflight, id)
	if call.err == nil {
		c.m[id] = call.info
		for k, v := range c.m { // drop expired entries now and then
			if time.Now().After(v.expires) {
				delete(c.m, k)
			}
		}
	}
	c.mu.Unlock()
	close(call.done)
	return call.info, call.err
}

func (s *Server) streamExtract(id string) (*streamInfo, error) {
	// Detached from the request: other callers may be waiting for this run.
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	out, err := s.yt.Run(ctx, []string{
		"--no-playlist", "--skip-download", "-f", "bestaudio[acodec^=opus]/bestaudio/best",
		"--print", "%(url)s\t%(ext)s\t%(acodec)s\t%(abr)s\t%(duration)s\t%(title)s\t%(artist,creator,uploader,channel)s",
		"https://www.youtube.com/watch?v=" + id,
	}, nil)
	if err != nil {
		return nil, err
	}
	line := strings.TrimSpace(out)
	if i := strings.LastIndex(line, "\n"); i >= 0 {
		line = line[i+1:]
	}
	f := strings.Split(line, "\t")
	if len(f) < 7 || !strings.HasPrefix(f[0], "https://") {
		return nil, errors.New("không lấy được luồng âm thanh")
	}
	in := &streamInfo{VideoID: id, url: f[0], Ext: f[1], Codec: f[2], Title: f[5], Artist: strings.TrimSpace(f[6]), expires: time.Now().Add(streamURLTTL)}
	if in.Artist == "NA" {
		in.Artist = ""
	}
	if abr, err := strconv.ParseFloat(f[3], 64); err == nil {
		in.Bitrate = int(abr)
	}
	if d, err := strconv.ParseFloat(f[4], 64); err == nil {
		in.DurationMs = int64(d * 1000)
	}
	switch in.Ext {
	case "webm":
		in.Mime = "audio/webm"
	case "m4a", "mp4":
		in.Mime = "audio/mp4"
	default:
		in.Mime = "application/octet-stream"
	}
	// Proper names from YouTube Music when it knows the song.
	if v, err := ytmVideoMeta(ctx, s.ext.hc, id); err == nil && v.Title != "" {
		in.Title = v.Title
		if len(v.Artists) > 0 {
			in.Artist = strings.Join(v.Artists, ", ")
		}
	}
	return in, nil
}

// libraryTrackFor: the caller's library track downloaded from this video, if any.
func (s *Server) libraryTrackFor(uid, videoID string) string {
	var id string
	s.db.QueryRow(`SELECT t.id FROM tracks t JOIN user_tracks ut ON ut.track_id = t.id AND ut.user_id = ? WHERE t.source_id = ?`, uid, videoID).Scan(&id)
	return id
}

// GET /api/stream/{videoId}/info
func (s *Server) handleStreamInfo(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("videoId")
	if !videoIDRe.MatchString(id) {
		httpError(w, http.StatusBadRequest, "Mã video không hợp lệ")
		return
	}
	in, err := s.streamResolve(r.Context(), id, false)
	if err != nil {
		httpError(w, http.StatusBadGateway, "Không lấy được luồng âm thanh: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"videoId": in.VideoID, "title": in.Title, "artist": in.Artist, "durationMs": in.DurationMs,
		"ext": in.Ext, "mime": in.Mime, "codec": in.Codec, "bitrateKbps": in.Bitrate,
		"streamUrl":    "/api/stream/" + id,                 // proxied by this server (use this)
		"libraryTrack": s.libraryTrackFor(userOf(r).ID, id), // set when the song is in your library
		"expiresAt":    in.expires.UnixMilli(),              // when the cached YouTube link is refreshed
	})
}

// GET /api/stream/{videoId}: the audio, proxied from YouTube (or from disk).
func (s *Server) handleStreamProxy(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("videoId")
	if !videoIDRe.MatchString(id) {
		httpError(w, http.StatusBadRequest, "Mã video không hợp lệ")
		return
	}
	if tid := s.libraryTrackFor(userOf(r).ID, id); tid != "" {
		r.SetPathValue("id", tid)
		s.handleStream(w, r)
		return
	}
	for attempt := 0; attempt < 2; attempt++ {
		in, err := s.streamResolve(r.Context(), id, attempt > 0)
		if err != nil {
			httpError(w, http.StatusBadGateway, "Không lấy được luồng âm thanh: "+err.Error())
			return
		}
		req, _ := http.NewRequestWithContext(r.Context(), http.MethodGet, in.url, nil)
		if rg := r.Header.Get("Range"); rg != "" {
			req.Header.Set("Range", rg)
		}
		req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			if r.Context().Err() != nil {
				return // the client went away
			}
			httpError(w, http.StatusBadGateway, "YouTube không trả luồng âm thanh")
			return
		}
		if res.StatusCode == http.StatusForbidden || res.StatusCode == http.StatusGone {
			res.Body.Close() // expired link: resolve again once
			continue
		}
		defer res.Body.Close()
		for _, h := range []string{"Content-Length", "Content-Range", "Accept-Ranges"} {
			if v := res.Header.Get(h); v != "" {
				w.Header().Set(h, v)
			}
		}
		w.Header().Set("Content-Type", in.Mime)
		w.Header().Set("Cache-Control", "private, no-store")
		w.WriteHeader(res.StatusCode)
		io.Copy(w, res.Body)
		return
	}
	httpError(w, http.StatusBadGateway, "YouTube từ chối luồng âm thanh")
}
