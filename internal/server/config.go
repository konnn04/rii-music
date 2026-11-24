package server

import (
	"bufio"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type Config struct {
	Addr    string
	DataDir string
	// DatabaseURL: PostgreSQL connection string (DATABASE_URL).
	DatabaseURL string
	TrustProxy  bool
	// ForceIPv4 (FORCE_IPV4): outbound connections and yt-dlp use IPv4 only,
	// for hosts whose IPv6 is broken or blocked by YouTube.
	ForceIPv4     bool
	FFmpeg        string
	MaxJobs       int
	YTDLPMaxProcs int
	MaxDuration   int // seconds; longer videos are refused
	DevCORS       string
	PublicURL     string // https://… used in links inside emails

	// First admin, created when the database has no users yet.
	AdminEmail    string
	AdminPassword string
	// Storage limit given to new accounts (admins can change it per user).
	DefaultStorageMB int

	// Email for OTP codes (Gmail: smtp.gmail.com:587 with an app password).
	SMTPHost     string
	SMTPPort     int
	SMTPUsername string
	SMTPPassword string
	SMTPFrom     string

	LastfmKey string // optional; Deezer (no key) is used otherwise

	// Discord agent builds to offer for download (the Docker image ships them).
	AgentDir string

	// Desktop app (RII_MODE): "server" (default, this web app), "local" (one
	// user on this machine, music encrypted in MusicPath) or "client".
	Mode string
	// MusicPath: where songs live when not under DataDir/music (local mode:
	// ~/Music/RiiMusic, movable from the settings).
	MusicPath string
	// LocalToken: the desktop shell's secret for /__rii/auto-login (local mode).
	LocalToken string
}

// Local: the desktop app's local mode (single user, no accounts).
func (c Config) Local() bool { return c.Mode == "local" }

func LoadConfig() Config {
	c := Config{
		Addr:          listenHost() + ":" + env("PORT", "8080"),
		DataDir:       env("DATA_DIR", "./data"),
		DatabaseURL:   strings.TrimSpace(os.Getenv("DATABASE_URL")),
		TrustProxy:    envBool("TRUST_PROXY", false),
		ForceIPv4:     envBool("FORCE_IPV4", false),
		FFmpeg:        env("FFMPEG_PATH", "ffmpeg"),
		MaxJobs:       envInt("DOWNLOAD_CONCURRENCY", 2),
		YTDLPMaxProcs: envInt("YTDLP_MAX_PROCS", 3),
		MaxDuration:   envInt("MAX_DURATION_SEC", 3*60*60),
		DevCORS:       os.Getenv("DEV_CORS_ORIGIN"),
		PublicURL:     strings.TrimRight(os.Getenv("PUBLIC_URL"), "/"),

		AdminEmail:       strings.TrimSpace(os.Getenv("ADMIN_EMAIL")),
		AdminPassword:    os.Getenv("ADMIN_PASSWORD"),
		DefaultStorageMB: envInt("DEFAULT_STORAGE_LIMIT_MB", 2048),

		SMTPHost:     env("SMTP_HOST", "smtp.gmail.com"),
		SMTPPort:     envInt("SMTP_PORT", 587),
		SMTPUsername: strings.TrimSpace(os.Getenv("SMTP_USERNAME")),
		SMTPPassword: strings.ReplaceAll(os.Getenv("SMTP_PASSWORD"), " ", ""), // Gmail shows app passwords in groups of 4
		SMTPFrom:     strings.TrimSpace(os.Getenv("SMTP_FROM")),

		LastfmKey: strings.TrimSpace(os.Getenv("LASTFM_API_KEY")),
		AgentDir:  strings.TrimSpace(os.Getenv("AGENT_DIR")),

		Mode:       env("RII_MODE", "server"),
		MusicPath:  strings.TrimSpace(os.Getenv("RII_MUSIC_DIR")),
		LocalToken: strings.TrimSpace(os.Getenv("RII_LOCAL_TOKEN")),
	}
	if abs, err := filepath.Abs(c.DataDir); err == nil {
		c.DataDir = abs
	}
	if c.MaxJobs < 1 {
		c.MaxJobs = 1
	}
	if c.DefaultStorageMB < 256 {
		c.DefaultStorageMB = 2048
	}
	if c.SMTPFrom == "" {
		c.SMTPFrom = c.SMTPUsername
	}
	return c
}

// listenHost: the desktop app's local mode listens on this machine only.
func listenHost() string {
	if os.Getenv("RII_LISTEN_LOCAL") == "1" {
		return "127.0.0.1"
	}
	return ""
}

func (c Config) MailConfigured() bool { return c.SMTPUsername != "" && c.SMTPPassword != "" }

func (c Config) MusicDir() string {
	if c.MusicPath != "" {
		return c.MusicPath
	}
	return filepath.Join(c.DataDir, "music")
}

// AudioPath: the file of a track (tracks.file_path is "music/<id>.<ext>",
// relative to the data dir; the music folder itself may live elsewhere).
func (c Config) AudioPath(rel string) string {
	rel = filepath.FromSlash(rel)
	if rest, ok := strings.CutPrefix(rel, "music"+string(filepath.Separator)); ok {
		return filepath.Join(c.MusicDir(), rest)
	}
	return filepath.Join(c.DataDir, rel)
}
func (c Config) CoverDir() string { return filepath.Join(c.DataDir, "covers") }
func (c Config) TmpDir() string   { return filepath.Join(c.DataDir, "tmp") }
func (c Config) BinDir() string   { return filepath.Join(c.DataDir, "bin") }

// LoadDotEnv reads KEY=VALUE lines from path into the environment. Variables
// already set (by the shell, Docker, Coolify…) win over the file. A missing
// file is not an error.
func LoadDotEnv(path string) error {
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimPrefix(line, "export ")
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		k, v = strings.TrimSpace(k), strings.TrimSpace(v)
		if len(v) >= 2 && (v[0] == '"' && v[len(v)-1] == '"' || v[0] == '\'' && v[len(v)-1] == '\'') {
			v = v[1 : len(v)-1]
		} else if i := strings.Index(v, " #"); i >= 0 {
			v = strings.TrimSpace(v[:i]) // trailing comment
		}
		if _, set := os.LookupEnv(k); !set {
			os.Setenv(k, v)
		}
	}
	return sc.Err()
}

func env(k, def string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return def
}

func envInt(k string, def int) int {
	if v, err := strconv.Atoi(strings.TrimSpace(os.Getenv(k))); err == nil {
		return v
	}
	return def
}

func envBool(k string, def bool) bool {
	if v, err := strconv.ParseBool(strings.TrimSpace(os.Getenv(k))); err == nil {
		return v
	}
	return def
}
