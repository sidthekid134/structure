/**
 * Shared orchestration types used across CLI, MCP server, and Studio UI.
 *
 * OperationResult is the canonical return value for all provider provisioning
 * operations. ProgressEvent is the unit of the async generator stream that
 * Orchestrator.provision() yields.
 */

import type { ProviderType } from '../providers/types.js';

// ---------------------------------------------------------------------------
// OperationError — structured error with recovery guidance
// ---------------------------------------------------------------------------

export interface OperationError {
  /** Machine-readable error code (e.g. FIREBASE_AUTH_FAILED, RATE_LIMIT) */
  code: string;
  /** Human-readable description of what went wrong */
  message: string;
  /** True if the caller may retry; false if manual intervention is required */
  recoverable: boolean;
  /** Actionable next step for the user (e.g. 'Check Firebase credentials') */
  suggested_action: string;
}

// ---------------------------------------------------------------------------
// OperationResult — canonical result for a single provider provision run
// ---------------------------------------------------------------------------

export interface OperationResult {
  success: boolean;
  /** Resource IDs created or updated, keyed by resource type */
  resources_created: Record<string, string>;
  /** Names of secrets stored in the vault */
  secrets_stored: string[];
  /** Steps requiring manual user action (e.g. download APNs key) */
  manual_steps: string[];
  /** Non-empty when success=false or when partial failures occurred */
  errors: OperationError[];
  /** The provider this result belongs to */
  provider: ProviderType;
  /** Wall-clock time when provisioning completed */
  timestamp: Date;
  /** Correlation ID linking this result to its event log entries */
  correlation_id: string;
}

// ---------------------------------------------------------------------------
// ProgressEvent — yielded by Orchestrator.provision() async generator
// ---------------------------------------------------------------------------

export type ProgressStatus = 'running' | 'success' | 'failure' | 'conflict' | 'skipped';

export interface ProgressEvent {
  provider: ProviderType;
  step: string;
  status: ProgressStatus;
  /** Present when status is 'success', 'failure', or 'conflict' */
  result?: OperationResult;
  /** Present when status is 'conflict' */
  drift_report?: DriftSummary;
  timestamp: Date;
  correlation_id: string;
}

// ---------------------------------------------------------------------------
// DriftSummary — lightweight drift info carried in ProgressEvent
// ---------------------------------------------------------------------------

export interface DriftSummary {
  provider: ProviderType;
  manifest_errors: string[];
  orphaned_resources: string[];
  has_errors: boolean;
  has_warnings: boolean;
}

// ---------------------------------------------------------------------------
// OrchestrationOptions — passed to Orchestrator.provision()
// ---------------------------------------------------------------------------

export interface OrchestrationOptions {
  /** If true, skip already-completed providers from the event log */
  resume?: boolean;
  /** User ID for audit logging */
  user_id?: string;
  /** Dry-run: validate and detect drift but do not provision */
  dry_run?: boolean;
}

// ---------------------------------------------------------------------------
// ValidationReport — returned by validateApp()
// ---------------------------------------------------------------------------

export interface ValidationReport {
  app_id: string;
  schema_version: string;
  schema_errors: Array<{ field: string; message: string; migration_hint?: string }>;
  manifest_errors: Array<{ provider: ProviderType; field: string; message: string }>;
  drift_reports: DriftSummary[];
  has_errors: boolean;
  has_warnings: boolean;
}
