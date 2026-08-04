

CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE library_scenes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  thumbnail_url TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready',
  owner_user_id INTEGER REFERENCES users(id),
  copied_from_scene_id TEXT REFERENCES library_scenes(id),
  celery_task_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE library_objects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  thumbnail_url TEXT NOT NULL,
  description TEXT NOT NULL,
  model_url TEXT NOT NULL,
  origin_scene_id TEXT REFERENCES library_scenes(id),
  status TEXT NOT NULL DEFAULT 'ready',
  owner_user_id INTEGER REFERENCES users(id),
  asset_kind TEXT NOT NULL DEFAULT 'gsplat',
  clip_embedding REAL[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_library_objects_origin_scene ON library_objects(origin_scene_id);

CREATE TABLE scene_object_instances (
  id TEXT PRIMARY KEY,
  scene_id TEXT NOT NULL REFERENCES library_scenes(id),
  model_id TEXT NOT NULL REFERENCES library_objects(id),
  label TEXT NOT NULL,
  hidden BOOLEAN NOT NULL DEFAULT false,
  pos_x NUMERIC NOT NULL DEFAULT 0,
  pos_y NUMERIC NOT NULL DEFAULT 0,
  pos_z NUMERIC NOT NULL DEFAULT 0,
  rot_x NUMERIC NOT NULL DEFAULT 0,
  rot_y NUMERIC NOT NULL DEFAULT 0,
  rot_z NUMERIC NOT NULL DEFAULT 0,
  scale_x NUMERIC NOT NULL DEFAULT 1,
  scale_y NUMERIC NOT NULL DEFAULT 1,
  scale_z NUMERIC NOT NULL DEFAULT 1,
  color TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_scene_object_instances_scene ON scene_object_instances(scene_id);

CREATE TABLE scene_versions (
  id SERIAL PRIMARY KEY,
  scene_id TEXT NOT NULL REFERENCES library_scenes(id),
  version_number INTEGER NOT NULL,
  created_by INTEGER REFERENCES users(id),
  snapshot JSONB NOT NULL,
  source_commands JSONB NOT NULL DEFAULT '[]'::jsonb,
  reverted_from_version_id INTEGER REFERENCES scene_versions(id),
  reverted_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_scene_versions_scene ON scene_versions(scene_id);
