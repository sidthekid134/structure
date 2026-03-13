# Goal: Multi-Provider Provisioning Adapters
Implements provider-specific provisioning logic for all supported platforms (Firebase, GitHub, EAS, Apple Developer, Google Play, Cloudflare, OAuth). Each adapter handles API interactions, resource creation, and credential wiring for its respective platform. Includes rate limit handling with exponential backoff.

## Done
- Phase 1: Set up provisioning data models and credential storage — Created PostgreSQL schema (provisioning_operations, provider_credentials, provisioning_operation_logs tables with indexes and constraints), a database migration runner, and a CredentialStore service with async encrypt/decrypt using AES-256-GCM and scrypt key derivation (Argon2-equivalent) with master password hash stored at ~/.provisioning/master.key. Updated .gitignore and README.md. All 68 tests pass.

# Your Task: Establish reusable adapter pattern with automatic retry and rate limit handling

## Description
Create abstract provider adapter interface and implement exponential backoff retry logic. Build the foundation that all provider-specific adapters will extend.

## Acceptance Criteria
- Rate limit errors (HTTP 429) trigger automatic retry with exponential backoff
- Retries stop after 10 attempts or when max delay (60s) is reached
- Duplicate operations with same idempotency key return cached result instead of retrying
- Operation state transitions are logged to provisioning_operation_logs table

## Implementation Notes
- Create ProviderAdapter abstract class with methods: authenticate(credentials), provision(config), verify(resourceId), rollback(resourceId), all returning Promise<ProvisioningResult>
- Implement RateLimiter class that detects HTTP 429/quota errors and retries with exponential backoff: initial delay 1s, max delay 60s, max retries 10, jitter ±10%
- Add ProvisioningResult type with fields: success (boolean), resourceId (string), credentials (Record<string, string>), metadata (Record<string, any>), error (Error nullable)
- Create retry wrapper function that wraps any async operation and applies rate limit detection and exponential backoff automatically
- Implement idempotency check in base adapter: before provisioning, query provisioning_operations table for matching (app_id, provider, idempotency_key) and return cached result if found
- Add operation state machine: pending → in_progress → success/failed, with database updates at each transition
- Create ProviderConfig type with fields: apiKey (string), apiSecret (string nullable), baseUrl (string), timeout (number, default 30000)

## Completion
Verify your changes work — run relevant tests or checks appropriate for this project.

### Project hygiene
You are scaffolding a new project. Before installing any dependencies:
- Create a `.gitignore` appropriate for the stack (node_modules/, __pycache__/, .venv/, dist/, .env, etc.).
- Include a `README.md` with setup instructions (clone → install → run).

Then create `.codepoet/stories/62886cb8-bbf7-4bc3-a5cb-89b186922f2c/done.json` with this exact structure:
```json
{
  "status": "completed",
  "summary": "<brief summary of what you did>",
  "files_changed": ["list", "of", "files"]
}
```
IMPORTANT: The file MUST be at exactly `.codepoet/stories/62886cb8-bbf7-4bc3-a5cb-89b186922f2c/done.json`.
Do not create this file until you are fully done.
Do NOT perform any git operations (no git add, commit, or push).