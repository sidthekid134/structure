/**
 * Error hierarchy for the orchestration engine.
 *
 * All orchestration errors extend OrchestrationError so callers can catch the
 * full hierarchy with a single catch clause while still being able to
 * distinguish subtypes.
 *
 * Every error carries:
 *   - code: machine-readable identifier (e.g. VALIDATION_FAILED)
 *   - message: human-readable description
 *   - context: structured key-value metadata (never includes secrets)
 *   - recoverable: whether the caller may retry without manual intervention
 *   - correlation_id: links the error to event log entries
 *   - timestamp: when the error occurred
 */

// ---------------------------------------------------------------------------
// Base error
// ---------------------------------------------------------------------------

export class OrchestrationError extends Error {
  public readonly code: string;
  public readonly context: Record<string, unknown>;
  public readonly recoverable: boolean;
  public readonly timestamp: Date;
  public readonly correlation_id: string;

  constructor(
    message: string,
    code: string,
    context: Record<string, unknown> = {},
    recoverable = false,
    correlationId = 'unknown',
  ) {
    super(message);
    this.name = 'OrchestrationError';
    this.code = code;
    this.context = context;
    this.recoverable = recoverable;
    this.timestamp = new Date();
    this.correlation_id = correlationId;
  }
}

// ---------------------------------------------------------------------------
// Subtypes
// ---------------------------------------------------------------------------

/**
 * Thrown when a provider's provisioning step fails.
 */
export class ProvisioningError extends OrchestrationError {
  public readonly provider_id: string;

  constructor(
    message: string,
    providerId: string,
    context: Record<string, unknown> = {},
    recoverable = false,
    correlationId = 'unknown',
  ) {
    super(message, 'PROVISIONING_ERROR', { ...context, provider_id: providerId }, recoverable, correlationId);
    this.name = 'ProvisioningError';
    this.provider_id = providerId;
  }
}

/**
 * Thrown when manifest or provider config validation fails.
 */
export class OrchestrationValidationError extends OrchestrationError {
  public readonly field: string;

  constructor(
    message: string,
    field: string,
    context: Record<string, unknown> = {},
    correlationId = 'unknown',
  ) {
    super(message, 'VALIDATION_FAILED', { ...context, field }, false, correlationId);
    this.name = 'OrchestrationValidationError';
    this.field = field;
  }
}

/**
 * Thrown when drift detection or reconciliation encounters an error.
 */
export class DriftError extends OrchestrationError {
  public readonly provider_id: string;

  constructor(
    message: string,
    providerId: string,
    context: Record<string, unknown> = {},
    recoverable = true,
    correlationId = 'unknown',
  ) {
    super(message, 'DRIFT_ERROR', { ...context, provider_id: providerId }, recoverable, correlationId);
    this.name = 'DriftError';
    this.provider_id = providerId;
  }
}

// ---------------------------------------------------------------------------
// Standard API error response shape
// ---------------------------------------------------------------------------

export interface ApiErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    context: Record<string, unknown>;
  };
}

export interface ApiSuccessResponse<T> {
  success: true;
  data: T;
}

export type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

/**
 * Converts any thrown error to a standard API error response.
 */
export function toApiErrorResponse(err: unknown): ApiErrorResponse {
  if (err instanceof OrchestrationError) {
    return {
      success: false,
      error: {
        code: err.code,
        message: err.message,
        context: err.context,
      },
    };
  }

  const e = err as Error;
  return {
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: e?.message ?? 'An unexpected error occurred',
      context: {},
    },
  };
}
