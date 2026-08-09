-- Alan Library — initial database schema.
--
-- images          one row per uploaded image (the core asset)
-- tags            the controlled vocabulary (canonical tag names, grouped by category)
-- image_tags      which tags apply to which image, and whether AI or you added them
-- videos          derived videos, each attached to one parent image
-- import_batches  one row per bulk import (so progress survives page refreshes)
-- import_items    per-file status inside a batch (upload + analysis + errors)

CREATE TABLE images (
  id TEXT PRIMARY KEY,
  original_filename TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  thumbnail_key TEXT,
  mime_type TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  file_hash TEXT,
  description TEXT,
  character TEXT,
  location TEXT,
  mood TEXT,
  time_of_day TEXT,
  shot_type TEXT,
  camera_angle TEXT,
  pose TEXT,
  -- UPLOADING / UPLOADED / QUEUED / ANALYZING / READY / ERROR / ARCHIVED
  analysis_status TEXT NOT NULL DEFAULT 'UPLOADED',
  analysis_error TEXT,
  -- 1 when you manually edited the description, so AI reprocessing never overwrites it
  description_edited INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_images_created_at ON images (created_at DESC);
CREATE INDEX idx_images_analysis_status ON images (analysis_status);
CREATE INDEX idx_images_file_hash ON images (file_hash);

CREATE TABLE tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  canonical_name TEXT NOT NULL,
  -- CHARACTER / ACTIVITY / LOCATION / MOOD / TIME / SHOT_TYPE / CAMERA_ANGLE /
  -- POSE / OBJECT / VISUAL / PROJECT
  category TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (canonical_name, category)
);

CREATE INDEX idx_tags_category ON tags (category);

CREATE TABLE image_tags (
  image_id TEXT NOT NULL REFERENCES images (id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
  -- 'AI' when added by analysis, 'USER' when added by you
  source TEXT NOT NULL DEFAULT 'AI',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (image_id, tag_id)
);

CREATE INDEX idx_image_tags_tag_id ON image_tags (tag_id);

CREATE TABLE videos (
  id TEXT PRIMARY KEY,
  parent_image_id TEXT NOT NULL REFERENCES images (id),
  original_filename TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  thumbnail_key TEXT,
  mime_type TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  duration_seconds REAL,
  width INTEGER,
  height INTEGER,
  title TEXT,
  model TEXT,
  prompt TEXT,
  notes TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_videos_parent_image_id ON videos (parent_image_id);

CREATE TABLE import_batches (
  id TEXT PRIMARY KEY,
  total_items INTEGER NOT NULL DEFAULT 0,
  upload_completed INTEGER NOT NULL DEFAULT 0,
  analysis_completed INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  -- ACTIVE / DONE
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE import_items (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES import_batches (id) ON DELETE CASCADE,
  image_id TEXT REFERENCES images (id),
  original_filename TEXT NOT NULL,
  -- PENDING / UPLOADING / DONE / ERROR
  upload_status TEXT NOT NULL DEFAULT 'PENDING',
  -- PENDING / QUEUED / ANALYZING / DONE / ERROR
  analysis_status TEXT NOT NULL DEFAULT 'PENDING',
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_import_items_batch_id ON import_items (batch_id);
