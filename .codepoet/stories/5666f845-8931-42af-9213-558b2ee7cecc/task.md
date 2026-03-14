# Project
This application manages secure credential storage and retrieval for multiple external service providers. Users can securely encrypt and store credentials for different providers, then retrieve them when needed for authentication or integration purposes.
Stack: TypeScript
Patterns:
- Error Handling: The codebase implements custom exception handling with two specialized error types: LockTimeoutError and NotFoundError, enabling precise error categorization for lock acquisition failures and missing resource scenarios.
- Testing Patterns: The codebase uses jest as its testing framework with 57 test cases distributed across 6 test files, providing comprehensive coverage for credentials, access control, encryption, and data ingestion functionality.
- Async Patterns: The codebase employs async/await patterns across 3 async functions (withOperation, setup, and acquire) to handle asynchronous operations for lock management, master password initialization, and concurrent operation execution.
- File Organization: The codebase follows a flat file structure organized into logical directories (src/types, src/credentials, src) without deep nesting, keeping related functionality accessible and maintainable.
- Code Style: The codebase is untyped, lacking TypeScript or similar type annotation systems, which may impact development velocity and code maintainability as the project scales.

# Goal: Provisioning Orchestration Engine
Core orchestration system that manages sequential multi-adapter execution with dependency ordering. Implements concurrency control using PostgreSQL advisory locks, queuing system for blocked operations, and coordinates the overall provisioning workflow across all providers.

## Done
- **Phase 1: Set up provisioning state schema and advisory lock infrastructure** — Created PostgreSQL-backed provisioning schema and TypeScript implementation: three database tables (provisioning_operations, provisioning_queue, provisioning_dependencies) with composite index, acquireLock using pg_advisory_xact_lock with timeout handling, releaseLock with queue processing trigger, and queueOperation inserting rows into both queue and dependency tables. Added pg dependency and full test coverage.
  Files: src/types/provisioning.ts, src/db/provisioning.ts, src/db/provisioning.test.ts, src/db/migrations/001_provisioning.sql, package.json

# Your Task: Orchestration service executes multi-adapter provisioning with dependency ordering and lock control

## Description
Build the core orchestration service that acquires locks, executes adapters sequentially based on dependencies, manages credential retrieval from the database, and handles operation state transitions. This coordinates the entire provisioning workflow.

## Acceptance Criteria
- Only one provisioning operation runs on the same app and environment at a time
- Adapters execute in the order specified by dependencies
- Credentials are decrypted before being passed to adapters
- Failed operations are marked as failed and can be retried without rolling back created resources
- Queued operations automatically start when the lock is released

## Implementation Notes
- Create ProvisioningOrchestrator class in src/services/provisioning-orchestrator.ts with method executeProvisioning(appId, environment, adapterSequence, timeout) that acquires lock, executes adapters in order, and releases lock on completion or error.
- Implement executeAdapterSequence(operation, adapters) method that iterates through adapters in dependency order, passing previous adapter outputs as inputs to next adapter, and updating provisioning_queue status after each adapter completes.
- Create CredentialResolver class in src/services/credential-resolver.ts with method resolveCredentials(operationId, providerName) that queries encrypted credentials from database, decrypts using existing decrypt() function, and returns plaintext credentials to adapter.
- Implement AdapterExecutor class in src/services/adapter-executor.ts with method executeAdapter(adapterName, inputs, credentials) that invokes the named adapter with provided credentials and input data, catching adapter errors and returning structured results.
- Add state transition logic: update provisioning_operations.status to in_progress when lock acquired, completed when all adapters finish, failed with error_message if any adapter fails.
- Implement automatic queue processing: after releaseLock(), query provisioning_queue for next queued operation on same app and call executeProvisioning() recursively.
- Add input validation: verify adapterSequence is non-empty, all adapters exist in provider registry, and dependencies form a valid DAG (no circular dependencies).
- Implement partial failure handling: on adapter failure, mark operation as failed, leave created resources in place, and allow retry by calling executeProvisioning() again with same appId.

## Completion
Verify your changes work — run relevant tests or checks appropriate for this project.

Then create `.codepoet/stories/5666f845-8931-42af-9213-558b2ee7cecc/done.json` with this exact structure:
```json
{
  "status": "completed",
  "summary": "<brief summary of what you did>",
  "files_changed": ["list", "of", "files"]
}
```
IMPORTANT: The file MUST be at exactly `.codepoet/stories/5666f845-8931-42af-9213-558b2ee7cecc/done.json`.
Do not create this file until you are fully done.
Do NOT perform any git operations (no git add, commit, or push).