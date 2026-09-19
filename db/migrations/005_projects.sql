CREATE TABLE projects (
  id text PRIMARY KEY,
  name text NOT NULL,
  description text,
  attention_labels jsonb NOT NULL DEFAULT '[]'::jsonb,
  configured boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE project_repositories (
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner text NOT NULL,
  name text NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, owner, name)
);

CREATE TABLE project_github_snapshots (
  id uuid PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  collected_at timestamptz NOT NULL,
  freshness text NOT NULL CHECK (freshness IN ('fresh', 'stale', 'unavailable', 'partial')),
  data jsonb NOT NULL,
  error jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX project_github_snapshots_project_collected_idx
  ON project_github_snapshots (project_id, collected_at DESC, created_at DESC, id DESC);
