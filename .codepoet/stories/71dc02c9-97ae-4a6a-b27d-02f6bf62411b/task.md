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

# Your Task: Encrypted credential storage ready to accept and validate all provider inputs

## Description
Create database tables to store collected credentials with encryption at rest, establish credential types and validation rules, and implement the encryption/decryption service using existing patterns from the codebase.

## Acceptance Criteria
- Credentials are encrypted at rest using AES-256-GCM with unique IVs per credential
- Plaintext values never appear in logs, error messages, or database queries
- Only one credential of each type can exist per project (unique constraint enforced)
- Soft-delete prevents accidental data loss while allowing audit trails
- Decryption only happens on-demand when credentials are needed for API calls

## Implementation Notes
- Create credentials table with columns: id (uuid), projectId (uuid), credentialType (enum: github_pat, cloudflare_token, apple_p8, apple_team_id, google_play_key, expo_token, domain_name), encryptedValue (bytea), metadata (jsonb for file hashes/validation data), createdAt (timestamptz), updatedAt (timestamptz), deletedAt (timestamptz for soft deletes).
- Add unique constraint on (projectId, credentialType) to prevent duplicate credential types per project.
- Extend credentialService.ts with encrypt() and decrypt() methods reusing the AES-256-GCM pattern from src/__tests__/encryption.test.ts, storing IV and auth tag in metadata.
- Implement validateCredential(type, value) method that delegates to type-specific validators (e.g., validateGitHubPAT, validateAppleP8FileHash, validateCloudflareToken format).
- Add storeCredential(projectId, type, value, metadata) method that encrypts and persists, returning credential ID without exposing plaintext.
- Create retrieveCredential(credentialId) method that decrypts on-demand only when needed for API calls, with audit logging of access.
- Add deleteCredential(credentialId) method that soft-deletes and overwrites encryptedValue with random bytes before hard delete after 30 days.
- Create migration file with proper indexes on (projectId, credentialType) and (deletedAt) for soft-delete queries.

## Completion
Verify your changes work — run relevant tests or checks appropriate for this project.

Then create `.codepoet/stories/71dc02c9-97ae-4a6a-b27d-02f6bf62411b/done.json` with this exact structure:
```json
{
  "status": "completed",
  "summary": "<brief summary of what you did>",
  "files_changed": ["list", "of", "files"]
}
```
IMPORTANT: The file MUST be at exactly `.codepoet/stories/71dc02c9-97ae-4a6a-b27d-02f6bf62411b/done.json`.
Do not create this file until you are fully done.
Do NOT perform any git operations (no git add, commit, or push).