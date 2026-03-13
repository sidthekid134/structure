# Goal: Credential Management & Encryption
Manages secure storage and retrieval of all provider credentials using password-based encryption. Handles the encrypted local vault, master password creation, and credential access for all provisioning operations. Provides the security foundation for the entire system.

## Done
- Phase 1: Set up encrypted credential vault and master password system — Scaffolded a TypeScript credential management system with AES-256-GCM encryption (PBKDF2 key derivation), a Vault class for encrypted local storage at ~/.platform/credentials.enc, and a MasterPasswordManager for first-run password creation with scrypt hashing. All 12 tests pass.
- Phase 2: Implement credential ingestion for bring-your-key flow — Implemented API key ingestion interface with ProviderRegistry (openai, anthropic, vertex_ai, firebase, apple, github), CredentialValidator with format checks, and CredentialIngestionService with add/get/update/delete/list operations. Added delete method to Vault. All 31 tests pass.

# Your Task: Provisioning operations can safely access and use credentials with built-in safety guards

## Description
Create the interface that provisioning operations use to retrieve credentials, with support for credential propagation to multiple destinations (Vertex AI, OpenAI, Anthropic). Implement concurrent operation locking and idempotency checks.

## Acceptance Criteria
- Only one provisioning operation can run on the same app at a time
- Multiple provisioning operations can run simultaneously on different apps
- Failed provisioning operations can be retried without re-executing completed steps
- A single LLM API key can be propagated to Vertex AI, OpenAI, and Anthropic in one operation
- Provisioning operations can access credentials without exposing them in logs or error messages

## Implementation Notes
- Create CredentialAccessContext in src/credentials/access-control.ts that wraps a provisioning operation with app-level locking: allow concurrent operations for different apps, block concurrent operations on same app.
- Implement OperationLock in src/credentials/operation-lock.ts using file-based locking (~/.platform/locks/{appId}.lock) with timeout and cleanup on operation completion.
- Build CredentialPropagator in src/credentials/propagation.ts with propagate(llmApiKey, destinations) that distributes a single LLM API key to multiple providers (Vertex AI, OpenAI, Anthropic) with per-destination error handling.
- Add getCredentialForOperation(operationId, provider, key) that retrieves credential within operation context and logs access for audit trail.
- Implement idempotency checking: each provisioning step stores completion marker in ~/.platform/operations/{operationId}/{stepName}.done, allowing retry to skip completed steps.
- Create OperationState interface tracking: operationId, appId, startTime, steps completed, current step, errors encountered.
- Add rollback support: if operation fails partway, store error state but keep completed work intact for retry (no cleanup on failure).

## Completion
Verify your changes work — run relevant tests or checks appropriate for this project.

### Project hygiene
You are scaffolding a new project. Before installing any dependencies:
- Create a `.gitignore` appropriate for the stack (node_modules/, __pycache__/, .venv/, dist/, .env, etc.).
- Include a `README.md` with setup instructions (clone → install → run).

Then create `.codepoet/stories/5cb8f927-35dd-4e31-a5e8-b42c2bfd9150/done.json` with this exact structure:
```json
{
  "status": "completed",
  "summary": "<brief summary of what you did>",
  "files_changed": ["list", "of", "files"]
}
```
IMPORTANT: The file MUST be at exactly `.codepoet/stories/5cb8f927-35dd-4e31-a5e8-b42c2bfd9150/done.json`.
Do not create this file until you are fully done.
Do NOT perform any git operations (no git add, commit, or push).