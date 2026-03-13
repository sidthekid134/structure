# Goal: Multi-Provider Provisioning Adapters
Implements provider-specific provisioning logic for all supported platforms (Firebase, GitHub, EAS, Apple Developer, Google Play, Cloudflare, OAuth). Each adapter handles API interactions, resource creation, and credential wiring for its respective platform. Includes rate limit handling with exponential backoff.

# Your Task: Store provisioning state and encrypted credentials securely with audit trail

## Description
Create database schema for provisioning state, provider credentials, and operation history. Implement encrypted local credential storage with master password protection.

## Acceptance Criteria
- Credentials can be encrypted with a master password and decrypted correctly
- Each provisioning operation has a unique idempotency key to prevent duplicates
- All provider credentials are stored encrypted in the database
- Operation history is logged with timestamps and results for audit purposes

## Implementation Notes
- Create provisioning_operations table with columns: id (uuid), app_id (uuid), provider (text), status (text: pending/in_progress/success/failed), started_at (timestamptz), completed_at (timestamptz), error_message (text nullable), idempotency_key (text unique)
- Create provider_credentials table with columns: id (uuid), app_id (uuid), provider (text), encrypted_payload (bytea), created_at (timestamptz), updated_at (timestamptz), unique constraint on (app_id, provider)
- Create credential_store service that encrypts/decrypts credentials using libsodium or equivalent with master password derived via Argon2, store master password hash in ~/.provisioning/master.key
- Implement CredentialStore.encrypt(plaintext, masterPassword) and decrypt(ciphertext, masterPassword) methods returning Promise<string>
- Add provisioning_operation_logs table with columns: id (uuid), operation_id (uuid), step (text), result (jsonb), timestamp (timestamptz) for audit trail
- Create database migration file that runs schema.sql on first execution
- Add unique index on provisioning_operations(app_id, provider, idempotency_key) to prevent duplicate operations

## Completion
Verify your changes work — run relevant tests or checks appropriate for this project.

### Project hygiene
You are scaffolding a new project. Before installing any dependencies:
- Create a `.gitignore` appropriate for the stack (node_modules/, __pycache__/, .venv/, dist/, .env, etc.).
- Include a `README.md` with setup instructions (clone → install → run).

Then create `.codepoet/stories/c25f372d-a511-4a20-b837-e3928e75b24a/done.json` with this exact structure:
```json
{
  "status": "completed",
  "summary": "<brief summary of what you did>",
  "files_changed": ["list", "of", "files"]
}
```
IMPORTANT: The file MUST be at exactly `.codepoet/stories/c25f372d-a511-4a20-b837-e3928e75b24a/done.json`.
Do not create this file until you are fully done.
Do NOT perform any git operations (no git add, commit, or push).