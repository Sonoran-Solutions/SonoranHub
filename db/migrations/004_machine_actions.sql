ALTER TABLE machines
  ADD COLUMN action_catalog jsonb NOT NULL DEFAULT '{"repositories":[],"services":[]}'::jsonb;

CREATE TABLE machine_actions (
  action_id uuid PRIMARY KEY,
  machine_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('repo.status', 'service.restart')),
  target_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'DENIED', 'FAILED', 'TIMED_OUT', 'INTERRUPTED')),
  policy_revision text NOT NULL,
  requested_at timestamptz NOT NULL,
  started_at timestamptz,
  completed_at timestamptz,
  result jsonb,
  error jsonb
);

CREATE INDEX machine_actions_machine_requested_idx
  ON machine_actions (machine_id, requested_at DESC, action_id DESC);
