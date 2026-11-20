// Package db opens the SQLite database and applies schema migrations.
package db

import (
	"database/sql"
	"errors"
	"fmt"

	_ "modernc.org/sqlite"
)

// Open opens (or creates) the database at path and migrates it to the latest schema.
//
// One connection only: SQLite serialises writes anyway, and a single connection
// rules out SQLITE_BUSY between our own goroutines. Callers must therefore never
// run a query while iterating another query's rows.
func Open(path string) (*sql.DB, error) {
	dsn := "file:" + path + "?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)&_pragma=synchronous(NORMAL)"
	d, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	d.SetMaxOpenConns(1)
	if err := d.Ping(); err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}
	if err := migrate(d); err != nil {
		d.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}
	return d, nil
}

// Schema history restarts at the multi-user version: the single-user
// databases before it (user_version 1–6, no users table) are not migrated.
var migrations = []string{
	// 1: multi-user schema
	`
-- ── accounts ──────────────────────────────────────────────────────────
CREATE TABLE users (
  id               TEXT PRIMARY KEY,
  email            TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name             TEXT NOT NULL DEFAULT '',
  pass_hash        TEXT NOT NULL DEFAULT '',      -- empty: OTP login only
  role             TEXT NOT NULL CHECK (role IN ('admin', 'listener')),
  storage_limit_mb INTEGER NOT NULL CHECK (storage_limit_mb > 0),
  disabled         INTEGER NOT NULL DEFAULT 0,
  session_version  INTEGER NOT NULL DEFAULT 1,    -- bump to sign out every session
  settings_json    TEXT NOT NULL DEFAULT '{}',
  created_at       INTEGER NOT NULL,
  last_login_at    INTEGER
);

-- One-time codes for OTP login and password reset (hashed, short-lived).
CREATE TABLE otp_codes (
  email      TEXT NOT NULL COLLATE NOCASE,
  purpose    TEXT NOT NULL CHECK (purpose IN ('login', 'reset')),
  code_hash  TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  sent_at    INTEGER NOT NULL,
  PRIMARY KEY (email, purpose)
);

-- ── shared music store: one row and one file per song, whoever downloaded it
CREATE TABLE tracks (
  id             TEXT PRIMARY KEY,
  source         TEXT NOT NULL DEFAULT 'youtube',
  source_id      TEXT UNIQUE,
  source_url     TEXT NOT NULL DEFAULT '',
  title          TEXT NOT NULL,
  artist         TEXT NOT NULL DEFAULT '',
  album          TEXT NOT NULL DEFAULT '',
  duration_ms    INTEGER NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  file_path      TEXT NOT NULL,
  mime           TEXT NOT NULL,
  size_bytes     INTEGER NOT NULL DEFAULT 0,
  has_cover      INTEGER NOT NULL DEFAULT 0,
  loudness_lufs  REAL,
  gain_db        REAL NOT NULL DEFAULT 0,
  loudness_done  INTEGER NOT NULL DEFAULT 0,      -- measured in the background
  search         TEXT NOT NULL DEFAULT '',
  added_at       INTEGER NOT NULL
);
CREATE INDEX tracks_artist ON tracks(artist);

CREATE TABLE lyrics (
  track_id   TEXT PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  plain      TEXT NOT NULL DEFAULT '',
  synced     TEXT NOT NULL DEFAULT '',
  source     TEXT NOT NULL CHECK (source IN ('lrclib', 'manual', 'none')),
  offset_ms  INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

-- Hand-crafted audio feature vector per track (spectral stats, energy, tempo).
CREATE TABLE track_features (
  track_id    TEXT PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  vec         TEXT NOT NULL,          -- JSON array of floats; empty array = extraction failed
  computed_at INTEGER NOT NULL
);

-- Cached responses from Deezer / Last.fm (similar artists, top tracks).
CREATE TABLE ext_cache (
  key        TEXT PRIMARY KEY,
  json       TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);

-- Server-wide settings (audio format…), edited by admins.
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);

-- ── per user ──────────────────────────────────────────────────────────
-- A user's library: which shared tracks they have, and their play counts.
CREATE TABLE user_tracks (
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id       TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  origin         TEXT NOT NULL DEFAULT 'user' CHECK (origin IN ('user', 'autoplay', 'auto')),
  added_at       INTEGER NOT NULL,
  play_count     INTEGER NOT NULL DEFAULT 0,
  last_played_at INTEGER,
  PRIMARY KEY (user_id, track_id)
);
CREATE INDEX user_tracks_track ON user_tracks(track_id);
CREATE INDEX user_tracks_added ON user_tracks(user_id, added_at);

CREATE TABLE likes (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id   TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, track_id)
);

CREATE TABLE playlists (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  kind       TEXT NOT NULL CHECK (kind IN ('manual', 'smart')),
  rule_json  TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX playlists_user ON playlists(user_id, updated_at);

CREATE TABLE playlist_items (
  playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  track_id    TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  added_at    INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, track_id)
);
CREATE INDEX playlist_items_pos ON playlist_items(playlist_id, position);
CREATE INDEX playlist_items_track ON playlist_items(track_id);

CREATE TABLE listen_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id   TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL,
  played_ms  INTEGER NOT NULL DEFAULT 0 CHECK (played_ms >= 0),
  action     TEXT NOT NULL CHECK (action IN ('finish', 'skip', 'repeat')),
  hour       INTEGER NOT NULL CHECK (hour BETWEEN 0 AND 23),
  source     TEXT NOT NULL DEFAULT ''
);
CREATE INDEX listen_events_user_time ON listen_events(user_id, started_at);
CREATE INDEX listen_events_track ON listen_events(track_id);

CREATE TABLE feedback (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('artist', 'track')),
  key        TEXT NOT NULL,          -- folded artist name, or track id
  value      INTEGER NOT NULL CHECK (value IN (-1, 1)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, kind, key)
);

CREATE TABLE download_jobs (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url        TEXT NOT NULL,
  source_id  TEXT,
  title      TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL CHECK (status IN ('queued', 'downloading', 'processing', 'done', 'error', 'skipped')),
  progress   REAL NOT NULL DEFAULT 0,
  stage      TEXT NOT NULL DEFAULT '',
  error      TEXT NOT NULL DEFAULT '',
  track_id   TEXT,
  origin     TEXT NOT NULL DEFAULT 'user' CHECK (origin IN ('user', 'autoplay', 'auto')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX download_jobs_user ON download_jobs(user_id, created_at);
CREATE INDEX download_jobs_status ON download_jobs(status);

-- Tracks a user removed (by hand or by the storage limit), so automatic
-- downloads don't bring them back.
CREATE TABLE removed_tracks (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_id  TEXT NOT NULL,
  artist     TEXT NOT NULL,
  title      TEXT NOT NULL,
  removed_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, source_id)
);
`,
	// 2: song language, per-user lyrics choices, API / agent tokens
	`
-- vi | en | ja | ko | zh | th | '' (unknown): keeps recommendations from mixing languages
ALTER TABLE tracks ADD COLUMN lang TEXT NOT NULL DEFAULT '';
ALTER TABLE lyrics ADD COLUMN lrclib_id INTEGER NOT NULL DEFAULT 0;

-- Lyrics a user picked for a track (from search, pasted, or just their offset
-- on the automatic ones). When several users pick the same LRCLIB entry,
-- it becomes the suggestion for everyone else.
CREATE TABLE lyrics_choices (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id   TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  source     TEXT NOT NULL CHECK (source IN ('auto', 'lrclib', 'manual')),
  lrclib_id  INTEGER NOT NULL DEFAULT 0,
  plain      TEXT NOT NULL DEFAULT '',
  synced     TEXT NOT NULL DEFAULT '',
  offset_ms  INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, track_id)
);
CREATE INDEX lyrics_choices_track ON lyrics_choices(track_id, lrclib_id);

-- Personal tokens: 'api' for scripts using the API, 'agent' for the Discord agent.
CREATE TABLE api_tokens (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('api', 'agent')),
  name         TEXT NOT NULL DEFAULT '',
  token_hash   TEXT NOT NULL UNIQUE,
  prefix       TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX api_tokens_user ON api_tokens(user_id);
`,
	// 3: playlists saved from YouTube Music, filled as their songs download
	`
ALTER TABLE playlists ADD COLUMN source TEXT NOT NULL DEFAULT '';
ALTER TABLE download_jobs ADD COLUMN playlist_id TEXT;
ALTER TABLE download_jobs ADD COLUMN playlist_pos INTEGER NOT NULL DEFAULT 0;
`,
}

// ErrLegacyDB: a database from the single-user version.
var ErrLegacyDB = errors.New("cơ sở dữ liệu thuộc bản một người dùng cũ: xoá (hoặc đổi tên) vang.db, thư mục music và covers trong DATA_DIR rồi chạy lại")

func migrate(d *sql.DB) error {
	var version int
	if err := d.QueryRow(`PRAGMA user_version`).Scan(&version); err != nil {
		return err
	}
	if version > 0 {
		var n int
		d.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'users'`).Scan(&n)
		if n == 0 {
			return ErrLegacyDB
		}
	}
	for i := version; i < len(migrations); i++ {
		tx, err := d.Begin()
		if err != nil {
			return err
		}
		if _, err := tx.Exec(migrations[i]); err != nil {
			tx.Rollback()
			return fmt.Errorf("migration %d: %w", i+1, err)
		}
		if _, err := tx.Exec(fmt.Sprintf(`PRAGMA user_version = %d`, i+1)); err != nil {
			tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}
