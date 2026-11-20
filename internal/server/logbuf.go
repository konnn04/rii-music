package server

import (
	"context"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// LogBuffer keeps the latest log records in memory for the admin page, next
// to the normal output. Secrets (attributes named like password / token) are
// masked before they are stored.
type LogBuffer struct {
	mu   sync.Mutex
	recs []LogRecord
	next int
	full bool
	seq  int64
}

type LogRecord struct {
	Seq   int64             `json:"seq"`
	Time  int64             `json:"time"`
	Level string            `json:"level"`
	Msg   string            `json:"msg"`
	Attrs map[string]string `json:"attrs,omitempty"`
}

func NewLogBuffer(n int) *LogBuffer { return &LogBuffer{recs: make([]LogRecord, n)} }

// Wrap returns a handler that writes to h and also records into the buffer.
func (b *LogBuffer) Wrap(h slog.Handler) slog.Handler { return &teeHandler{h: h, buf: b} }

func (b *LogBuffer) add(r LogRecord) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.seq++
	r.Seq = b.seq
	b.recs[b.next] = r
	b.next = (b.next + 1) % len(b.recs)
	if b.next == 0 {
		b.full = true
	}
}

// since returns records after seq, oldest first.
func (b *LogBuffer) since(seq int64) []LogRecord {
	b.mu.Lock()
	defer b.mu.Unlock()
	var all []LogRecord
	if b.full {
		all = append(append(all, b.recs[b.next:]...), b.recs[:b.next]...)
	} else {
		all = append(all, b.recs[:b.next]...)
	}
	out := []LogRecord{}
	for _, r := range all {
		if r.Seq > seq {
			out = append(out, r)
		}
	}
	return out
}

type teeHandler struct {
	h     slog.Handler
	buf   *LogBuffer
	attrs []slog.Attr
	group string
}

func (t *teeHandler) Enabled(ctx context.Context, l slog.Level) bool {
	return l >= slog.LevelInfo || t.h.Enabled(ctx, l)
}

func secretKey(k string) bool {
	k = strings.ToLower(k)
	return strings.Contains(k, "password") || strings.Contains(k, "token") || strings.Contains(k, "secret") || k == "code"
}

func (t *teeHandler) Handle(ctx context.Context, r slog.Record) error {
	rec := LogRecord{Time: r.Time.UnixMilli(), Level: r.Level.String(), Msg: r.Message}
	add := func(a slog.Attr) {
		if rec.Attrs == nil {
			rec.Attrs = map[string]string{}
		}
		k := a.Key
		if t.group != "" {
			k = t.group + "." + k
		}
		v := a.Value.Resolve().String()
		if secretKey(a.Key) {
			v = "••••"
		}
		if len(v) > 2000 {
			v = v[:2000] + "…"
		}
		rec.Attrs[k] = v
	}
	for _, a := range t.attrs {
		add(a)
	}
	r.Attrs(func(a slog.Attr) bool { add(a); return true })
	t.buf.add(rec)
	if t.h.Enabled(ctx, r.Level) {
		// mask secrets in the normal output too
		clean := slog.NewRecord(r.Time, r.Level, r.Message, r.PC)
		r.Attrs(func(a slog.Attr) bool {
			if secretKey(a.Key) {
				a = slog.String(a.Key, "••••")
			}
			clean.AddAttrs(a)
			return true
		})
		return t.h.Handle(ctx, clean)
	}
	return nil
}

func (t *teeHandler) WithAttrs(as []slog.Attr) slog.Handler {
	return &teeHandler{h: t.h.WithAttrs(as), buf: t.buf, attrs: append(append([]slog.Attr{}, t.attrs...), as...), group: t.group}
}

func (t *teeHandler) WithGroup(name string) slog.Handler {
	return &teeHandler{h: t.h.WithGroup(name), buf: t.buf, attrs: t.attrs, group: name}
}

// SetLogBuffer lets the admin page read the logs.
func (s *Server) SetLogBuffer(b *LogBuffer) { s.logs = b }

// handleAdminLogs: GET /api/admin/logs?since=<seq>&level=WARN&q=text
func (s *Server) handleAdminLogs(w http.ResponseWriter, r *http.Request) {
	if s.logs == nil {
		writeJSON(w, http.StatusOK, map[string]any{"records": []LogRecord{}})
		return
	}
	q := r.URL.Query()
	since, _ := strconv.ParseInt(q.Get("since"), 10, 64)
	minLevel := slog.LevelDebug
	switch strings.ToUpper(q.Get("level")) {
	case "INFO":
		minLevel = slog.LevelInfo
	case "WARN":
		minLevel = slog.LevelWarn
	case "ERROR":
		minLevel = slog.LevelError
	}
	needle := strings.ToLower(strings.TrimSpace(q.Get("q")))
	out := []LogRecord{}
	for _, rec := range s.logs.since(since) {
		var l slog.Level
		l.UnmarshalText([]byte(rec.Level))
		if l < minLevel {
			continue
		}
		if needle != "" {
			hay := strings.ToLower(rec.Msg)
			for k, v := range rec.Attrs {
				hay += " " + strings.ToLower(k+"="+v)
			}
			if !strings.Contains(hay, needle) {
				continue
			}
		}
		out = append(out, rec)
	}
	if len(out) > 1000 {
		out = out[len(out)-1000:]
	}
	writeJSON(w, http.StatusOK, map[string]any{"records": out, "now": time.Now().UnixMilli()})
}
