CREATE TABLE IF NOT EXISTS provisioning_operations (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id         TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('pending', 'in_progress', 'completed', 'failed')),
  environment    TEXT NOT NULL CHECK (environment IN ('dev', 'preview', 'production')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  error_message  TEXT,
  lock_acquired_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_provisioning_operations_app_env_status
  ON provisioning_operations (app_id, environment, status);

CREATE TABLE IF NOT EXISTS provisioning_queue (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id   UUID NOT NULL REFERENCES provisioning_operations(id) ON DELETE CASCADE,
  adapter_name   TEXT NOT NULL,
  position       INTEGER NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS provisioning_dependencies (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id        UUID NOT NULL REFERENCES provisioning_operations(id) ON DELETE CASCADE,
  adapter_name        TEXT NOT NULL,
  depends_on_adapter  TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
