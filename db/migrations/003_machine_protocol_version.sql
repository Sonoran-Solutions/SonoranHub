ALTER TABLE machines ADD COLUMN protocol_version integer;

UPDATE machines
SET protocol_version = 1
WHERE protocol_version IS NULL;

ALTER TABLE machines
  ALTER COLUMN protocol_version SET NOT NULL;
