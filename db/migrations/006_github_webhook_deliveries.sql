CREATE TABLE github_webhook_deliveries (
  delivery_id text PRIMARY KEY,
  event_name text NOT NULL,
  repository_owner text,
  repository_name text,
  outcome text NOT NULL,
  received_at timestamptz NOT NULL,
  processed_at timestamptz
);

CREATE INDEX github_webhook_deliveries_received_at_idx
  ON github_webhook_deliveries (received_at DESC);
