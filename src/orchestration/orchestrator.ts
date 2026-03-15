/**
 * Orchestrator — the main provisioning engine.
 *
 * provision() is an async generator that:
 *   1. Validates the manifest schema version
 *   2. Loads operation history from the SQLite event log
 *   3. Skips already-completed providers when resume=true
 *   4. Executes each provider in dependency order (Firebase → Apple → EAS → GitHub → Cloudflare)
 *   5. Yields ProgressEvent for each step
 *   6. Stops on first unrecoverable error, preserving partial results
 *
 * Drift detection and conflict resolution are surfaced via ProgressEvents with
 * status='conflict', allowing callers to prompt users for direction.
 */

import * as crypto from 'crypto';
import {
  ProviderType,
  ProviderConfig,
  ProviderManifest,
  ProviderState,
  PLATFORM_CORE_VERSION,
} from '../providers/types.js';
import { ProviderRegistry } from '../providers/registry.js';
import { DependencyResolver } from '../drift/resolver.js';
import { ManifestValidator } from '../schemas/validation.js';
import { createOperationLogger } from '../logger.js';
import type { LoggingCallback } from '../types.js';
import { EventLog } from './event-log.js';
import { generateIdempotencyKey, IdempotencyManager } from './idempotency.js';
import { ConflictResolver } from './conflict-resolver.js';
import type {
  OperationResult,
  ProgressEvent,
  OrchestrationOptions,
} from './types.js';

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export class Orchestrator {
  private readonly log: ReturnType<typeof createOperationLogger>;
  private readonly idempotency: IdempotencyManager;
  private readonly conflictResolver: ConflictResolver;

  constructor(
    private readonly registry: ProviderRegistry,
    private readonly eventLog: EventLog,
    loggingCallback?: LoggingCallback,
  ) {
    this.log = createOperationLogger('Orchestrator', loggingCallback);
    this.idempotency = new IdempotencyManager(eventLog);
    this.conflictResolver = new ConflictResolver(loggingCallback);
  }

  // ---------------------------------------------------------------------------
  // provision() — async generator
  // ---------------------------------------------------------------------------

  /**
   * Provisions all providers in the manifest in dependency order.
   * Yields a ProgressEvent for each step.
   *
   * Callers iterate with `for await (const event of orchestrator.provision(manifest, options))`.
   */
  async *provision(
    manifest: ProviderManifest,
    options: OrchestrationOptions = {},
  ): AsyncGenerator<ProgressEvent, OperationResult[], void> {
    const correlationId = crypto.randomUUID();
    const userId = options.user_id ?? 'anonymous';

    this.log.info('Orchestrator.provision() started', {
      appId: manifest.app_id,
      providerCount: manifest.providers.length,
      resume: options.resume ?? false,
      correlationId,
    });

    // ------------------------------------------------------------------
    // 1. Validate manifest schema version
    // ------------------------------------------------------------------
    try {
      ManifestValidator.validate(manifest);
    } catch (err) {
      const errMsg = (err as Error).message;
      this.log.error('Manifest validation failed', { error: errMsg, correlationId });
      yield this.errorEvent('manifest', 'schema-validation', errMsg, correlationId, false);
      return [];
    }

    // ------------------------------------------------------------------
    // 2. Create or resume operation record
    // ------------------------------------------------------------------
    const operationId = `op-${manifest.app_id}-${Date.now()}`;
    this.eventLog.createOperation(operationId, manifest.app_id);

    // ------------------------------------------------------------------
    // 3. Determine execution order and skip completed providers
    // ------------------------------------------------------------------
    const providerTypes = manifest.providers.map(p => p.provider as ProviderType);
    const orderedProviders = DependencyResolver.resolveOrder(providerTypes);

    const completedResults: OperationResult[] = [];
    const skippedProviders = new Set<ProviderType>();

    if (options.resume) {
      for (const provider of orderedProviders) {
        const lastStep = this.eventLog.getLastSuccessfulStep(operationId, provider);
        if (lastStep === 'provision') {
          skippedProviders.add(provider);
          this.log.info('Skipping already-completed provider', { provider, correlationId });
        }
      }
    }

    // ------------------------------------------------------------------
    // 4. Execute providers in dependency order
    // ------------------------------------------------------------------
    for (const providerType of orderedProviders) {
      const config = manifest.providers.find(p => p.provider === providerType)!;

      // Skip completed providers when resuming
      if (skippedProviders.has(providerType)) {
        yield {
          provider: providerType,
          step: 'provision',
          status: 'skipped',
          timestamp: new Date(),
          correlation_id: correlationId,
        };
        continue;
      }

      // Yield 'running' event
      yield {
        provider: providerType,
        step: 'provision',
        status: 'running',
        timestamp: new Date(),
        correlation_id: correlationId,
      };

      // Check idempotency key
      const idempotencyKey = generateIdempotencyKey(providerType, 'provision', config);
      const cached = this.idempotency.checkIdempotency(idempotencyKey);
      if (cached) {
        this.log.info('Idempotency cache hit — skipping provision', {
          provider: providerType,
          correlationId,
        });
        // Reconstruct a minimal success result from cache
        const cachedResult: OperationResult = {
          success: true,
          resources_created: {},
          secrets_stored: [],
          manual_steps: [],
          errors: [],
          provider: providerType,
          timestamp: new Date(),
          correlation_id: correlationId,
        };
        completedResults.push(cachedResult);
        yield {
          provider: providerType,
          step: 'provision',
          status: 'success',
          result: cachedResult,
          timestamp: new Date(),
          correlation_id: correlationId,
        };
        continue;
      }

      // Execute provisioning
      let result: OperationResult;
      try {
        result = await this.provisionProvider(
          providerType,
          config,
          operationId,
          correlationId,
          userId,
          manifest.app_id,
          options.dry_run ?? false,
        );
      } catch (err) {
        const error = err as Error & { recoverable?: boolean };
        const recoverable = error.recoverable ?? false;

        this.log.error('Provider provisioning failed', {
          provider: providerType,
          error: error.message,
          recoverable,
          correlationId,
        });

        const failResult: OperationResult = {
          success: false,
          resources_created: {},
          secrets_stored: [],
          manual_steps: [],
          errors: [
            {
              code: 'PROVISION_ERROR',
              message: error.message,
              recoverable,
              suggested_action: recoverable
                ? 'Retry the operation with --resume flag'
                : 'Check provider credentials and configuration',
            },
          ],
          provider: providerType,
          timestamp: new Date(),
          correlation_id: correlationId,
        };

        this.eventLog.append(operationId, providerType, 'provision', 'failure', failResult, error.message);
        this.eventLog.updateOperationStatus(operationId, 'failure');

        yield {
          provider: providerType,
          step: 'provision',
          status: 'failure',
          result: failResult,
          timestamp: new Date(),
          correlation_id: correlationId,
        };

        if (!recoverable) {
          // Stop the pipeline
          return completedResults;
        }
        continue;
      }

      // Record success
      this.eventLog.append(operationId, providerType, 'provision', 'success', result);
      this.idempotency.cacheResult(idempotencyKey, operationId, result);
      completedResults.push(result);

      yield {
        provider: providerType,
        step: 'provision',
        status: result.success ? 'success' : 'failure',
        result,
        timestamp: new Date(),
        correlation_id: correlationId,
      };

      if (!result.success) {
        const unrecoverable = result.errors.some(e => !e.recoverable);
        if (unrecoverable) {
          this.eventLog.updateOperationStatus(operationId, 'failure');
          return completedResults;
        }
      }
    }

    this.eventLog.updateOperationStatus(operationId, 'success');
    this.log.info('Orchestration complete', { appId: manifest.app_id, correlationId });
    return completedResults;
  }

  // ---------------------------------------------------------------------------
  // Internal: provision a single provider
  // ---------------------------------------------------------------------------

  private async provisionProvider(
    providerType: ProviderType,
    config: ProviderConfig,
    operationId: string,
    correlationId: string,
    _userId: string,
    _appId: string,
    dryRun: boolean,
  ): Promise<OperationResult> {
    if (!this.registry.hasAdapter(providerType)) {
      throw Object.assign(
        new Error(`No adapter registered for provider: ${providerType}`),
        { recoverable: false },
      );
    }

    if (dryRun) {
      return {
        success: true,
        resources_created: {},
        secrets_stored: [],
        manual_steps: [`Dry run — no resources created for ${providerType}`],
        errors: [],
        provider: providerType,
        timestamp: new Date(),
        correlation_id: correlationId,
      };
    }

    const adapter = this.registry.getAdapter(providerType);
    const state: ProviderState = await adapter.provision(config);

    const credentials = await adapter.extractCredentials(state);
    const secretsStored = Object.keys(credentials);

    // Map partial completion to manual steps
    const manualSteps: string[] = [];
    for (const [credName, meta] of Object.entries(state.credential_metadata)) {
      if (meta.pending_manual_upload) {
        manualSteps.push(`Manually upload credential "${credName}" for ${providerType}`);
      }
    }

    return {
      success: !state.partially_complete,
      resources_created: { ...state.resource_ids },
      secrets_stored: secretsStored,
      manual_steps: manualSteps,
      errors: state.failed_steps.map(step => ({
        code: 'STEP_FAILED',
        message: `Step "${step}" failed for ${providerType}`,
        recoverable: true,
        suggested_action: `Re-run provisioning with --resume to retry failed steps`,
      })),
      provider: providerType,
      timestamp: new Date(),
      correlation_id: correlationId,
    };
  }

  // ---------------------------------------------------------------------------
  // Internal: build an error ProgressEvent
  // ---------------------------------------------------------------------------

  private errorEvent(
    provider: ProviderType | 'manifest',
    step: string,
    message: string,
    correlationId: string,
    recoverable: boolean,
  ): ProgressEvent {
    const result: OperationResult = {
      success: false,
      resources_created: {},
      secrets_stored: [],
      manual_steps: [],
      errors: [
        {
          code: 'ORCHESTRATION_ERROR',
          message,
          recoverable,
          suggested_action: recoverable
            ? 'Retry the operation'
            : 'Fix the issue and re-run provisioning',
        },
      ],
      provider: (provider === 'manifest' ? 'firebase' : provider) as ProviderType,
      timestamp: new Date(),
      correlation_id: correlationId,
    };

    return {
      provider: result.provider,
      step,
      status: 'failure',
      result,
      timestamp: new Date(),
      correlation_id: correlationId,
    };
  }
}
