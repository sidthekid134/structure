/**
 * Plugin Registry — single source of truth for the entire plugin system.
 *
 * All built-in modules and any third-party plugins register here.
 * Consumers (step-registry, module-catalog, journey-phases, provider-schemas,
 * API layer, UI) read from this registry instead of static constant files.
 */

import type {
  PluginDefinition,
  StepCapabilities,
  StepActionDescriptor,
  PluginDisplayMeta,
  ProviderDisplayMeta,
  ResourceDisplayConfig,
  ProviderMetadata,
  FunctionGroupDefinition,
  PluginRegistrationContext,
} from './plugin-types.js';
import type {
  ProvisioningStepNode,
  UserActionNode,
  CompletionPortalLink,
  ProviderBlueprint,
  NodeStatus,
} from '../provisioning/graph.types.js';
import type { ModuleDefinition, ProjectTemplate } from '../provisioning/module-catalog.js';
import type { StepHandler } from '../provisioning/step-handler-registry.js';
import type { ProviderAdapter, ProviderConfig } from '../providers/types.js';
import {
  JOURNEY_PHASE_ORDER,
  JOURNEY_PHASE_TITLE,
} from '../provisioning/journey-phases.js';
import { globalStepHandlerRegistry } from '../provisioning/step-handler-registry.js';

// Re-export for consumers that only need the basic types
export type { PluginDefinition } from './plugin-types.js';

// ---------------------------------------------------------------------------
// Default action descriptors per step type
// ---------------------------------------------------------------------------

const PENDING_STATUSES: NodeStatus[] = ['not-started', 'ready', 'blocked'];
const RUNNING_STATUSES: NodeStatus[] = ['in-progress', 'waiting-on-user', 'resolving'];
const COMPLETED_STATUSES: NodeStatus[] = ['completed'];
const FAILED_STATUSES: NodeStatus[] = ['failed'];
const ACTIVE_STATUSES: NodeStatus[] = ['not-started', 'ready', 'blocked', 'failed'];
const ALL_DONE_STATUSES: NodeStatus[] = ['completed', 'failed', 'skipped'];

function defaultFullStepActions(caps: StepCapabilities): StepActionDescriptor[] {
  const actions: StepActionDescriptor[] = [
    {
      id: 'run',
      label: 'Run',
      icon: 'Play',
      variant: 'primary',
      visibleIn: [...ACTIVE_STATUSES],
      enabledIn: [...PENDING_STATUSES, 'failed'],
    },
    {
      id: 'skip',
      label: 'Skip',
      icon: 'SkipForward',
      variant: 'ghost',
      visibleIn: [...ACTIVE_STATUSES],
      enabledIn: [...PENDING_STATUSES],
    },
  ];
  if (caps.supportsRevalidate) {
    actions.push({
      id: 'revalidate',
      label: 'Revalidate',
      icon: 'RefreshCw',
      variant: 'secondary',
      visibleIn: [...COMPLETED_STATUSES],
      enabledIn: [...COMPLETED_STATUSES],
    });
  }
  if (caps.supportsRevert) {
    actions.push({
      id: 'revert',
      label: 'Revert',
      icon: 'Undo2',
      variant: 'destructive',
      visibleIn: [...COMPLETED_STATUSES],
      enabledIn: [...COMPLETED_STATUSES],
      requiresConfirmation: true,
      confirmationMessage: 'This will permanently delete the resource. Are you sure?',
    });
  }
  return actions;
}

function defaultManualStepActions(): StepActionDescriptor[] {
  return [
    {
      id: 'mark-done',
      label: 'Mark as Done',
      icon: 'CheckCircle',
      variant: 'primary',
      visibleIn: [...ACTIVE_STATUSES, ...RUNNING_STATUSES],
      enabledIn: [...ACTIVE_STATUSES, ...RUNNING_STATUSES],
    },
    {
      id: 'skip',
      label: 'Skip',
      icon: 'SkipForward',
      variant: 'ghost',
      visibleIn: [...ACTIVE_STATUSES],
      enabledIn: [...PENDING_STATUSES],
    },
  ];
}

function defaultUserActionActions(
  verificationMethod: ProvisioningStepNode['automationLevel'] | string,
): StepActionDescriptor[] {
  if (verificationMethod === 'api-check') {
    return [
      {
        id: 'verify',
        label: 'Verify',
        icon: 'CheckCircle',
        variant: 'primary',
        visibleIn: [...ACTIVE_STATUSES, ...RUNNING_STATUSES],
        enabledIn: [...ACTIVE_STATUSES, ...RUNNING_STATUSES],
      },
      {
        id: 'skip',
        label: 'Skip',
        icon: 'SkipForward',
        variant: 'ghost',
        visibleIn: [...ACTIVE_STATUSES],
        enabledIn: [...PENDING_STATUSES],
      },
    ];
  }
  if (verificationMethod === 'credential-upload') {
    return [
      {
        id: 'upload',
        label: 'Upload',
        icon: 'Upload',
        variant: 'primary',
        visibleIn: [...ACTIVE_STATUSES, ...RUNNING_STATUSES],
        enabledIn: [...ACTIVE_STATUSES, ...RUNNING_STATUSES],
      },
      {
        id: 'skip',
        label: 'Skip',
        icon: 'SkipForward',
        variant: 'ghost',
        visibleIn: [...ACTIVE_STATUSES],
        enabledIn: [...PENDING_STATUSES],
      },
    ];
  }
  // manual-confirm
  return [
    {
      id: 'mark-done',
      label: 'Done',
      icon: 'CheckCircle',
      variant: 'primary',
      visibleIn: [...ACTIVE_STATUSES, ...RUNNING_STATUSES],
      enabledIn: [...ACTIVE_STATUSES, ...RUNNING_STATUSES],
    },
    {
      id: 'skip',
      label: 'Skip',
      icon: 'SkipForward',
      variant: 'ghost',
      visibleIn: [...ACTIVE_STATUSES],
      enabledIn: [...PENDING_STATUSES],
    },
  ];
}

// ---------------------------------------------------------------------------
// PluginRegistry class
// ---------------------------------------------------------------------------

export class PluginRegistry {
  private readonly plugins = new Map<string, PluginDefinition>();

  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  /**
   * Register a plugin.
   *
   * - Validates that all required modules are already registered.
   * - Auto-registers stepHandlers into globalStepHandlerRegistry.
   * - Calls the onRegister lifecycle hook.
   */
  register(plugin: PluginDefinition): void {
    if (this.plugins.has(plugin.id)) {
      console.warn(`[PluginRegistry] Plugin "${plugin.id}" already registered. Skipping.`);
      return;
    }

    // Validate required module dependencies
    for (const dep of plugin.requiredModules) {
      if (!this.plugins.has(dep)) {
        throw new Error(
          `[PluginRegistry] Plugin "${plugin.id}" requires module "${dep}" which is not yet registered. Register dependencies first.`,
        );
      }
    }

    this.plugins.set(plugin.id, plugin);

    // Auto-register step handlers
    if (plugin.stepHandlers) {
      globalStepHandlerRegistry.registerAll(plugin.stepHandlers);
    }

    // Call onRegister hook
    if (plugin.onRegister) {
      const ctx: PluginRegistrationContext = {
        registerJourneyPhase: ({ id, title, after }) => {
          if (JOURNEY_PHASE_ORDER.includes(id)) return; // already present
          JOURNEY_PHASE_TITLE[id] = title;
          if (after && JOURNEY_PHASE_ORDER.includes(after)) {
            const idx = JOURNEY_PHASE_ORDER.indexOf(after);
            // Insert before 'teardown' at minimum
            const insertAt = Math.min(idx + 1, JOURNEY_PHASE_ORDER.length - 1);
            JOURNEY_PHASE_ORDER.splice(insertAt, 0, id);
          } else {
            // Insert before 'teardown'
            const teardownIdx = JOURNEY_PHASE_ORDER.indexOf('teardown');
            if (teardownIdx >= 0) {
              JOURNEY_PHASE_ORDER.splice(teardownIdx, 0, id);
            } else {
              JOURNEY_PHASE_ORDER.push(id);
            }
          }
        },
      };
      const result = plugin.onRegister(ctx);
      if (result instanceof Promise) {
        result.catch((err: unknown) => {
          console.error(`[PluginRegistry] onRegister hook for "${plugin.id}" failed:`, err);
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Plugin queries
  // ---------------------------------------------------------------------------

  getPlugin(id: string): PluginDefinition | undefined {
    return this.plugins.get(id);
  }

  getAllPlugins(): PluginDefinition[] {
    return Array.from(this.plugins.values());
  }

  getPluginsForProvider(provider: string): PluginDefinition[] {
    return this.getAllPlugins().filter((p) => p.provider === provider);
  }

  hasPlugin(id: string): boolean {
    return this.plugins.has(id);
  }

  // ---------------------------------------------------------------------------
  // Module catalog
  // ---------------------------------------------------------------------------

  getModuleCatalog(): Record<string, ModuleDefinition> {
    const catalog: Record<string, ModuleDefinition> = {};
    for (const plugin of this.getAllPlugins()) {
      catalog[plugin.id] = {
        id: plugin.id,
        label: plugin.label,
        description: plugin.description,
        provider: plugin.provider,
        requiredModules: plugin.requiredModules,
        optionalModules: plugin.optionalModules,
        stepKeys: plugin.steps.map((s) => s.key),
        teardownStepKeys: plugin.teardownSteps.map((s) => s.key),
        userActionKeys: plugin.userActions.map((a) => a.key),
      };
    }
    return catalog;
  }

  getProjectTemplates(): Record<string, ProjectTemplate> {
    const templates: Record<string, ProjectTemplate> = {};
    // Collect plugins grouped by their includedInTemplates
    for (const plugin of this.getAllPlugins()) {
      for (const templateId of plugin.includedInTemplates ?? []) {
        if (!templates[templateId]) {
          templates[templateId] = {
            id: templateId,
            label: templateId,
            description: '',
            modules: [],
          };
        }
        if (!templates[templateId]!.modules.includes(plugin.id)) {
          templates[templateId]!.modules.push(plugin.id);
        }
      }
    }
    return templates;
  }

  // ---------------------------------------------------------------------------
  // Step/node queries
  // ---------------------------------------------------------------------------

  getAllSteps(): ProvisioningStepNode[] {
    const steps: ProvisioningStepNode[] = [];
    const seen = new Set<string>();
    for (const plugin of this.getAllPlugins()) {
      for (const step of plugin.steps) {
        if (!seen.has(step.key)) {
          steps.push(step);
          seen.add(step.key);
        }
      }
    }
    return steps;
  }

  getAllTeardownSteps(): ProvisioningStepNode[] {
    const steps: ProvisioningStepNode[] = [];
    const seen = new Set<string>();
    for (const plugin of this.getAllPlugins()) {
      for (const step of plugin.teardownSteps) {
        if (!seen.has(step.key)) {
          steps.push(step);
          seen.add(step.key);
        }
      }
    }
    return steps;
  }

  getAllUserActions(): UserActionNode[] {
    const actions: UserActionNode[] = [];
    const seen = new Set<string>();
    for (const plugin of this.getAllPlugins()) {
      for (const action of plugin.userActions) {
        if (!seen.has(action.key)) {
          actions.push(action);
          seen.add(action.key);
        }
      }
    }
    return actions;
  }

  getStepsForProvider(provider: string): ProvisioningStepNode[] {
    const steps: ProvisioningStepNode[] = [];
    const seen = new Set<string>();
    for (const plugin of this.getPluginsForProvider(provider)) {
      for (const step of plugin.steps) {
        if (!seen.has(step.key)) {
          steps.push(step);
          seen.add(step.key);
        }
      }
    }
    return steps;
  }

  getTeardownStepsForProvider(provider: string): ProvisioningStepNode[] {
    const steps: ProvisioningStepNode[] = [];
    const seen = new Set<string>();
    for (const plugin of this.getPluginsForProvider(provider)) {
      for (const step of plugin.teardownSteps) {
        if (!seen.has(step.key)) {
          steps.push(step);
          seen.add(step.key);
        }
      }
    }
    return steps;
  }

  getUserActionsForProvider(provider: string): UserActionNode[] {
    const actions: UserActionNode[] = [];
    const seen = new Set<string>();
    for (const plugin of this.getPluginsForProvider(provider)) {
      for (const action of plugin.userActions) {
        if (!seen.has(action.key)) {
          actions.push(action);
          seen.add(action.key);
        }
      }
    }
    return actions;
  }

  // ---------------------------------------------------------------------------
  // Journey phase queries
  // ---------------------------------------------------------------------------

  /**
   * Look up which journey phase a step/node key is assigned to.
   * Returns the defaultJourneyPhase of the owning plugin, or the per-step override.
   */
  getJourneyPhase(nodeKey: string): string {
    for (const plugin of this.getAllPlugins()) {
      const override = plugin.journeyPhaseOverrides?.[nodeKey];
      if (override) return override;

      const ownedByPlugin =
        plugin.steps.some((s) => s.key === nodeKey) ||
        plugin.teardownSteps.some((s) => s.key === nodeKey) ||
        plugin.userActions.some((a) => a.key === nodeKey);

      if (ownedByPlugin) return plugin.defaultJourneyPhase;
    }
    return 'verification';
  }

  computeJourneyPhaseOrder(): string[] {
    return [...JOURNEY_PHASE_ORDER];
  }

  getJourneyPhaseTitles(): Record<string, string> {
    return { ...JOURNEY_PHASE_TITLE };
  }

  // ---------------------------------------------------------------------------
  // Provider metadata
  // ---------------------------------------------------------------------------

  getProviders(): string[] {
    const providers = new Set<string>();
    for (const plugin of this.getAllPlugins()) {
      providers.add(plugin.provider);
    }
    return Array.from(providers);
  }

  getProviderMetadata(provider: string): ProviderMetadata | undefined {
    for (const plugin of this.getAllPlugins()) {
      if (plugin.provider === provider && plugin.providerMeta) {
        return plugin.providerMeta;
      }
    }
    return undefined;
  }

  getProviderSecretKeys(provider: string): string[] {
    return this.getProviderMetadata(provider)?.secretKeys ?? [];
  }

  getProviderDependencies(provider: string): string[] {
    return this.getProviderMetadata(provider)?.dependsOnProviders ?? [];
  }

  /** Returns { provider → secretKeys[] } merged from all plugins */
  getProviderSecretSchemas(): Record<string, string[]> {
    const schemas: Record<string, string[]> = {};
    for (const plugin of this.getAllPlugins()) {
      if (plugin.providerMeta?.secretKeys) {
        schemas[plugin.provider] = plugin.providerMeta.secretKeys;
      }
    }
    return schemas;
  }

  /** Returns { provider → dependsOnProviders[] } merged from all plugins */
  getProviderDependencyMap(): Record<string, string[]> {
    const deps: Record<string, string[]> = {};
    for (const plugin of this.getAllPlugins()) {
      if (plugin.providerMeta?.dependsOnProviders) {
        deps[plugin.provider] = plugin.providerMeta.dependsOnProviders;
      }
    }
    return deps;
  }

  getProviderBlueprints(): Record<string, ProviderBlueprint> {
    const blueprints: Record<string, ProviderBlueprint> = {};
    for (const provider of this.getProviders()) {
      const plugins = this.getPluginsForProvider(provider);
      const steps = this.getStepsForProvider(provider);
      const userActions = this.getUserActionsForProvider(provider);
      const meta = this.getProviderMetadata(provider);
      blueprints[provider] = {
        provider,
        scope: (meta?.scope ?? 'project') as 'organization' | 'project',
        steps,
        userActions,
      };
    }
    return blueprints;
  }

  /** Topological order of providers based on declared dependencies */
  resolveProviderOrder(): string[] {
    const providers = this.getProviders();
    const deps = this.getProviderDependencyMap();
    const visited = new Set<string>();
    const order: string[] = [];

    const visit = (provider: string) => {
      if (visited.has(provider)) return;
      visited.add(provider);
      for (const dep of deps[provider] ?? []) {
        if (providers.includes(dep)) visit(dep);
      }
      order.push(provider);
    };

    for (const p of providers) visit(p);
    return order;
  }

  // ---------------------------------------------------------------------------
  // Display metadata queries
  // ---------------------------------------------------------------------------

  getPluginDisplayMeta(moduleId: string): PluginDisplayMeta | undefined {
    return this.plugins.get(moduleId)?.displayMeta;
  }

  getProviderDisplayMeta(provider: string): ProviderDisplayMeta | undefined {
    return this.getProviderMetadata(provider)?.displayMeta;
  }

  getAllPluginDisplayMeta(): Record<string, PluginDisplayMeta> {
    const out: Record<string, PluginDisplayMeta> = {};
    for (const plugin of this.getAllPlugins()) {
      if (plugin.displayMeta) out[plugin.id] = plugin.displayMeta;
    }
    return out;
  }

  getAllProviderDisplayMeta(): Record<string, ProviderDisplayMeta> {
    const out: Record<string, ProviderDisplayMeta> = {};
    for (const provider of this.getProviders()) {
      const meta = this.getProviderDisplayMeta(provider);
      if (meta) out[provider] = meta;
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Resource display queries
  // ---------------------------------------------------------------------------

  getResourceDisplay(resourceKey: string): ResourceDisplayConfig | undefined {
    for (const plugin of this.getAllPlugins()) {
      const config = plugin.resourceDisplay?.[resourceKey];
      if (config) return config;
    }
    return undefined;
  }

  getAllResourceDisplay(): Record<string, ResourceDisplayConfig> {
    const out: Record<string, ResourceDisplayConfig> = {};
    for (const plugin of this.getAllPlugins()) {
      for (const [key, config] of Object.entries(plugin.resourceDisplay ?? {})) {
        if (!out[key]) out[key] = config; // first plugin wins
      }
    }
    return out;
  }

  getCompletionPortalLinks(nodeKey: string): CompletionPortalLink[] {
    for (const plugin of this.getAllPlugins()) {
      const links = plugin.completionPortalLinks?.[nodeKey];
      if (links) return links;
    }
    return [];
  }

  getAllCompletionPortalLinks(): Record<string, CompletionPortalLink[]> {
    const out: Record<string, CompletionPortalLink[]> = {};
    for (const plugin of this.getAllPlugins()) {
      for (const [key, links] of Object.entries(plugin.completionPortalLinks ?? {})) {
        if (!out[key]) out[key] = links;
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Step capability queries
  // ---------------------------------------------------------------------------

  /**
   * Compute step capabilities for a given step key.
   *
   * Defaults are derived from whether the step has a registered handler with
   * validate/sync/delete support. Plugin-defined overrides take precedence.
   */
  getStepCapabilities(stepKey: string): StepCapabilities {
    const handler = globalStepHandlerRegistry.get(stepKey);
    const defaults: StepCapabilities = {
      supportsRevalidate: !!handler,
      supportsSync: !!handler,
      supportsRevert: !!handler,
      supportsManualRevert: false,
      hasGuidedFlow: false,
    };

    // Check if any plugin has a guided flow for this step
    for (const plugin of this.getAllPlugins()) {
      if (plugin.guidedFlows?.some((f) => f.stepKeys?.includes(stepKey))) {
        defaults.hasGuidedFlow = true;
      }
    }

    // Apply plugin-declared overrides
    for (const plugin of this.getAllPlugins()) {
      const override = plugin.stepCapabilities?.[stepKey];
      if (override) {
        return { ...defaults, ...override };
      }
    }

    return defaults;
  }

  getAllStepCapabilities(stepKeys: string[]): Record<string, StepCapabilities> {
    const out: Record<string, StepCapabilities> = {};
    for (const key of stepKeys) {
      out[key] = this.getStepCapabilities(key);
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Step action descriptor queries
  // ---------------------------------------------------------------------------

  /**
   * Get action descriptors (button definitions) for a step.
   * Plugin-defined overrides replace the computed defaults entirely.
   */
  getStepActions(stepKey: string): StepActionDescriptor[] {
    // Check for plugin-defined override
    for (const plugin of this.getAllPlugins()) {
      const actions = plugin.stepActions?.[stepKey];
      if (actions) return actions;
    }

    // Derive defaults from node type and automation level
    const allSteps = this.getAllSteps();
    const allTeardown = this.getAllTeardownSteps();
    const allActions = this.getAllUserActions();

    const step = [...allSteps, ...allTeardown].find((s) => s.key === stepKey);
    if (step) {
      const caps = this.getStepCapabilities(stepKey);
      if (step.automationLevel === 'manual') {
        return defaultManualStepActions();
      }
      return defaultFullStepActions(caps);
    }

    const userAction = allActions.find((a) => a.key === stepKey);
    if (userAction) {
      const verType =
        typeof userAction.verification === 'object'
          ? userAction.verification.type
          : 'manual-confirm';
      return defaultUserActionActions(verType);
    }

    return [];
  }

  getAllStepActions(stepKeys: string[]): Record<string, StepActionDescriptor[]> {
    const out: Record<string, StepActionDescriptor[]> = {};
    for (const key of stepKeys) {
      out[key] = this.getStepActions(key);
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Function groups (module picker)
  // ---------------------------------------------------------------------------

  getFunctionGroups(): FunctionGroupDefinition[] {
    const groups = new Map<string, FunctionGroupDefinition>();
    for (const plugin of this.getAllPlugins()) {
      if (plugin.functionGroup) {
        const existing = groups.get(plugin.functionGroup.id);
        if (!existing || plugin.functionGroup.order < existing.order) {
          groups.set(plugin.functionGroup.id, plugin.functionGroup);
        }
      }
    }
    return Array.from(groups.values()).sort((a, b) => a.order - b.order);
  }

  // ---------------------------------------------------------------------------
  // Plugin catalog (for /api/plugin-catalog)
  // ---------------------------------------------------------------------------

  getPluginCatalog() {
    const modules: Record<
      string,
      {
        id: string;
        label: string;
        description: string;
        provider: string;
        functionGroupId?: string;
        requiredModules: string[];
        optionalModules: string[];
        displayMeta?: PluginDisplayMeta;
      }
    > = {};

    for (const plugin of this.getAllPlugins()) {
      modules[plugin.id] = {
        id: plugin.id,
        label: plugin.label,
        description: plugin.description,
        provider: plugin.provider,
        functionGroupId: plugin.functionGroup?.id,
        requiredModules: plugin.requiredModules,
        optionalModules: plugin.optionalModules,
        displayMeta: plugin.displayMeta,
      };
    }

    const providerList = this.getProviders().map((id) => {
      const meta = this.getProviderMetadata(id);
      return {
        id,
        label: meta?.label ?? id,
        scope: meta?.scope ?? 'project',
        displayMeta: meta?.displayMeta,
      };
    });

    const journeyPhases = this.computeJourneyPhaseOrder().map((id) => ({
      id,
      title: JOURNEY_PHASE_TITLE[id] ?? id,
    }));

    return {
      modules,
      functionGroups: this.getFunctionGroups(),
      templates: this.getProjectTemplates(),
      providers: providerList,
      journeyPhases,
    };
  }

  // ---------------------------------------------------------------------------
  // Adapter queries (for ProviderRegistry bootstrap)
  // ---------------------------------------------------------------------------

  getAllAdapters(): Array<{ provider: string; adapter: ProviderAdapter<ProviderConfig> }> {
    const adapters: Array<{ provider: string; adapter: ProviderAdapter<ProviderConfig> }> = [];
    const seen = new Set<string>();
    for (const plugin of this.getAllPlugins()) {
      if (plugin.adapter && !seen.has(plugin.provider)) {
        adapters.push({ provider: plugin.provider, adapter: plugin.adapter });
        seen.add(plugin.provider);
      }
    }
    return adapters;
  }

  // ---------------------------------------------------------------------------
  // Guided flow queries
  // ---------------------------------------------------------------------------

  getGuidedFlow(stepKey: string) {
    for (const plugin of this.getAllPlugins()) {
      const flow = plugin.guidedFlows?.find(
        (f) => f.stepKeys?.includes(stepKey) ?? false,
      );
      if (flow) return flow;
    }
    return undefined;
  }

  getGuidedFlowByType(flowType: string) {
    for (const plugin of this.getAllPlugins()) {
      const flow = plugin.guidedFlows?.find((f) => f.flow_type === flowType);
      if (flow) return flow;
    }
    return undefined;
  }

  getAllGuidedFlows() {
    const flows = [];
    const seen = new Set<string>();
    for (const plugin of this.getAllPlugins()) {
      for (const flow of plugin.guidedFlows ?? []) {
        if (!seen.has(flow.flow_type)) {
          flows.push(flow);
          seen.add(flow.flow_type);
        }
      }
    }
    return flows;
  }

  // ---------------------------------------------------------------------------
  // Assisted step config queries
  // ---------------------------------------------------------------------------

  getAssistedStepConfig(stepKey: string) {
    for (const plugin of this.getAllPlugins()) {
      const config = plugin.assistedStepConfigs?.[stepKey];
      if (config) return config;
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const globalPluginRegistry = new PluginRegistry();
