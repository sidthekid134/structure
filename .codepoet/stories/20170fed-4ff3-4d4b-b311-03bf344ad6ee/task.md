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

# Your Task: All inputs validated and errors clearly reported to users

## Description
Implement comprehensive input validation on all provisioning endpoints and improve error handling throughout the orchestration layer. This addresses the high-priority anomaly of missing input validation and ensures robust error reporting.

## Acceptance Criteria
- Invalid appId, environment, or adapterSequence values are rejected with 400 Bad Request
- Missing credentials for required providers are reported with clear error messages
- Circular dependencies in adapter sequences are detected and rejected
- All errors include context (appId, operationId, failedAdapter) for debugging

## Implementation Notes
- Create ProvisioningValidator class in src/validation/provisioning-validator.ts with method validateProvisioningRequest(appId, environment, adapterSequence, timeout) that checks appId is non-empty string, environment is dev/preview/production, adapterSequence is non-empty array, timeout is positive integer, and all adapters exist in provider registry.
- Add validateCredentialsExist(operationId, providerName) method that queries database and throws NotFoundError if credentials not found for provider.
- Add validateDependencyDAG(adapterSequence, dependencies) method that checks for circular dependencies and throws error if DAG is invalid.
- Implement error wrapping in ProvisioningOrchestrator: catch all adapter errors and wrap with context (appId, environment, adapterName, step) before storing in error_message column.
- Add validation to CredentialResolver: verify operation exists before querying credentials, throw NotFoundError if operation not found, throw error if credentials missing for required provider.
- Add validation to API routes: call ProvisioningValidator.validateProvisioningRequest() before calling executeProvisioning(), return 400 Bad Request with validation error details.
- Implement structured error responses: return JSON with error code, message, and context (appId, operationId, failedAdapter) for all error cases.
- Add try-catch blocks in queue processing: catch errors when processing queued operations and mark operation as failed instead of crashing.

## Completion
Verify your changes work — run relevant tests or checks appropriate for this project.

Then create `.codepoet/stories/20170fed-4ff3-4d4b-b311-03bf344ad6ee/done.json` with this exact structure:
```json
{
  "status": "completed",
  "summary": "<brief summary of what you did>",
  "files_changed": ["list", "of", "files"]
}
```
IMPORTANT: The file MUST be at exactly `.codepoet/stories/20170fed-4ff3-4d4b-b311-03bf344ad6ee/done.json`.
Do not create this file until you are fully done.
Do NOT perform any git operations (no git add, commit, or push).