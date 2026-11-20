-- Background enrichment of shared tracks: lyrics written into the audio file,
-- genres / tags from Deezer (and Last.fm), names checked on MusicBrainz.

-- Where the title / artist came from: ytm (YouTube Music, trusted), heuristic
-- (guessed from a video title), musicbrainz (confirmed there), manual (edited).
ALTER TABLE tracks ADD COLUMN meta_source TEXT NOT NULL DEFAULT '';
-- 0 pending, 1 lyrics embedded, -1 no lyrics to embed, -2 retry later (file busy)
ALTER TABLE tracks ADD COLUMN lyrics_embedded SMALLINT NOT NULL DEFAULT 0;
-- lowercase genres / tags, comma-separated ("pop,ballad,vpop")
ALTER TABLE tracks ADD COLUMN genres TEXT NOT NULL DEFAULT '';
ALTER TABLE tracks ADD COLUMN genres_done SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE tracks ADD COLUMN mb_done SMALLINT NOT NULL DEFAULT 0;

CREATE INDEX tracks_enrich ON tracks (lyrics_embedded, genres_done, mb_done);
