-- Migration 001: Create credentials table
-- Stores encrypted provider credentials with soft-delete support.

CREATE TABLE IF NOT EXISTS credentials (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL,
  credential_type TEXT NOT NULL CHECK (
    credential_type IN (
      'github_pat',
      'cloudflare_token',
      'apple_p8',
      'apple_team_id',
      'google_play_key',
      'expo_token',
      'domain_name'
    )
  ),
  encrypted_value BLOB NOT NULL,
  metadata        TEXT NOT NULL DEFAULT '{}',  -- JSON: iv, authTag, fileHash, etc.
  created_at      TEXT NOT NULL,               -- ISO 8601 timestamp
  updated_at      TEXT NOT NULL,
  deleted_at      TEXT,                        -- NULL = active; set for soft-delete

  -- Only one active credential of each type per project
  UNIQUE (project_id, credential_type)
);

-- Fast lookups by project + type (primary access pattern)
CREATE INDEX IF NOT EXISTS idx_credentials_project_type
  ON credentials (project_id, credential_type);

-- Fast soft-delete queries (e.g. purge records deleted > 30 days ago)
CREATE INDEX IF NOT EXISTS idx_credentials_deleted_at
  ON credentials (deleted_at);
