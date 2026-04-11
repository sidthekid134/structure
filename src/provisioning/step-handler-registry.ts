/**
 * StepHandler interface and registry.
 *
 * Every provisioning graph step can register a handler implementing create, delete,
 * validate, and sync. This makes resource lifecycle symmetric — deletion uses the
 * same auth path as creation, and sync can independently verify real-world state.
 *
 * The registry supplements (not replaces) the existing ProviderAdapter/ProviderRegistry
 * system. Handlers registered here take precedence for sync/validate/delete operations
 * in plan routes; the orchestrator's provisionBySteps() continues to use adapters for
 * the actual step execution.
 */

import type { VaultManager } from '../vault.js';
import type { ProjectManager } from '../studio/project-manager.js';

// ---------------------------------------------------------------------------
// Handler context
// ---------------------------------------------------------------------------

export interface StepHandlerContext {
  projectId: string;
  /** Artifacts produced by upstream steps (key = ResourceOutput.key). */
  upstreamArtifacts: Record<string, string>;
  /** User-provided input values for steps with inputFields. */
  userInputs?: Record<string, string>;
  /** Get an OAuth access token for the given provider ('gcp', 'github', …). Throws if unavailable. */
  getToken(providerId: string): Promise<string>;
  /** Returns true if a stored refresh token exists for this provider (does not refresh). */
  hasToken(providerId: string): boolean;
  /** Direct vault access for credential reads/writes. */
  vaultManager: VaultManager;
  passphrase: string;
  /** Project manager for integration metadata updates. */
  projectManager: ProjectManager;
}

// ---------------------------------------------------------------------------
// Handler result
// ---------------------------------------------------------------------------

/** Structured guidance for recovering from a step failure. */
export interface StepFailureRecovery {
  type: 'retry' | 'reauth' | 'manual-fix' | 'adopt-existing' | 'wait-retry';
  instructions?: string;
  portalUrl?: string;
  /** For 'wait-retry': milliseconds to wait before retrying */
  retryAfterMs?: number;
  /** For 'adopt-existing': the resource ID already in the cloud */
  existingResourceId?: string;
}

export interface StepHandlerResult {
  reconciled: boolean;
  message?: string;
  resourcesProduced?: Record<string, string>;
  /** When reconciled=false: caller should trigger OAuth re-authentication. */
  suggestsReauth?: boolean;
  /** Granular progress update for long-running steps. */
  progress?: { phase: string; percentage?: number; detail?: string };
  /** Structured recovery guidance when reconciled=false. */
  recovery?: StepFailureRecovery;
}

// ---------------------------------------------------------------------------
// Manual revert action
// ---------------------------------------------------------------------------

/**
 * When a handler's delete() returns reconciled=false (e.g. robot token can't delete),
 * the handler can optionally provide structured instructions for the user to manually
 * complete the deletion. Returned by getManualRevertAction() when implemented.
 */
export interface RevertManualAction {
  stepKey: string;
  title: string;
  body: string;
  primaryUrl: string;
  primaryLabel: string;
}

// ---------------------------------------------------------------------------
// Handler interface
// ---------------------------------------------------------------------------

export interface StepHandler {
  /** Must match the provisioning graph node key (e.g. 'firebase:create-gcp-project'). */
  readonly stepKey: string;
  /** OAuthProvider.id required for create/delete/validate/sync ('gcp', 'github', …). */
  readonly requiredAuth?: string;

  /** Create (provision) the resource. */
  create(context: StepHandlerContext): Promise<StepHandlerResult>;
  /**
   * Delete (deprovision) the resource. Returns reconciled=true when the resource was
   * successfully removed or was already absent. Returns reconciled=false only when a
   * real error prevents deletion.
   *
   * Note: some resources (e.g. GCP projects) cannot be deleted via the provisioner;
   * those handlers should return reconciled=false with an explanatory message.
   */
  delete(context: StepHandlerContext): Promise<StepHandlerResult>;
  /** Validate that the resource exists and is in the expected state. */
  validate(context: StepHandlerContext): Promise<StepHandlerResult>;
  /**
   * Sync: reconcile local state with the real-world resource. Returns null if this
   * handler does not apply to the given step (allows fallback to adapter.checkStep).
   */
  sync(context: StepHandlerContext): Promise<StepHandlerResult | null>;
  /**
   * Optional: called when delete() returns reconciled=false to get structured manual
   * instructions for the user to complete the deletion themselves.
   * Return null when no manual instructions apply.
   */
  getManualRevertAction?(context: StepHandlerContext): RevertManualAction | null;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class StepHandlerRegistry {
  private readonly handlers = new Map<string, StepHandler>();

  register(handler: StepHandler): void {
    this.handlers.set(handler.stepKey, handler);
  }

  registerAll(handlers: StepHandler[]): void {
    for (const h of handlers) this.register(h);
  }

  get(stepKey: string): StepHandler | undefined {
    return this.handlers.get(stepKey);
  }

  getRequired(stepKey: string): StepHandler {
    const h = this.handlers.get(stepKey);
    if (!h) throw new Error(`No StepHandler registered for "${stepKey}".`);
    return h;
  }

  has(stepKey: string): boolean {
    return this.handlers.has(stepKey);
  }

  keys(): string[] {
    return Array.from(this.handlers.keys());
  }
}

// ---------------------------------------------------------------------------
// Singleton registry (populated at startup by api.ts)
// ---------------------------------------------------------------------------

export const globalStepHandlerRegistry = new StepHandlerRegistry();
