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
- **Phase 2: Implement provisioning orchestration service with adapter coordination** — Built the core provisioning orchestration service with three classes: CredentialResolver (wraps the file-based Vault to decrypt and return provider credentials), AdapterExecutor (invokes named adapters with inputs and credentials, catching errors into structured results), and ProvisioningOrchestrator (acquires PostgreSQL advisory locks, executes adapters in topological dependency order, manages operation state transitions in provisioning_operations, queues blocked operations via provisioning_queue, and automatically retries queued operations when locks are released). Includes input validation (non-empty sequence, all adapters registered, no circular dependencies via Kahn's algorithm), partial failure handling (failed operations marked with error_message, leaving resources intact for retry), and full test coverage.
  Files: src/services/credential-resolver.ts, src/services/adapter-executor.ts, src/services/provisioning-orchestrator.ts, src/services/credential-resolver.test.ts, src/services/adapter-executor.test.ts, src/services/provisioning-orchestrator.test.ts
- **Phase 3: Build provisioning API endpoints and queue management** — Added Express-based REST API endpoints for provisioning: POST /provisioning/start (starts an operation, returns operation_id), GET /provisioning/:operationId (polls status with 202/200/400 per state), GET /provisioning/app/:appId/queue (returns queue depth and positions). Implemented QueueManager class for queue status queries. Added request validation, error handling (409 for LockTimeoutError, 404 for missing ops, 400 for validation), and response logging. Added express/supertest dependencies and full test coverage.
  Files: package.json, src/app.ts, src/services/queue-manager.ts, src/services/queue-manager.test.ts, src/routes/provisioning.ts, src/routes/provisioning.test.ts
- **Phase 4: Add input validation and error handling improvements** — Implemented comprehensive input validation and improved error handling: created ProvisioningValidator class with validateProvisioningRequest (checks appId, environment, adapterSequence, timeout, adapter registry, DAG), validateCredentialsExist (DB operation lookup), and validateDependencyDAG (topological sort); updated CredentialResolver to throw when no credentials found for a provider; enhanced ProvisioningOrchestrator to wrap adapter errors with context (appId, env, operationId, adapterName, step) and properly catch queue processing errors; updated routes to use ProvisioningValidator with structured error responses including code and context fields.
  Files: src/validation/provisioning-validator.ts, src/validation/provisioning-validator.test.ts, src/services/credential-resolver.ts, src/services/credential-resolver.test.ts, src/services/provisioning-orchestrator.ts, src/services/provisioning-orchestrator.test.ts, src/routes/provisioning.ts

# Your Task: Test coverage validates orchestration logic and error handling

## Description
Write unit and integration tests for the provisioning orchestrator, credential resolver, queue manager, and API endpoints. Tests verify lock behavior, adapter sequencing, credential handling, and error scenarios.

## Acceptance Criteria
- Lock acquisition blocks concurrent operations on the same app
- Adapters execute in dependency order with correct data flow
- Credentials are decrypted before being passed to adapters
- Queue processes operations in order after locks release
- API endpoints validate inputs and return appropriate error codes
- Code coverage for orchestration layer is 80% or higher

## Implementation Notes
- Create provisioning-fixtures.ts with helper functions: createMockOperation(), createMockAdapter(), createMockCredentials() to reduce test boilerplate.
- Write tests for lock acquisition: verify acquireLock() blocks concurrent operations on same app, allows concurrent operations on different apps, throws LockTimeoutError after timeout.
- Write tests for adapter sequencing: verify adapters execute in dependency order, outputs from one adapter are passed to next, adapter failures stop execution.
- Write tests for credential resolution: verify resolveCredentials() decrypts credentials, throws NotFoundError if credentials missing, returns plaintext to adapter.
- Write tests for queue processing: verify queued operations start after lock release, queue processes in FIFO order, failed operations don't block queue.
- Write tests for API endpoints: verify POST /provisioning/start returns operation_id, GET /provisioning/:id returns status, concurrent requests return 409 Conflict, invalid inputs return 400 Bad Request.
- Write integration tests: provision end-to-end with multiple adapters, verify database state after completion, verify error recovery and retry behavior.
- Aim for 80%+ code coverage on orchestration layer using jest --coverage.

## Completion
Verify your changes work — run relevant tests or checks appropriate for this project.

Then create `.codepoet/stories/d2d72c68-f2fe-4f33-b2c3-13453dc97ac3/done.json` with this exact structure:
```json
{
  "status": "completed",
  "summary": "<brief summary of what you did>",
  "files_changed": ["list", "of", "files"]
}
```
IMPORTANT: The file MUST be at exactly `.codepoet/stories/d2d72c68-f2fe-4f33-b2c3-13453dc97ac3/done.json`.
Do not create this file until you are fully done.
Do NOT perform any git operations (no git add, commit, or push).