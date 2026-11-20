-- RiiMusic schema (PostgreSQL). Times are Unix milliseconds (BIGINT); flag
-- columns are 0/1 integers.

CREATE EXTENSION IF NOT EXISTS citext;

-- ── accounts ──────────────────────────────────────────────────────────
CREATE TABLE users (
  id               TEXT PRIMARY KEY,
  email            CITEXT NOT NULL UNIQUE,
  name             TEXT NOT NULL DEFAULT '',
  pass_hash        TEXT NOT NULL DEFAULT '',      -- empty: OTP login only
  role             TEXT NOT NULL CHECK (role IN ('admin', 'listener')),
  storage_limit_mb BIGINT NOT NULL CHECK (storage_limit_mb > 0),
  disabled         SMALLINT NOT NULL DEFAULT 0,
  session_version  BIGINT NOT NULL DEFAULT 1,     -- bump to sign out every session
  settings_json    TEXT NOT NULL DEFAULT '{}',
  created_at       BIGINT NOT NULL,
  last_login_at    BIGINT
);

-- One-time codes for OTP login and password reset (hashed, short-lived).
CREATE TABLE otp_codes (
  email      CITEXT NOT NULL,
  purpose    TEXT NOT NULL CHECK (purpose IN ('login', 'reset')),
  code_hash  TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  sent_at    BIGINT NOT NULL,
  PRIMARY KEY (email, purpose)
);

-- Personal tokens: 'api' for scripts using the API, 'agent' for the Discord agent.
CREATE TABLE api_tokens (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('api', 'agent')),
  name         TEXT NOT NULL DEFAULT '',
  token_hash   TEXT NOT NULL UNIQUE,
  prefix       TEXT NOT NULL,
  created_at   BIGINT NOT NULL,
  last_used_at BIGINT
);
CREATE INDEX api_tokens_user ON api_tokens(user_id);

-- ── shared music store: one row and one file per song, whoever downloaded it
CREATE TABLE tracks (
  id             TEXT PRIMARY KEY,
  source         TEXT NOT NULL DEFAULT 'youtube',
  source_id      TEXT UNIQUE,
  source_url     TEXT NOT NULL DEFAULT '',
  title          TEXT NOT NULL,
  artist         TEXT NOT NULL DEFAULT '',
  album          TEXT NOT NULL DEFAULT '',
  duration_ms    BIGINT NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  file_path      TEXT NOT NULL,
  mime           TEXT NOT NULL,
  size_bytes     BIGINT NOT NULL DEFAULT 0,
  has_cover      SMALLINT NOT NULL DEFAULT 0,
  loudness_lufs  DOUBLE PRECISION,
  gain_db        DOUBLE PRECISION NOT NULL DEFAULT 0,
  loudness_done  SMALLINT NOT NULL DEFAULT 0,     -- measured in the background
  search         TEXT NOT NULL DEFAULT '',
  -- vi | en | ja | ko | zh | th | '' (unknown): keeps recommendations from mixing languages
  lang           TEXT NOT NULL DEFAULT '',
  added_at       BIGINT NOT NULL
);
CREATE INDEX tracks_artist ON tracks(artist);

CREATE TABLE lyrics (
  track_id   TEXT PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  plain      TEXT NOT NULL DEFAULT '',
  synced     TEXT NOT NULL DEFAULT '',
  source     TEXT NOT NULL CHECK (source IN ('lrclib', 'manual', 'none')),
  offset_ms  BIGINT NOT NULL DEFAULT 0,
  lrclib_id  BIGINT NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL
);

-- Hand-crafted audio feature vector per track (spectral stats, energy, tempo).
CREATE TABLE track_features (
  track_id    TEXT PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  vec         TEXT NOT NULL,          -- JSON array of floats; empty array = extraction failed
  computed_at BIGINT NOT NULL
);

-- Cached responses from Deezer / Last.fm / MusicBrainz.
CREATE TABLE ext_cache (
  key        TEXT PRIMARY KEY,
  json       TEXT NOT NULL,
  fetched_at BIGINT NOT NULL
);

-- Server-wide settings (audio format, branding…), edited by admins.
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
  added_at       BIGINT NOT NULL,
  play_count     BIGINT NOT NULL DEFAULT 0,
  last_played_at BIGINT,
  PRIMARY KEY (user_id, track_id)
);
CREATE INDEX user_tracks_track ON user_tracks(track_id);
CREATE INDEX user_tracks_added ON user_tracks(user_id, added_at);

CREATE TABLE likes (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id   TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, track_id)
);
CREATE INDEX likes_track ON likes(track_id);

CREATE TABLE playlists (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  kind       TEXT NOT NULL CHECK (kind IN ('manual', 'smart')),
  rule_json  TEXT,
  source     TEXT NOT NULL DEFAULT '',            -- YouTube Music playlist id it was saved from
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX playlists_user ON playlists(user_id, updated_at);

CREATE TABLE playlist_items (
  playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  track_id    TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  position    BIGINT NOT NULL,
  added_at    BIGINT NOT NULL,
  PRIMARY KEY (playlist_id, track_id)
);
CREATE INDEX playlist_items_pos ON playlist_items(playlist_id, position);
CREATE INDEX playlist_items_track ON playlist_items(track_id);

CREATE TABLE listen_events (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id   TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  started_at BIGINT NOT NULL,
  played_ms  BIGINT NOT NULL DEFAULT 0 CHECK (played_ms >= 0),
  action     TEXT NOT NULL CHECK (action IN ('finish', 'skip', 'repeat')),
  hour       SMALLINT NOT NULL CHECK (hour BETWEEN 0 AND 23),
  source     TEXT NOT NULL DEFAULT ''
);
CREATE INDEX listen_events_user_time ON listen_events(user_id, started_at);
CREATE INDEX listen_events_track ON listen_events(track_id);

CREATE TABLE feedback (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('artist', 'track')),
  key        TEXT NOT NULL,          -- folded artist name, or track id
  value      SMALLINT NOT NULL CHECK (value IN (-1, 1)),
  created_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, kind, key)
);

CREATE TABLE download_jobs (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url          TEXT NOT NULL,
  source_id    TEXT,
  title        TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL CHECK (status IN ('queued', 'downloading', 'processing', 'done', 'error', 'skipped')),
  progress     DOUBLE PRECISION NOT NULL DEFAULT 0,
  stage        TEXT NOT NULL DEFAULT '',
  error        TEXT NOT NULL DEFAULT '',
  track_id     TEXT,
  origin       TEXT NOT NULL DEFAULT 'user' CHECK (origin IN ('user', 'autoplay', 'auto')),
  playlist_id  TEXT,                              -- saved YouTube Music playlist it fills
  playlist_pos BIGINT NOT NULL DEFAULT 0,
  created_at   BIGINT NOT NULL,
  updated_at   BIGINT NOT NULL
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
  removed_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, source_id)
);

-- Lyrics a user picked for a track (from search, pasted, or just their offset
-- on the automatic ones). When several users pick the same LRCLIB entry,
-- it becomes the suggestion for everyone else.
CREATE TABLE lyrics_choices (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id   TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  source     TEXT NOT NULL CHECK (source IN ('auto', 'lrclib', 'manual')),
  lrclib_id  BIGINT NOT NULL DEFAULT 0,
  plain      TEXT NOT NULL DEFAULT '',
  synced     TEXT NOT NULL DEFAULT '',
  offset_ms  BIGINT NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, track_id)
);
CREATE INDEX lyrics_choices_track ON lyrics_choices(track_id, lrclib_id);
