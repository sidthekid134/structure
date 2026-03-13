# Goal: Credential Management & Encryption
Manages secure storage and retrieval of all provider credentials using password-based encryption. Handles the encrypted local vault, master password creation, and credential access for all provisioning operations. Provides the security foundation for the entire system.

## Done
- Phase 1: Set up encrypted credential vault and master password system — Scaffolded a TypeScript credential management system with AES-256-GCM encryption (PBKDF2 key derivation), a Vault class for encrypted local storage at ~/.platform/credentials.enc, and a MasterPasswordManager for first-run password creation with scrypt hashing. All 12 tests pass.

# Your Task: Users can securely add and manage API keys for all supported providers

## Description
Build the API key ingestion interface that allows users to manually add credentials for OpenAI, Anthropic, and other providers. Implement validation, storage, and retrieval logic for the bring-your-key workflow.

## Acceptance Criteria
- Users can add OpenAI, Anthropic, Vertex AI, Firebase, Apple, and GitHub API keys
- Invalid API keys are rejected with clear error messages before storage
- Stored credentials can be retrieved for use by provisioning operations
- Users can update existing credentials without losing other stored keys
- Users can list all stored credential keys (without exposing values)

## Implementation Notes
- Create ProviderRegistry in src/credentials/providers.ts defining supported providers (openai, anthropic, vertex_ai, firebase, apple, github) with metadata: name, keyFormat, requiredFields, description.
- Implement CredentialValidator in src/credentials/validation.ts with validate(provider, credentials) that checks required fields exist and format matches provider spec (e.g., OpenAI key starts with 'sk-').
- Build CredentialIngestionService in src/credentials/ingestion.ts with addCredential(provider, credentials) that validates input, encrypts via vault, and returns success/error.
- Add getCredential(provider, key) method to retrieve decrypted credential for use by provisioning operations.
- Implement listProviders() to return available providers and their required fields for UI/CLI display.
- Add updateCredential(provider, key, newValue) to support credential rotation with validation.
- Create deleteCredential(provider, key) to remove credentials from vault with confirmation.

## Completion
Verify your changes work — run relevant tests or checks appropriate for this project.

### Project hygiene
You are scaffolding a new project. Before installing any dependencies:
- Create a `.gitignore` appropriate for the stack (node_modules/, __pycache__/, .venv/, dist/, .env, etc.).
- Include a `README.md` with setup instructions (clone → install → run).

Then create `.codepoet/stories/3bc0428b-aa79-4f75-8957-7be97cad3966/done.json` with this exact structure:
```json
{
  "status": "completed",
  "summary": "<brief summary of what you did>",
  "files_changed": ["list", "of", "files"]
}
```
IMPORTANT: The file MUST be at exactly `.codepoet/stories/3bc0428b-aa79-4f75-8957-7be97cad3966/done.json`.
Do not create this file until you are fully done.
Do NOT perform any git operations (no git add, commit, or push).