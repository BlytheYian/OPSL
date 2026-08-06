

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
  floor_risks_cache JSONB,
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
  category TEXT,
  baked_centroid_x NUMERIC,
  baked_centroid_y NUMERIC,
  baked_centroid_z NUMERIC,
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

CREATE TABLE risk_markers (
  id SERIAL PRIMARY KEY,
  scene_version_id INTEGER NOT NULL REFERENCES scene_versions(id) ON DELETE CASCADE,
  risk_type TEXT NOT NULL CHECK (risk_type IN ('門檻', '家具邊角', '地面高低差', '走道障礙')),
  bbox_min_x NUMERIC(8, 4) NOT NULL,
  bbox_min_y NUMERIC(8, 4) NOT NULL,
  bbox_min_z NUMERIC(8, 4) NOT NULL,
  bbox_max_x NUMERIC(8, 4) NOT NULL,
  bbox_max_y NUMERIC(8, 4) NOT NULL,
  bbox_max_z NUMERIC(8, 4) NOT NULL
);

CREATE INDEX idx_risk_markers_version ON risk_markers(scene_version_id);
