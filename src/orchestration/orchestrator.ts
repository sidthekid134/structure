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
  StepContext,
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
  StepProgressEvent,
} from './types.js';
import { StepResolver } from '../provisioning/step-resolver.js';
import { buildPlanViewModel } from '../provisioning/journey-phases.js';
import type {
  ProvisioningPlan,
  ProvisioningNode,
  ProvisioningStepNode,
  NodeState,
  GateResolver,
} from '../provisioning/graph.types.js';

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

  // ---------------------------------------------------------------------------
  // provisionBySteps() — step-level async generator
  // ---------------------------------------------------------------------------

  /**
   * Provisions a project using the step-level DAG execution model.
   *
   * Default `stepExecutionMode` is **sequential**: one expanded item at a time in journey order
   * (aligned with the Setup wizard). Set `stepExecutionMode: 'parallel'` to run same-layer items concurrently.
   */
  async *provisionBySteps(
    plan: ProvisioningPlan,
    manifest: ProviderManifest,
    options: OrchestrationOptions = {},
    vaultRead?: (key: string) => Promise<string | null>,
    vaultWrite?: (key: string, value: string) => Promise<void>,
    nodeKeysFilter?: Set<string>,
    gateResolver?: GateResolver,
  ): AsyncGenerator<StepProgressEvent, void, void> {
    const correlationId = crypto.randomUUID();
    const nodeMap = new Map<string, ProvisioningNode>(plan.nodes.map((n) => [n.key, n]));

    const upstreamResources: Record<string, string> = {
      ...(options.initialUpstreamResources ?? {}),
    };

    const runItem = async (item: {
      nodeKey: string;
      environment?: string;
    }): Promise<StepProgressEvent | undefined> => {
      const node = nodeMap.get(item.nodeKey);
      if (!node) return undefined;

      const stateKey = item.environment ? `${item.nodeKey}@${item.environment}` : item.nodeKey;
      const currentState = plan.nodeStates.get(stateKey);

      const shouldSkipCompleted =
        currentState?.status === 'completed' || currentState?.status === 'skipped';
      if (shouldSkipCompleted && options.stepExecutionIntent !== 'refresh') {
        if (currentState.resourcesProduced) {
          Object.assign(upstreamResources, currentState.resourcesProduced);
        }
        return undefined;
      }

      if (nodeKeysFilter) {
        const envSuffixed = item.environment ? `${item.nodeKey}@${item.environment}` : item.nodeKey;
        if (!nodeKeysFilter.has(item.nodeKey) && !nodeKeysFilter.has(envSuffixed)) {
          return undefined;
        }
      }

      for (const dep of node.dependencies) {
        if (!dep.required) continue;
        const depNode = nodeMap.get(dep.nodeKey);
        if (!depNode) continue;

        let depStateKey: string;
        if (
          depNode.type === 'step' &&
          (depNode as ProvisioningStepNode).environmentScope === 'per-environment' &&
          item.environment
        ) {
          depStateKey = `${dep.nodeKey}@${item.environment}`;
        } else {
          depStateKey = dep.nodeKey;
        }

        const depState = plan.nodeStates.get(depStateKey);
        const depStatus = depState?.status ?? 'not-started';
        if (depStatus !== 'completed' && depStatus !== 'skipped') {
          plan.nodeStates.set(stateKey, {
            nodeKey: item.nodeKey,
            status: 'blocked',
            environment: item.environment,
          });
          return {
            nodeKey: item.nodeKey,
            nodeType: node.type as 'step' | 'user-action',
            provider: node.provider,
            environment: item.environment,
            status: 'blocked' as const,
            timestamp: new Date(),
            correlation_id: correlationId,
          } satisfies StepProgressEvent;
        }
      }

      // Preserve `userInputs` across the in-progress transition. The
      // adapter's executor reads them out of `plan.nodeStates.get(stateKey)`
      // a few lines below to build `upstreamResources`, so wiping the field
      // here would silently produce empty inputs and force every step with
      // user-supplied configuration (Apple Auth Key uploads, GitHub owner,
      // ASC app name, etc.) into a "waiting-on-user — missing input" loop
      // even when the user already saved them.
      plan.nodeStates.set(stateKey, {
        nodeKey: item.nodeKey,
        status: 'in-progress',
        environment: item.environment,
        startedAt: Date.now(),
        ...(currentState?.userInputs ? { userInputs: currentState.userInputs } : {}),
      });

      if (node.type === 'user-action') {
        if (gateResolver) {
          const resolveContext: StepContext = {
            projectId: plan.projectId,
            environment: item.environment ?? 'global',
            upstreamResources: { ...upstreamResources },
            vaultRead: vaultRead ?? (async (_key: string) => null),
            vaultWrite: vaultWrite ?? (async (_key: string, _value: string) => {}),
            selectedModuleIds: plan.selectedModules,
            retrieveProjectCredential: options.retrieveProjectCredential,
          };

          try {
            const gateResult = await gateResolver.canResolve(item.nodeKey, resolveContext);
            if (gateResult.resolved) {
              Object.assign(upstreamResources, gateResult.resourcesProduced);
              plan.nodeStates.set(stateKey, {
                nodeKey: item.nodeKey,
                status: 'completed',
                environment: item.environment,
                completedAt: Date.now(),
                resourcesProduced: gateResult.resourcesProduced,
              });

              if (gateResult.completedSteps) {
                for (const step of gateResult.completedSteps) {
                  const stepState = plan.nodeStates.get(step.nodeKey);
                  if (!stepState || stepState.status !== 'completed') {
                    Object.assign(upstreamResources, step.resourcesProduced);
                    plan.nodeStates.set(step.nodeKey, {
                      nodeKey: step.nodeKey,
                      status: 'completed',
                      completedAt: Date.now(),
                      resourcesProduced: step.resourcesProduced,
                    });
                  }
                }
              }

              return {
                nodeKey: item.nodeKey,
                nodeType: 'user-action' as const,
                provider: node.provider,
                environment: item.environment,
                status: 'success' as const,
                resourcesProduced: gateResult.resourcesProduced,
                timestamp: new Date(),
                correlation_id: correlationId,
              } satisfies StepProgressEvent;
            }
          } catch (err) {
            this.log.warn('Gate resolver threw — falling back to waiting-on-user', {
              nodeKey: item.nodeKey,
              error: (err as Error).message,
            });
          }
        }

        plan.nodeStates.set(stateKey, {
          nodeKey: item.nodeKey,
          status: 'waiting-on-user',
          environment: item.environment,
          startedAt: Date.now(),
        });
        return {
          nodeKey: item.nodeKey,
          nodeType: 'user-action' as const,
          provider: node.provider,
          environment: item.environment,
          status: 'waiting-on-user' as const,
          userPrompt: node.description,
          timestamp: new Date(),
          correlation_id: correlationId,
        } satisfies StepProgressEvent;
      }

      const providerConfig = manifest.providers.find(
        (p) => p.provider === node.provider,
      ) as ProviderConfig | undefined;

      if (!providerConfig || !this.registry.hasAdapter(node.provider)) {
        plan.nodeStates.set(stateKey, {
          nodeKey: item.nodeKey,
          status: 'failed',
          environment: item.environment,
          error: `No adapter registered for provider: ${node.provider}`,
        });
        return {
          nodeKey: item.nodeKey,
          nodeType: 'step' as const,
          provider: node.provider,
          environment: item.environment,
          status: 'failure' as const,
          error: `No adapter registered for provider: ${node.provider}`,
          timestamp: new Date(),
          correlation_id: correlationId,
        } satisfies StepProgressEvent;
      }

      const adapter = this.registry.getAdapter(node.provider);
      if (!adapter.executeStep) {
        plan.nodeStates.set(stateKey, {
          nodeKey: item.nodeKey,
          status: 'failed',
          environment: item.environment,
          error: `Adapter for ${node.provider} does not implement executeStep`,
        });
        return {
          nodeKey: item.nodeKey,
          nodeType: 'step' as const,
          provider: node.provider,
          environment: item.environment,
          status: 'failure' as const,
          error: `Adapter for ${node.provider} does not implement executeStep`,
          timestamp: new Date(),
          correlation_id: correlationId,
        } satisfies StepProgressEvent;
      }

      const context: StepContext = {
        projectId: plan.projectId,
        environment: item.environment ?? 'global',
        upstreamResources: {
          ...upstreamResources,
          ...(plan.nodeStates.get(stateKey)?.userInputs ?? {}),
        },
        vaultRead: vaultRead ?? (async (_key: string) => null),
        vaultWrite: vaultWrite ?? (async (_key: string, _value: string) => {}),
        executionIntent: options.stepExecutionIntent ?? 'create',
        selectedModuleIds: plan.selectedModules,
        retrieveProjectCredential: options.retrieveProjectCredential,
      };

      try {
        const result = await adapter.executeStep(item.nodeKey, providerConfig, context);

        if (result.resourcesProduced) {
          Object.assign(upstreamResources, result.resourcesProduced);
        }

        const newStatus =
          result.status === 'completed'
            ? 'completed'
            : result.status === 'waiting-on-user'
              ? 'waiting-on-user'
              : 'failed';
        // Carry `userInputs` forward so a revert / re-edit doesn't lose what
        // the user typed (and so resume-from-waiting-on-user keeps the same
        // values on the next run). The PEM is already vaulted at this point;
        // the userInputs map just mirrors what the wizard would re-hydrate
        // its inputs from on next render.
        plan.nodeStates.set(stateKey, {
          nodeKey: item.nodeKey,
          status: newStatus as NodeState['status'],
          environment: item.environment,
          completedAt: Date.now(),
          resourcesProduced: result.resourcesProduced,
          ...(currentState?.userInputs ? { userInputs: currentState.userInputs } : {}),
        });

        return {
          nodeKey: item.nodeKey,
          nodeType: 'step' as const,
          provider: node.provider,
          environment: item.environment,
          status:
            result.status === 'completed'
              ? 'success'
              : result.status === 'waiting-on-user'
                ? 'waiting-on-user'
                : 'failure',
          error: result.error,
          resourcesProduced: result.resourcesProduced,
          userPrompt: result.userPrompt,
          timestamp: new Date(),
          correlation_id: correlationId,
        } satisfies StepProgressEvent;
      } catch (err) {
        const error = (err as Error).message;
        plan.nodeStates.set(stateKey, {
          nodeKey: item.nodeKey,
          status: 'failed',
          environment: item.environment,
          error,
          ...(currentState?.userInputs ? { userInputs: currentState.userInputs } : {}),
        });
        return {
          nodeKey: item.nodeKey,
          nodeType: 'step' as const,
          provider: node.provider,
          environment: item.environment,
          status: 'failure' as const,
          error,
          timestamp: new Date(),
          correlation_id: correlationId,
        } satisfies StepProgressEvent;
      }
    };

    const useParallel = options.stepExecutionMode === 'parallel';

    if (!useParallel) {
      const { sequentialExecutionItems } = buildPlanViewModel(plan.nodes, plan.environments);
      for (const item of sequentialExecutionItems) {
        const ev = await runItem(item);
        if (ev) {
          yield ev;
          if (ev.status === 'failure' || ev.status === 'waiting-on-user' || ev.status === 'blocked') {
            return;
          }
        }
      }
      return;
    }

    const executionGroups = StepResolver.resolveExecutionPlan(plan.nodes, plan.environments);

    for (const group of executionGroups) {
      const groupPromises = group.items.map((item) => runItem(item));
      const results = await Promise.all(groupPromises);

      for (const ev of results) {
        if (ev) yield ev;
      }

      const hasFailure = group.items.some((item) => {
        if (nodeKeysFilter && !nodeKeysFilter.has(item.nodeKey)) return false;
        const stateKey = item.environment ? `${item.nodeKey}@${item.environment}` : item.nodeKey;
        const state = plan.nodeStates.get(stateKey);
        return state?.status === 'failed';
      });

      if (hasFailure) {
        this.log.warn('Step failure detected in group — stopping pipeline', {
          depth: group.depth,
          correlationId,
        });
        return;
      }
    }
  }

  /**
   * Executes teardown steps in reverse topological order.
   *
   * Teardown nodes are expected to be step nodes with `direction: 'teardown'`.
   * User-action nodes are still supported and emit waiting-on-user events.
   */
  async *teardownBySteps(
    plan: ProvisioningPlan,
    manifest: ProviderManifest,
    options: OrchestrationOptions = {},
    vaultRead?: (key: string) => Promise<string | null>,
    vaultWrite?: (key: string, value: string) => Promise<void>,
    nodeKeysFilter?: Set<string>,
  ): AsyncGenerator<StepProgressEvent, void, void> {
    const correlationId = crypto.randomUUID();
    const nodeMap = new Map<string, ProvisioningNode>(plan.nodes.map((n) => [n.key, n]));
    const upstreamResources: Record<string, string> = {
      ...(options.initialUpstreamResources ?? {}),
    };

    const executionGroups = StepResolver.resolveTeardownPlan(plan.nodes, plan.environments);

    for (const group of executionGroups) {
      const groupPromises = group.items.map(async (item) => {
        const node = nodeMap.get(item.nodeKey);
        if (!node) return;

        const stateKey = item.environment ? `${item.nodeKey}@${item.environment}` : item.nodeKey;
        const currentState = plan.nodeStates.get(stateKey);

        if (currentState?.status === 'completed' || currentState?.status === 'skipped') {
          return;
        }

        if (nodeKeysFilter && !nodeKeysFilter.has(item.nodeKey)) {
          return;
        }

        for (const dep of node.dependencies) {
          if (!dep.required) continue;
          const depNode = nodeMap.get(dep.nodeKey);
          if (!depNode) continue;

          let depStateKey: string;
          if (
            depNode.type === 'step' &&
            (depNode as ProvisioningStepNode).environmentScope === 'per-environment' &&
            item.environment
          ) {
            depStateKey = `${dep.nodeKey}@${item.environment}`;
          } else {
            depStateKey = dep.nodeKey;
          }

          const depState = plan.nodeStates.get(depStateKey);
          const depStatus = depState?.status ?? 'not-started';
          if (depStatus !== 'completed' && depStatus !== 'skipped') {
            plan.nodeStates.set(stateKey, {
              nodeKey: item.nodeKey,
              status: 'blocked',
              environment: item.environment,
            });
            return {
              event: {
                nodeKey: item.nodeKey,
                nodeType: node.type as 'step' | 'user-action',
                provider: node.provider,
                environment: item.environment,
                status: 'blocked' as const,
                timestamp: new Date(),
                correlation_id: correlationId,
              } satisfies StepProgressEvent,
            };
          }
        }

        plan.nodeStates.set(stateKey, {
          nodeKey: item.nodeKey,
          status: 'in-progress',
          environment: item.environment,
          startedAt: Date.now(),
        });

        if (node.type === 'user-action') {
          plan.nodeStates.set(stateKey, {
            nodeKey: item.nodeKey,
            status: 'waiting-on-user',
            environment: item.environment,
            startedAt: Date.now(),
          });
          return {
            event: {
              nodeKey: item.nodeKey,
              nodeType: 'user-action' as const,
              provider: node.provider,
              environment: item.environment,
              status: 'waiting-on-user' as const,
              userPrompt: node.description,
              timestamp: new Date(),
              correlation_id: correlationId,
            } satisfies StepProgressEvent,
          };
        }

        const providerConfig = manifest.providers.find(
          (p) => p.provider === node.provider,
        ) as ProviderConfig | undefined;

        if (!providerConfig || !this.registry.hasAdapter(node.provider)) {
          plan.nodeStates.set(stateKey, {
            nodeKey: item.nodeKey,
            status: 'failed',
            environment: item.environment,
            error: `No adapter registered for provider: ${node.provider}`,
          });
          return {
            event: {
              nodeKey: item.nodeKey,
              nodeType: 'step' as const,
              provider: node.provider,
              environment: item.environment,
              status: 'failure' as const,
              error: `No adapter registered for provider: ${node.provider}`,
              timestamp: new Date(),
              correlation_id: correlationId,
            } satisfies StepProgressEvent,
          };
        }

        const adapter = this.registry.getAdapter(node.provider);
        if (!adapter.executeStep) {
          plan.nodeStates.set(stateKey, {
            nodeKey: item.nodeKey,
            status: 'failed',
            environment: item.environment,
            error: `Adapter for ${node.provider} does not implement executeStep`,
          });
          return {
            event: {
              nodeKey: item.nodeKey,
              nodeType: 'step' as const,
              provider: node.provider,
              environment: item.environment,
              status: 'failure' as const,
              error: `Adapter for ${node.provider} does not implement executeStep`,
              timestamp: new Date(),
              correlation_id: correlationId,
            } satisfies StepProgressEvent,
          };
        }

        const context: StepContext = {
          projectId: plan.projectId,
          environment: item.environment ?? 'global',
          upstreamResources: { ...upstreamResources },
          vaultRead: vaultRead ?? (async (_key: string) => null),
          vaultWrite: vaultWrite ?? (async (_key: string, _value: string) => {}),
          executionIntent: options.stepExecutionIntent ?? 'create',
          selectedModuleIds: plan.selectedModules,
          retrieveProjectCredential: options.retrieveProjectCredential,
        };

        try {
          const result = await adapter.executeStep(item.nodeKey, providerConfig, context);
          if (result.resourcesProduced) {
            Object.assign(upstreamResources, result.resourcesProduced);
          }

          const newStatus =
            result.status === 'completed'
              ? 'completed'
              : result.status === 'waiting-on-user'
                ? 'waiting-on-user'
                : 'failed';
          plan.nodeStates.set(stateKey, {
            nodeKey: item.nodeKey,
            status: newStatus as NodeState['status'],
            environment: item.environment,
            completedAt: Date.now(),
            resourcesProduced: result.resourcesProduced,
          });

          return {
            event: {
              nodeKey: item.nodeKey,
              nodeType: 'step' as const,
              provider: node.provider,
              environment: item.environment,
              status:
                result.status === 'completed'
                  ? 'success'
                  : result.status === 'waiting-on-user'
                    ? 'waiting-on-user'
                    : 'failure',
              error: result.error,
              resourcesProduced: result.resourcesProduced,
              userPrompt: result.userPrompt,
              timestamp: new Date(),
              correlation_id: correlationId,
            } satisfies StepProgressEvent,
          };
        } catch (err) {
          const error = (err as Error).message;
          plan.nodeStates.set(stateKey, {
            nodeKey: item.nodeKey,
            status: 'failed',
            environment: item.environment,
            error,
          });
          return {
            event: {
              nodeKey: item.nodeKey,
              nodeType: 'step' as const,
              provider: node.provider,
              environment: item.environment,
              status: 'failure' as const,
              error,
              timestamp: new Date(),
              correlation_id: correlationId,
            } satisfies StepProgressEvent,
          };
        }
      });

      const results = await Promise.all(groupPromises);
      for (const result of results) {
        if (result?.event) {
          yield result.event;
        }
      }

      const hasFailure = group.items.some((item) => {
        if (nodeKeysFilter && !nodeKeysFilter.has(item.nodeKey)) return false;
        const stateKey = item.environment ? `${item.nodeKey}@${item.environment}` : item.nodeKey;
        return plan.nodeStates.get(stateKey)?.status === 'failed';
      });

      if (hasFailure) {
        this.log.warn('Teardown failure detected — stopping pipeline', {
          depth: group.depth,
          correlationId,
          options,
        });
        return;
      }
    }
  }

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
