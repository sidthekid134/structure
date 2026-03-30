# Project
A cloud infrastructure provisioning and management platform that helps teams set up and configure cloud services (Firebase, GCP, GitHub, Expo) for their projects. Users can discover available integrations, plan infrastructure deployments through a visual provisioning system, execute multi-step setup workflows, and manage OAuth connections across multiple cloud providers.
Stack: TypeScript · JavaScript | Express
Patterns:
- Error Handling: The codebase implements custom exception handling with three specialized error types—GcpHttpError, OrchestrationError, and CredentialError—to provide granular error classification for GCP interactions, orchestration failures, and authentication issues.
- Testing Patterns: The codebase uses jest as its testing framework with 92 test cases distributed across 7 test files, providing comprehensive coverage for features like contributors, encryption, and journey phases.
- Async Patterns: Heavy reliance on async/await pattern with 185 async functions throughout the codebase, enabling concurrent API calls to GCP services such as token fetching, project summaries, and status checks.
- File Organization: The codebase follows a layered architecture with a dedicated model layer, organized test directory (src/__tests__), and shared utilities folder (studio-ui/src/lib), alongside feature-specific directories like orchestration and UI components.
- Code Style: The codebase is untyped, lacking TypeScript or similar type annotations, which may impact maintainability and IDE support for developers unfamiliar with the project.

# Goal: Input Collection & Credential Management
Centralized system for collecting and securely storing all missing user inputs and sensitive credentials. Implements encrypted storage for API tokens, validates file uploads (Apple .p8 keys), and manages cross-provider dependencies (domain names, team IDs, fingerprints). Includes validation, error handling, and retry flows for incorrect uploads.

## Done
- **Phase 1: Build credential storage schema and encryption layer** — Implemented encrypted credential storage using AES-256-GCM with SQLite (better-sqlite3). Created a migration SQL file defining the credentials table with a UNIQUE(project_id, credential_type) constraint, soft-delete via deleted_at, and indexes for fast lookups. Built CredentialService with: per-credential key derivation (master key × project × type), encrypt/decrypt methods that store IV and auth tag in the metadata JSON column (ciphertext kept separate in a BLOB column), type-specific validators for all 7 credential types, storeCredential (upsert with validation), retrieveCredential (on-demand decrypt with audit logging), deleteCredential (ciphertext overwritten with random bytes before soft-delete), and purgeExpiredCredentials for 30-day hard-delete policy. Added 39 tests covering all methods and security invariants (plaintext never in DB, tamper detection, UNIQUE enforcement, soft-delete lifecycle).
  Files: src/credentials/migrations/001_create_credentials_table.sql, src/credentials/credentialService.ts, src/__tests__/credential-service.test.ts

# Your Task: Endpoints to collect and validate all provider credentials with immediate feedback

## Description
Create REST endpoints to collect, validate, and store credentials for each provider (GitHub, Cloudflare, Apple, Google Play, Expo). Implement file upload handling for .p8 keys with format validation, and cross-provider dependency checking.

## Acceptance Criteria
- Invalid credentials are rejected with clear error messages before storage
- File uploads are validated for format and size before processing
- Cross-provider dependencies are checked and enforced (e.g., domain requires Cloudflare token)
- Plaintext credentials never appear in API responses or error messages
- Validation errors include actionable guidance (e.g., 'GitHub token missing repo scope')

## Implementation Notes
- Create POST /projects/:projectId/credentials/:credentialType endpoint that accepts JSON or multipart form data, validates input, stores encrypted credential, and returns {credentialId, type, validatedAt} without exposing plaintext.
- Implement fileUploadHandler middleware that limits file size to 10KB, validates MIME type, and streams to temporary directory with automatic cleanup after validation.
- Add validateGitHubPAT(token) that makes test API call to GET /user with token, checks for required scopes (repo, workflow, admin:org) in response headers, throws CredentialError if invalid or missing scopes.
- Add validateAppleP8(fileBuffer) that parses PEM format, extracts key ID and team ID from file metadata, computes SHA-256 hash for duplicate detection, throws CredentialError if malformed or already uploaded.
- Add validateCloudflareToken(token) that makes test API call to GET /accounts with token, verifies account access, throws CredentialError if invalid or expired.
- Add validateGooglePlayKey(fileBuffer) that parses JSON service account key, validates required fields (type, project_id, private_key_id), throws CredentialError if missing or malformed.
- Add validateExpoToken(token) that makes test API call to GET /me with token, verifies account exists, throws CredentialError if invalid.
- Create checkDependencies(projectId, credentialType) method that queries stored credentials to verify prerequisites (e.g., Cloudflare token required before storing domain name, Apple P8 requires team ID) and throws CredentialError if missing.

## Completion
Verify your changes work — run relevant tests or checks appropriate for this project.

Then create `.codepoet/stories/e0344e61-70d4-4414-836c-1a7f3cdbec47/done.json` with this exact structure:
```json
{
  "status": "completed",
  "summary": "<brief summary of what you did>",
  "files_changed": ["list", "of", "files"]
}
```
IMPORTANT: The file MUST be at exactly `.codepoet/stories/e0344e61-70d4-4414-836c-1a7f3cdbec47/done.json`.
Do not create this file until you are fully done.
Do NOT perform any git operations (no git add, commit, or push).