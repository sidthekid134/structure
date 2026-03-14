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

# Your Task: API endpoints enable users to provision credentials and monitor operation status

## Description
Create REST API endpoints for starting provisioning operations, checking operation status, and managing the operation queue. Integrate with the orchestration service to handle user requests and provide visibility into provisioning progress.

## Acceptance Criteria
- Users can start a provisioning operation and receive an operation ID
- Users can check the status of a provisioning operation at any time
- Users can see queued operations and their position in the queue
- Concurrent requests on the same app return a clear error message
- Failed operations return error details for debugging

## Implementation Notes
- Create POST /provisioning/start endpoint that accepts appId, environment, adapterSequence, and timeout; calls ProvisioningOrchestrator.executeProvisioning(); returns operation_id and initial status.
- Create GET /provisioning/:operationId endpoint that queries provisioning_operations table and returns current status, created_at, updated_at, error_message, and list of completed adapters from provisioning_queue.
- Create GET /provisioning/app/:appId/queue endpoint that returns all queued operations for the app sorted by created_at, showing position in queue and estimated wait time based on current operation progress.
- Implement QueueManager class in src/services/queue-manager.ts with method getQueueStatus(appId, environment) that queries provisioning_queue and provisioning_operations to calculate queue depth and current operation progress.
- Add error handling: catch LockTimeoutError and return 409 Conflict with message 'Another operation is in progress'; catch NotFoundError and return 404 with 'Operation not found'; catch validation errors and return 400 Bad Request.
- Implement request validation: verify appId is non-empty string, environment is one of dev/preview/production, adapterSequence is non-empty array of valid adapter names, timeout is positive integer.
- Add response logging: log operation_id, appId, environment, and adapter count to application logs for audit trail.
- Implement operation status polling: clients can call GET /provisioning/:operationId repeatedly to track progress; return 202 Accepted while in_progress, 200 OK when completed, 400 Bad Request if failed.

## Completion
Verify your changes work — run relevant tests or checks appropriate for this project.

Then create `.codepoet/stories/524d315a-936b-4d00-a540-7482ce3c5f1b/done.json` with this exact structure:
```json
{
  "status": "completed",
  "summary": "<brief summary of what you did>",
  "files_changed": ["list", "of", "files"]
}
```
IMPORTANT: The file MUST be at exactly `.codepoet/stories/524d315a-936b-4d00-a540-7482ce3c5f1b/done.json`.
Do not create this file until you are fully done.
Do NOT perform any git operations (no git add, commit, or push).