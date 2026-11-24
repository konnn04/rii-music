package clientproxy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync"
	"time"
)

const (
	healthTimeout    = 5 * time.Second
	errorLogInterval = 30 * time.Second
)

// New returns a handler that forwards every request to remote (scheme + host [+ base path]),
// e.g. https://music.example.com.
func New(remote *url.URL, log *slog.Logger) (http.Handler, error) {
	return newWithTransport(remote, log, nil)
}

func newWithTransport(remote *url.URL, log *slog.Logger, rt http.RoundTripper) (http.Handler, error) {
	target, err := normalizeRemote(remote)
	if err != nil {
		return nil, err
	}

	remoteDisplay := target.String()
	remoteOrigin := target.Scheme + "://" + target.Host
	offlineHTML := buildOfflineHTML(remoteDisplay)

	var (
		logMu      sync.Mutex
		lastErrLog time.Time
	)

	rp := &httputil.ReverseProxy{
		Transport:     rt,
		FlushInterval: -1,
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(target)
			pr.Out.Host = target.Host
			pr.SetXForwarded()

			if origin := pr.Out.Header.Get("Origin"); origin != "" {
				if u, err := url.Parse(origin); err == nil && isLocalOrigin(u) {
					pr.Out.Header.Set("Origin", remoteOrigin)
				}
			}
			if referer := pr.Out.Header.Get("Referer"); referer != "" {
				if u, err := url.Parse(referer); err == nil && isLocalOrigin(u) {
					u.Scheme = target.Scheme
					u.Host = target.Host
					if target.Path != "" {
						u.Path = singleJoiningSlash(target.Path, u.Path)
						u.RawPath = ""
					}
					pr.Out.Header.Set("Referer", u.String())
				}
			}
		},
		ModifyResponse: func(resp *http.Response) error {
			resp.Header.Del("Strict-Transport-Security")

			if cookies := resp.Header["Set-Cookie"]; len(cookies) > 0 {
				for i, raw := range cookies {
					cookies[i] = rewriteSetCookie(raw)
				}
			}

			if loc := resp.Header.Get("Location"); loc != "" {
				if u, err := url.Parse(loc); err == nil && sameOrigin(u, target) {
					p := u.Path
					if target.Path != "" {
						if p == target.Path {
							p = "/"
						} else if strings.HasPrefix(p, target.Path+"/") {
							p = strings.TrimPrefix(p, target.Path)
						}
					}
					if p == "" {
						p = "/"
					}
					rel := &url.URL{
						Path:     p,
						RawQuery: u.RawQuery,
						Fragment: u.Fragment,
					}
					resp.Header.Set("Location", rel.String())
				}
			}

			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			if log != nil && !errors.Is(err, context.Canceled) {
				now := time.Now()
				logMu.Lock()
				shouldLog := lastErrLog.IsZero() || now.Sub(lastErrLog) >= errorLogInterval
				if shouldLog {
					lastErrLog = now
				}
				logMu.Unlock()
				if shouldLog {
					log.Warn("clientproxy: upstream error", "remote", remoteDisplay, "err", err)
				}
			}

			if r.URL.Path == "/api" || strings.HasPrefix(r.URL.Path, "/api/") {
				w.Header().Set("Content-Type", "application/json; charset=utf-8")
				w.WriteHeader(http.StatusBadGateway)
				_, _ = w.Write([]byte(`{"error":"Không kết nối được máy chủ"}`))
				return
			}

			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.WriteHeader(http.StatusBadGateway)
			_, _ = w.Write(offlineHTML)
		},
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/__rii/proxy" {
			if r.Method != http.MethodGet && r.Method != http.MethodHead {
				w.Header().Set("Allow", "GET")
				w.WriteHeader(http.StatusMethodNotAllowed)
				return
			}
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store")
			_ = json.NewEncoder(w).Encode(struct {
				Mode   string `json:"mode"`
				Remote string `json:"remote"`
			}{
				Mode:   "client",
				Remote: remoteDisplay,
			})
			return
		}
		rp.ServeHTTP(w, r)
	}), nil
}

// Check asks remote's GET /api/health (5 s timeout) and returns its "version" field.
func Check(ctx context.Context, remote *url.URL) (version string, err error) {
	return checkWithTransport(ctx, remote, nil)
}

func checkWithTransport(ctx context.Context, remote *url.URL, rt http.RoundTripper) (string, error) {
	target, err := normalizeRemote(remote)
	if err != nil {
		return "", err
	}
	if ctx == nil {
		ctx = context.Background()
	}
	ctx, cancel := context.WithTimeout(ctx, healthTimeout)
	defer cancel()

	healthURL := *target
	healthURL.Path = target.Path + "/api/health"
	healthURL.RawQuery = ""
	healthURL.Fragment = ""

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, healthURL.String(), nil)
	if err != nil {
		return "", err
	}

	client := &http.Client{Transport: rt}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("clientproxy: health check status %d", resp.StatusCode)
	}

	var body struct {
		Version string `json:"version"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&body); err != nil {
		return "", fmt.Errorf("clientproxy: decode health response: %w", err)
	}
	return body.Version, nil
}

func normalizeRemote(remote *url.URL) (*url.URL, error) {
	if remote == nil {
		return nil, errors.New("clientproxy: remote URL is nil")
	}
	scheme := strings.ToLower(remote.Scheme)
	if (scheme != "http" && scheme != "https") || remote.Host == "" {
		return nil, fmt.Errorf("clientproxy: invalid remote URL %q", remote.String())
	}
	cp := *remote
	cp.Scheme = scheme
	cp.Path = strings.TrimRight(cp.Path, "/")
	cp.RawPath = ""
	cp.RawQuery = ""
	cp.Fragment = ""
	return &cp, nil
}

func isLocalOrigin(u *url.URL) bool {
	if !strings.EqualFold(u.Scheme, "http") {
		return false
	}
	host := strings.ToLower(u.Hostname())
	return host == "127.0.0.1" || host == "localhost"
}

func sameOrigin(a, b *url.URL) bool {
	return strings.EqualFold(a.Scheme, b.Scheme) &&
		strings.EqualFold(normalizeHost(a), normalizeHost(b))
}

func normalizeHost(u *url.URL) string {
	host := u.Hostname()
	port := u.Port()
	if (strings.EqualFold(u.Scheme, "http") && port == "80") ||
		(strings.EqualFold(u.Scheme, "https") && port == "443") {
		port = ""
	}
	if port == "" {
		return host
	}
	return net.JoinHostPort(host, port)
}

func singleJoiningSlash(a, b string) string {
	aslash := strings.HasSuffix(a, "/")
	bslash := strings.HasPrefix(b, "/")
	switch {
	case aslash && bslash:
		return a + b[1:]
	case !aslash && !bslash:
		return a + "/" + b
	default:
		return a + b
	}
}

// rewriteSetCookie strips Domain and Secure attributes while keeping all others.
func rewriteSetCookie(raw string) string {
	parts := strings.Split(raw, ";")
	if len(parts) <= 1 {
		return raw
	}
	out := make([]string, 0, len(parts))
	out = append(out, parts[0])
	for _, p := range parts[1:] {
		attr := strings.TrimSpace(p)
		if attr == "" {
			continue
		}
		name, _, hasEq := strings.Cut(attr, "=")
		name = strings.ToLower(strings.TrimSpace(name))
		if name == "domain" && hasEq {
			continue
		}
		if name == "secure" && !hasEq {
			continue
		}
		out = append(out, " "+attr)
	}
	return strings.Join(out, ";")
}

func buildOfflineHTML(remoteDisplay string) []byte {
	escaped := html.EscapeString(remoteDisplay)
	return []byte(fmt.Sprintf(`<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Không kết nối được máy chủ RiiMusic</title>
<style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0E0F12;color:#EDEDF2;font-family:system-ui,-apple-system,sans-serif;padding:24px}
main{max-width:420px;width:100%%;text-align:center}
h1{font-size:1.25rem;margin:0 0 8px}
.addr{font-family:ui-monospace,monospace;font-size:.9rem;opacity:.75;word-break:break-all;margin:0 0 20px}
button{background:#EDEDF2;color:#0E0F12;border:0;border-radius:8px;padding:10px 20px;font-size:.95rem;font-weight:600;cursor:pointer}
button:hover{opacity:.9}
.hint{margin-top:20px;font-size:.85rem;opacity:.65}
</style>
</head>
<body>
<main>
<h1>Không kết nối được máy chủ RiiMusic</h1>
<p class="addr">%s</p>
<button type="button" onclick="location.reload()">Thử lại</button>
<p class="hint">Đổi máy chủ trong khay hệ thống → Đổi chế độ</p>
</main>
</body>
</html>
`, escaped))
}
