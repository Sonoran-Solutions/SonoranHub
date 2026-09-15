CREATE TABLE machines (
  id text PRIMARY KEY,
  name text NOT NULL,
  platform text NOT NULL,
  arch text NOT NULL,
  agent_version text NOT NULL,
  capabilities jsonb NOT NULL,
  policy_revision text NOT NULL,
  last_seen_at timestamptz NOT NULL,
  telemetry jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX machines_last_seen_idx ON machines (last_seen_at DESC, name ASC, id ASC);
