CREATE TABLE schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE capacity_snapshots (
  id text PRIMARY KEY,
  provider_id text NOT NULL,
  collected_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  resources jsonb NOT NULL,
  freshness text NOT NULL CHECK (freshness IN ('fresh', 'stale', 'unknown')),
  error jsonb,
  metadata jsonb
);

CREATE INDEX capacity_snapshots_provider_collected_idx
  ON capacity_snapshots (provider_id, collected_at DESC, created_at DESC, id DESC);

CREATE INDEX capacity_snapshots_collected_idx
  ON capacity_snapshots (collected_at DESC, created_at DESC, id DESC);
