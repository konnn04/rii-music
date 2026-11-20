-- "Không thích" lists: keep the artist's name as the user saw it (key is folded).
ALTER TABLE feedback ADD COLUMN label TEXT NOT NULL DEFAULT '';
