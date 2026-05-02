/**
 * Step Registry — the complete catalog of provisioning steps and user action gates.
 *
 * All nodes in the provisioning graph are defined here. The buildProvisioningPlan()
 * function assembles a ProvisioningPlan from the selected providers and environments.
 */

import type { ProviderType } from '../providers/types.js';
import type {
  MobilePlatform,
  UserActionNode,
  ProvisioningStepNode,
  ProvisioningNode,
  ProvisioningPlan,
  NodeState,
} from './graph.types.js';
import {
  mergeContributorNodes,
  type ProvisioningContributor,
  type ProvisioningContributorContext,
} from './contributors.js';
import {
  DEFAULT_MODULE_IDS,
  type ModuleId,
  MODULE_CATALOG,
  resolveModuleDependencies,
  getProvidersForModules,
  getStepKeysForModules,
  platformMaskAllows,
  getEffectiveModuleCatalog,
} from './module-catalog.js';
import { globalPluginRegistry } from '../plugins/plugin-registry.js';
import {
  USER_ACTIONS,
} from './steps/user-actions.js';
import {
  FIREBASE_STEPS,
  FIREBASE_TEARDOWN_STEPS,
} from './steps/firebase-steps.js';
import {
  CLOUDFLARE_STEPS,
  CLOUDFLARE_TEARDOWN_STEPS,
} from './steps/cloudflare-steps.js';
import {
  GITHUB_STEPS,
  GITHUB_TEARDOWN_STEPS,
} from './steps/github-steps.js';
import {
  APPLE_STEPS,
  APPLE_TEARDOWN_STEPS,
} from './steps/apple-steps.js';
import {
  EAS_STEPS,
  EAS_TEARDOWN_STEPS,
} from './steps/eas-steps.js';
import {
  GOOGLE_PLAY_STEPS,
  GOOGLE_PLAY_TEARDOWN_STEPS,
} from './steps/google-play-steps.js';
import {
  OAUTH_STEPS,
  OAUTH_TEARDOWN_STEPS,
} from './steps/oauth-steps.js';
import {
  LLM_STEPS,
  LLM_OPENAI_STEPS,
  LLM_ANTHROPIC_STEPS,
  LLM_GEMINI_STEPS,
  LLM_CUSTOM_STEPS,
  LLM_TEARDOWN_STEPS,
  LLM_OPENAI_TEARDOWN_STEPS,
  LLM_ANTHROPIC_TEARDOWN_STEPS,
  LLM_GEMINI_TEARDOWN_STEPS,
  LLM_CUSTOM_TEARDOWN_STEPS,
} from './steps/llm-steps.js';

// ---------------------------------------------------------------------------
// Re-export step arrays so existing imports from step-registry.ts continue to work.
// ---------------------------------------------------------------------------

export {
  USER_ACTIONS,
  FIREBASE_STEPS, FIREBASE_TEARDOWN_STEPS,
  CLOUDFLARE_STEPS, CLOUDFLARE_TEARDOWN_STEPS,
  GITHUB_STEPS, GITHUB_TEARDOWN_STEPS,
  APPLE_STEPS, APPLE_TEARDOWN_STEPS,
  EAS_STEPS, EAS_TEARDOWN_STEPS,
  GOOGLE_PLAY_STEPS, GOOGLE_PLAY_TEARDOWN_STEPS,
  OAUTH_STEPS, OAUTH_TEARDOWN_STEPS,
  LLM_STEPS, LLM_OPENAI_STEPS, LLM_ANTHROPIC_STEPS, LLM_GEMINI_STEPS, LLM_CUSTOM_STEPS,
  LLM_TEARDOWN_STEPS, LLM_OPENAI_TEARDOWN_STEPS, LLM_ANTHROPIC_TEARDOWN_STEPS,
  LLM_GEMINI_TEARDOWN_STEPS, LLM_CUSTOM_TEARDOWN_STEPS,
};

// ---------------------------------------------------------------------------
// Master catalog: all nodes by provider
// ---------------------------------------------------------------------------

/**
 * Static fallback — used before the plugin registry is populated.
 * After registerBuiltinPlugins() runs, use globalPluginRegistry.getStepsForProvider().
 */
const STATIC_STEPS_BY_PROVIDER: Record<string, ProvisioningStepNode[]> = {
  firebase: FIREBASE_STEPS,
  github: GITHUB_STEPS,
  eas: EAS_STEPS,
  apple: APPLE_STEPS,
  'google-play': GOOGLE_PLAY_STEPS,
  cloudflare: CLOUDFLARE_STEPS,
  oauth: OAUTH_STEPS,
  llm: LLM_STEPS,
};

/** Returns steps for a provider. Delegates to the plugin registry when bootstrapped; falls back to the static catalog otherwise. */
export function getStepsForProvider(provider: string): ProvisioningStepNode[] {
  if (globalPluginRegistry.hasPlugin('firebase-core')) {
    return globalPluginRegistry.getStepsForProvider(provider);
  }
  return STATIC_STEPS_BY_PROVIDER[provider] ?? [];
}

/** Flat catalog for enriching persisted plans with fields added after first save (e.g. `interactiveAction`). */
export const ALL_PROVISIONING_STEPS: ProvisioningStepNode[] = Object.values(
  STATIC_STEPS_BY_PROVIDER,
).flat();

/**
 * Dynamic version — returns all steps from registry when bootstrapped.
 * Falls back to static arrays when registry is empty.
 */
export function getAllProvisioningSteps(): ProvisioningStepNode[] {
  if (globalPluginRegistry.hasPlugin('firebase-core')) {
    return globalPluginRegistry.getAllSteps();
  }
  return ALL_PROVISIONING_STEPS;
}

const STATIC_TEARDOWN_STEPS_BY_PROVIDER: Record<string, ProvisioningStepNode[]> = {
  firebase: FIREBASE_TEARDOWN_STEPS,
  github: GITHUB_TEARDOWN_STEPS,
  eas: EAS_TEARDOWN_STEPS,
  apple: APPLE_TEARDOWN_STEPS,
  'google-play': GOOGLE_PLAY_TEARDOWN_STEPS,
  cloudflare: CLOUDFLARE_TEARDOWN_STEPS,
  oauth: OAUTH_TEARDOWN_STEPS,
  llm: LLM_TEARDOWN_STEPS,
};

/** Returns teardown steps for a provider. Delegates to the plugin registry when bootstrapped; falls back to the static catalog otherwise. */
export function getTeardownStepsForProvider(provider: string): ProvisioningStepNode[] {
  if (globalPluginRegistry.hasPlugin('firebase-core')) {
    return globalPluginRegistry.getTeardownStepsForProvider(provider);
  }
  return STATIC_TEARDOWN_STEPS_BY_PROVIDER[provider] ?? [];
}

/**
 * Drop nodes whose required dependencies are absent from the same list.
 * Runs to a fixed point so chains like A → B → missing prune A and B.
 *
 * Cross-provider step edges (e.g. EAS submit → Apple ASC key) are omitted when
 * the dependency's provider is not selected; without this, merge validation fails.
 */
export function pruneNodesWithUnresolvedDependencies(nodes: ProvisioningNode[]): ProvisioningNode[] {
  let current = nodes;
  let changed = true;
  while (changed) {
    changed = false;
    const keys = new Set(current.map((n) => n.key));
    const next = current.filter((n) => {
      for (const dep of n.dependencies) {
        if (dep.required && !keys.has(dep.nodeKey)) {
          changed = true;
          return false;
        }
      }
      return true;
    });
    current = next;
  }
  return current;
}

/**
 * Drop nodes whose `platforms` mask doesn't intersect the project's platform
 * selection, then strip dependencies that point at filtered-out nodes from
 * the survivors.
 *
 * Untagged nodes (no `platforms`) and an empty `projectPlatforms` array
 * disable filtering entirely (treated as "all platforms").
 */
export function filterNodesByPlatforms(
  nodes: ProvisioningNode[],
  projectPlatforms: ReadonlyArray<MobilePlatform>,
): ProvisioningNode[] {
  if (!projectPlatforms || projectPlatforms.length === 0) return nodes;

  const removed = new Set<string>();
  const survivors: ProvisioningNode[] = [];
  for (const node of nodes) {
    if (platformMaskAllows(node.platforms, projectPlatforms)) {
      survivors.push(node);
    } else {
      removed.add(node.key);
    }
  }

  if (removed.size === 0) return survivors;

  return survivors.map((node) => {
    if (!node.dependencies?.length) return node;
    const trimmed = node.dependencies.filter((dep) => !removed.has(dep.nodeKey));
    if (trimmed.length === node.dependencies.length) return node;
    return { ...node, dependencies: trimmed };
  });
}

/**
 * Returns the subset of moduleIds whose own `platforms` mask intersects
 * the project's selection. Modules without a platform mask always pass.
 * Used in plan building to skip platform-irrelevant modules entirely
 * (their steps + user actions don't even need to be considered).
 */
export function filterModulesByPlatforms(
  moduleIds: ModuleId[],
  projectPlatforms: ReadonlyArray<MobilePlatform>,
): ModuleId[] {
  if (!projectPlatforms || projectPlatforms.length === 0) return moduleIds;
  const catalog = getEffectiveModuleCatalog();
  return moduleIds.filter((moduleId) => {
    const definition = catalog[moduleId];
    if (!definition) return true;
    return platformMaskAllows(definition.platforms, projectPlatforms);
  });
}

/**
 * Returns user action nodes relevant to the given set of providers.
 * A user action is included if at least one of its dependents' provider
 * is in the selected set, or if it has no dependents and its own provider
 * is in the set.
 */
function getRelevantUserActions(selectedProviders: string[]): UserActionNode[] {
  const allActions = globalPluginRegistry.hasPlugin('firebase-core')
    ? globalPluginRegistry.getAllUserActions()
    : USER_ACTIONS;

  const selectedSet = new Set<string>(selectedProviders);

  // Build a set of all step keys for the selected providers
  const selectedStepKeys = new Set<string>();
  for (const provider of selectedProviders) {
    for (const step of getStepsForProvider(provider)) {
      selectedStepKeys.add(step.key);
    }
  }

  // A user action is relevant if any selected step depends on it
  return allActions.filter((action) => {
    if (action.provider && selectedSet.has(action.provider)) return true;
    // Also include if any selected step directly depends on this action
    for (const provider of selectedProviders) {
      for (const step of getStepsForProvider(provider)) {
        if (step.dependencies.some((dep) => dep.nodeKey === action.key)) return true;
      }
    }
    // Include transitive: other user actions that depend on this one
    for (const otherAction of allActions) {
      if (
        otherAction.key !== action.key &&
        otherAction.dependencies.some((dep) => dep.nodeKey === action.key)
      ) {
        // Check if otherAction is itself relevant
        if (action.provider && selectedSet.has(action.provider)) return true;
      }
    }
    return false;
  });
}

const coreProvisioningContributor: ProvisioningContributor = {
  id: 'core',
  contributeNodes(ctx: ProvisioningContributorContext): ProvisioningNode[] {
    const steps: ProvisioningStepNode[] = [];
    for (const provider of ctx.selectedProviders) {
      steps.push(...getStepsForProvider(provider));
    }
    const nodes = [...getRelevantUserActions(ctx.selectedProviders), ...steps];
    return pruneNodesWithUnresolvedDependencies(nodes);
  },
};

/** Core first; push additional contributors for plugin-extended provisioning graphs. */
export const PROVISIONING_CONTRIBUTORS: ProvisioningContributor[] = [coreProvisioningContributor];

function assembleMergedNodes(
  projectId: string,
  selectedProviders: ProviderType[],
  environments: string[],
  selectedModules?: ModuleId[],
): ProvisioningNode[] {
  return mergeContributorNodes(PROVISIONING_CONTRIBUTORS, {
    projectId,
    selectedProviders,
    environments,
    selectedModules,
  });
}

/**
 * Build a ProvisioningPlan for the given project, selected providers, and environments.
 *
 * Steps are gathered from the step catalog for each selected provider.
 * User action gates are inferred from the dependency graph.
 * All nodes start in 'not-started' state.
 *
 * @param platforms Mobile platforms the project targets. When provided and
 * non-empty, nodes whose `platforms` mask doesn't intersect are dropped and
 * surviving nodes have dependencies on the dropped peers stripped.
 */
export function buildProvisioningPlan(
  projectId: string,
  selectedProviders: ProviderType[],
  environments: string[],
  selectedModules?: ModuleId[],
  platforms: ReadonlyArray<MobilePlatform> = [],
): ProvisioningPlan {
  const merged = assembleMergedNodes(projectId, selectedProviders, environments, selectedModules);
  const nodes = pruneNodesWithUnresolvedDependencies(filterNodesByPlatforms(merged, platforms));

  const nodeStates = new Map<string, NodeState>();
  for (const node of nodes) {
    if (node.type === 'step' && node.environmentScope === 'per-environment') {
      for (const env of environments) {
        const stateKey = `${node.key}@${env}`;
        nodeStates.set(stateKey, {
          nodeKey: node.key,
          status: 'not-started',
          environment: env,
        });
      }
    } else {
      nodeStates.set(node.key, {
        nodeKey: node.key,
        status: 'not-started',
      });
    }
  }

  return {
    projectId,
    environments,
    selectedModules: selectedModules ? resolveModuleDependencies(selectedModules) : [],
    platforms: [...platforms],
    nodes,
    nodeStates,
  };
}

export function buildTeardownPlan(
  projectId: string,
  selectedProviders: ProviderType[],
  environments: string[],
  selectedModules?: ModuleId[],
  platforms: ReadonlyArray<MobilePlatform> = [],
): ProvisioningPlan {
  const teardownSteps: ProvisioningStepNode[] = [];
  for (const provider of selectedProviders) {
    teardownSteps.push(...getTeardownStepsForProvider(provider));
  }
  const nodes = pruneNodesWithUnresolvedDependencies(
    filterNodesByPlatforms(teardownSteps as ProvisioningNode[], platforms),
  );

  const nodeStates = new Map<string, NodeState>();
  for (const node of nodes) {
    if (node.type !== 'step') continue;
    if (node.environmentScope === 'per-environment') {
      for (const env of environments) {
        const stateKey = `${node.key}@${env}`;
        nodeStates.set(stateKey, { nodeKey: node.key, status: 'not-started', environment: env });
      }
    } else {
      nodeStates.set(node.key, { nodeKey: node.key, status: 'not-started' });
    }
  }

  return {
    projectId,
    environments,
    selectedModules: selectedModules ? resolveModuleDependencies(selectedModules) : [],
    platforms: [...platforms],
    nodes,
    nodeStates,
  };
}

export function buildProvisioningPlanForModules(
  projectId: string,
  selectedModules: ModuleId[],
  environments: string[],
  platforms: ReadonlyArray<MobilePlatform> = [],
): ProvisioningPlan {
  // Drop platform-irrelevant modules entirely before resolving deps so that
  // e.g. an iOS-only project doesn't auto-pull `google-play-publishing` via
  // a transitive optional dependency.
  const platformFilteredModules = filterModulesByPlatforms(selectedModules, platforms);
  const resolvedModules = filterModulesByPlatforms(
    resolveModuleDependencies(platformFilteredModules),
    platforms,
  );
  const providerSet = new Set(getProvidersForModules(resolvedModules));
  const stepKeySet = new Set(getStepKeysForModules(resolvedModules));
  const selectedProviders = Array.from(providerSet);

  const fullPlan = buildProvisioningPlan(
    projectId,
    selectedProviders,
    environments,
    resolvedModules,
    platforms,
  );
  // Keep only nodes owned by the selected modules, plus their explicit
  // dependency closure (typically user-action gates). This prevents
  // provider-wide user actions from leaking in when a provider has multiple
  // sibling modules (e.g. llm-openai / llm-anthropic / llm-gemini / llm-custom).
  const nodeByKey = new Map(fullPlan.nodes.map((node) => [node.key, node]));
  const requiredNodeKeys = new Set<string>(stepKeySet);
  const walkDeps = (nodeKey: string): void => {
    const node = nodeByKey.get(nodeKey);
    if (!node) return;
    for (const dep of node.dependencies ?? []) {
      // Optional edges are for ordering hints when both ends are in the graph
      // (e.g. sync steps after selected LLM credential models). They must not
      // pull in unrelated sibling modules.
      if (!dep.required) continue;
      if (requiredNodeKeys.has(dep.nodeKey)) continue;
      requiredNodeKeys.add(dep.nodeKey);
      walkDeps(dep.nodeKey);
    }
  };
  for (const key of Array.from(requiredNodeKeys)) {
    walkDeps(key);
  }

  const filteredNodes = fullPlan.nodes.filter((node) => requiredNodeKeys.has(node.key));
  const prunedNodes = pruneNodesWithUnresolvedDependencies(filteredNodes);

  const nodeStates = new Map<string, NodeState>();
  for (const node of prunedNodes) {
    if (node.type === 'step' && node.environmentScope === 'per-environment') {
      for (const env of environments) {
        nodeStates.set(`${node.key}@${env}`, { nodeKey: node.key, status: 'not-started', environment: env });
      }
      continue;
    }
    nodeStates.set(node.key, { nodeKey: node.key, status: 'not-started' });
  }

  return {
    projectId,
    environments,
    selectedModules: resolvedModules,
    platforms: [...platforms],
    nodes: prunedNodes,
    nodeStates,
  };
}

export function recomputePlanForModules(
  previousPlan: ProvisioningPlan,
  selectedModules: ModuleId[],
  platforms?: ReadonlyArray<MobilePlatform>,
): ProvisioningPlan {
  const nextPlan = buildProvisioningPlanForModules(
    previousPlan.projectId,
    selectedModules,
    previousPlan.environments,
    platforms ?? previousPlan.platforms ?? [],
  );

  // Preserve all known states/resources for nodes that still exist after module recomputation.
  for (const [stateKey, oldState] of previousPlan.nodeStates.entries()) {
    if (!nextPlan.nodeStates.has(stateKey)) continue;
    nextPlan.nodeStates.set(stateKey, { ...oldState });
  }

  return nextPlan;
}

/**
 * Returns all nodes in the registry for the given providers (no filtering).
 * Useful for display / preview purposes.
 */
export function getAllNodesForProviders(providers: ProviderType[]): ProvisioningNode[] {
  const steps: ProvisioningStepNode[] = [];
  for (const provider of providers) {
    steps.push(...getStepsForProvider(provider));
  }
  const userActions = getRelevantUserActions(providers);
  return [...userActions, ...steps];
}

export function getAllTeardownNodesForProviders(providers: ProviderType[]): ProvisioningStepNode[] {
  const steps: ProvisioningStepNode[] = [];
  for (const provider of providers) {
    steps.push(...getTeardownStepsForProvider(provider));
  }
  return steps;
}

export function getAllModuleDefinitions() {
  return MODULE_CATALOG;
}
