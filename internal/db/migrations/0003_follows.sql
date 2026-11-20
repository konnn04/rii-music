-- Artists a user follows: shown in the sidebar, and a strong taste signal.
-- key is the loose name (accents and case folded) so "Đen" and "den" are one.
CREATE TABLE artist_follows (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  name       TEXT NOT NULL,
  image      TEXT NOT NULL DEFAULT '',  -- artist picture from YouTube Music, if known
  created_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, key)
);
