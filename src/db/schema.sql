-- Provisioning operations: one row per provisioning job attempt.
-- idempotency_key prevents duplicate operations for the same app+provider.
CREATE TABLE IF NOT EXISTS provisioning_operations (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id           UUID        NOT NULL,
  provider         TEXT        NOT NULL,
  status           TEXT        NOT NULL CHECK (status IN ('pending', 'in_progress', 'success', 'failed')),
  started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at     TIMESTAMPTZ,
  error_message    TEXT,
  idempotency_key  TEXT        NOT NULL,
  CONSTRAINT provisioning_operations_idempotency_key_unique UNIQUE (idempotency_key)
);

-- Composite unique index to prevent duplicate operations per app+provider+idempotency_key.
CREATE UNIQUE INDEX IF NOT EXISTS provisioning_operations_app_provider_idempotency_key_idx
  ON provisioning_operations (app_id, provider, idempotency_key);

-- Provider credentials: one row per app+provider pair.
-- encrypted_payload is the AES-256-GCM ciphertext (salt || iv || authTag || ciphertext).
CREATE TABLE IF NOT EXISTS provider_credentials (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id            UUID        NOT NULL,
  provider          TEXT        NOT NULL,
  encrypted_payload BYTEA       NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT provider_credentials_app_provider_unique UNIQUE (app_id, provider)
);

-- Audit log: append-only, one row per step within a provisioning operation.
CREATE TABLE IF NOT EXISTS provisioning_operation_logs (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id UUID        NOT NULL REFERENCES provisioning_operations (id) ON DELETE CASCADE,
  step         TEXT        NOT NULL,
  result       JSONB       NOT NULL DEFAULT '{}',
  timestamp    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for fast lookup of logs by operation.
CREATE INDEX IF NOT EXISTS provisioning_operation_logs_operation_id_idx
  ON provisioning_operation_logs (operation_id);
