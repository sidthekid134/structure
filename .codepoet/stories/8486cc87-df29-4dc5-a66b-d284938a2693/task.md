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

# Your Task: Database schema supports lock-based concurrency control and operation queuing

## Description
Create the database tables and functions needed to track provisioning operations, manage PostgreSQL advisory locks, and queue blocked operations. This establishes the foundation for concurrent operation control.

## Acceptance Criteria
- Database schema supports storing provisioning operations with environment context (dev/preview/production)
- Advisory lock acquisition blocks concurrent operations on the same app and environment
- Lock timeout throws LockTimeoutError after specified duration
- Queued operations are stored with adapter dependencies and processing order

## Implementation Notes
- Create provisioning_operations table with columns: id (uuid), app_id (text), status (text: pending/in_progress/completed/failed), environment (text: dev/preview/production), created_at (timestamptz), updated_at (timestamptz), error_message (text nullable), lock_acquired_at (timestamptz nullable).
- Create provisioning_queue table with columns: id (uuid), operation_id (uuid FK), adapter_name (text), position (integer), status (text: queued/processing/completed/failed), created_at (timestamptz), updated_at (timestamptz).
- Create provisioning_dependencies table with columns: id (uuid), operation_id (uuid FK), adapter_name (text), depends_on_adapter (text), created_at (timestamptz) to track sequential adapter ordering.
- Add composite index on (app_id, environment, status) to provisioning_operations for efficient lock lookup queries.
- Implement acquireLock(appId, environment, timeoutMs) function in src/db/provisioning.ts using pg_advisory_xact_lock with timeout handling, returning lock_id or throwing LockTimeoutError.
- Implement releaseLock(lockId) function that releases the advisory lock and triggers queue processing for the next queued operation on the same app.
- Implement queueOperation(operationId, adapterName, position, dependencies) function that inserts into provisioning_queue and provisioning_dependencies tables.
- Export types ProvisioningOperation, ProvisioningQueue, ProvisioningDependency from src/types/provisioning.ts with full TypeScript interfaces.

## Completion
Verify your changes work — run relevant tests or checks appropriate for this project.

Then create `.codepoet/stories/8486cc87-df29-4dc5-a66b-d284938a2693/done.json` with this exact structure:
```json
{
  "status": "completed",
  "summary": "<brief summary of what you did>",
  "files_changed": ["list", "of", "files"]
}
```
IMPORTANT: The file MUST be at exactly `.codepoet/stories/8486cc87-df29-4dc5-a66b-d284938a2693/done.json`.
Do not create this file until you are fully done.
Do NOT perform any git operations (no git add, commit, or push).