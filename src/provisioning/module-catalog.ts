import type { ProviderType } from '../providers/types.js';
import type { MobilePlatform } from './graph.types.js';
import { globalPluginRegistry } from '../plugins/plugin-registry.js';

/**
 * Open branded string — module ids are validated at registration time, not
 * via a literal-union type. The plugin registry is the source of truth for
 * which ids are valid.
 */
export type ModuleId = string & { readonly __brand?: 'ModuleId' };

export interface ModuleDefinition {
  id: ModuleId;
  label: string;
  description: string;
  provider: ProviderType;
  requiredModules: ModuleId[];
  optionalModules: ModuleId[];
  stepKeys: string[];
  teardownStepKeys: string[];
  /** User-action node keys that belong to this module (for UI attribution). */
  userActionKeys?: string[];
  /**
   * Which mobile platforms this module applies to. Omitted = all platforms.
   * Modules whose platform mask doesn't intersect the project's `platforms`
   * selection are dropped before the plan is assembled (along with their
   * steps and required/optional module references).
   */
  platforms?: MobilePlatform[];
}

/**
 * Returns true when a node/module's `platforms` mask is satisfied by the
 * given project platform selection. Untagged nodes (no `platforms`) always
 * apply. An empty `projectPlatforms` array also acts as a permissive bypass
 * (consumers should treat that as "platform filtering disabled").
 */
export function platformMaskAllows(
  nodePlatforms: ReadonlyArray<MobilePlatform> | undefined,
  projectPlatforms: ReadonlyArray<MobilePlatform>,
): boolean {
  if (!nodePlatforms || nodePlatforms.length === 0) return true;
  if (!projectPlatforms || projectPlatforms.length === 0) return true;
  return nodePlatforms.some((platform) => projectPlatforms.includes(platform));
}

/**
 * Open string — template ids are validated at registration time. Built-in
 * template metadata is registered via `registerProjectTemplate()` from
 * `registerBuiltinPlugins()`; module membership is derived from each
 * plugin's `includedInTemplates` field.
 */
export type ProjectTemplateId = string & { readonly __brand?: 'ProjectTemplateId' };

export interface ProjectTemplate {
  id: ProjectTemplateId;
  label: string;
  description: string;
  modules: ModuleId[];
}

// ---------------------------------------------------------------------------
// Lazy bootstrap — guarantee the plugin registry is populated before any
// catalog/template query reads from it. The bootstrap call is wrapped in a
// dynamic import to break the cycle between this file and the plugin
// registration entry point.
// ---------------------------------------------------------------------------

let _bootstrapAttempted = false;
function ensurePluginRegistryBootstrapped(): void {
  if (_bootstrapAttempted) return;
  _bootstrapAttempted = true;
  if (globalPluginRegistry.hasPlugin('firebase-core')) return;
  // Synchronous require avoids the cycle; the builtin barrel only re-exports
  // plugin objects + the bootstrap function.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('../plugins/builtin/index.js') as {
    registerBuiltinPlugins: () => void;
  };
  mod.registerBuiltinPlugins();
}

/**
 * Returns the effective module catalog from the plugin registry. Lazily
 * bootstraps the built-in plugins if they haven't been registered yet so
 * callers don't have to remember the init order.
 */
export function getEffectiveModuleCatalog(): Readonly<Record<string, ModuleDefinition>> {
  ensurePluginRegistryBootstrapped();
  return globalPluginRegistry.getModuleCatalog();
}

/**
 * Returns the effective project templates from the plugin registry. Lazily
 * bootstraps the built-in plugins if they haven't been registered yet.
 */
export function getEffectiveProjectTemplates(): Readonly<Record<string, ProjectTemplate>> {
  ensurePluginRegistryBootstrapped();
  return globalPluginRegistry.getProjectTemplates();
}

/**
 * Default module set used when creating a new project without specifying a
 * template — derived from the registry's `mobile-app` template.
 */
export function getDefaultModuleIds(): ModuleId[] {
  const templates = getEffectiveProjectTemplates();
  return [...(templates['mobile-app']?.modules ?? [])];
}

/**
 * Resolve module dependencies topologically.
 * Accepts an optional catalog override — when omitted uses the registry catalog.
 */
export function resolveModuleDependencies(
  moduleIds: ModuleId[],
  catalog: Readonly<Record<string, ModuleDefinition>> = getEffectiveModuleCatalog(),
): ModuleId[] {
  const seen = new Set<ModuleId>();
  const visiting = new Set<ModuleId>();

  const visit = (moduleId: ModuleId) => {
    if (seen.has(moduleId)) return;
    if (visiting.has(moduleId)) {
      throw new Error(`Circular module dependency detected at "${moduleId}".`);
    }

    const module = catalog[moduleId];
    if (!module) {
      throw new Error(`Unknown module "${moduleId}".`);
    }

    visiting.add(moduleId);
    for (const requiredModule of module.requiredModules) {
      visit(requiredModule);
    }
    visiting.delete(moduleId);
    seen.add(moduleId);
  };

  for (const moduleId of moduleIds) {
    visit(moduleId);
  }

  return Array.from(seen);
}

export function getProvidersForModules(
  moduleIds: ModuleId[],
  catalog: Readonly<Record<string, ModuleDefinition>> = getEffectiveModuleCatalog(),
): ProviderType[] {
  const providers = new Set<ProviderType>();
  for (const moduleId of resolveModuleDependencies(moduleIds, catalog)) {
    providers.add(catalog[moduleId]!.provider);
  }
  return Array.from(providers);
}

export function getStepKeysForModules(
  moduleIds: ModuleId[],
  catalog: Readonly<Record<string, ModuleDefinition>> = getEffectiveModuleCatalog(),
): string[] {
  const stepKeys = new Set<string>();
  for (const moduleId of resolveModuleDependencies(moduleIds, catalog)) {
    const mod = catalog[moduleId]!;
    for (const stepKey of mod.stepKeys) {
      stepKeys.add(stepKey);
    }
    for (const key of mod.userActionKeys ?? []) {
      stepKeys.add(key);
    }
  }
  return Array.from(stepKeys);
}

export function getTeardownStepKeysForModules(
  moduleIds: ModuleId[],
  catalog: Readonly<Record<string, ModuleDefinition>> = getEffectiveModuleCatalog(),
): string[] {
  const stepKeys = new Set<string>();
  for (const moduleId of resolveModuleDependencies(moduleIds, catalog)) {
    for (const stepKey of catalog[moduleId]!.teardownStepKeys) {
      stepKeys.add(stepKey);
    }
  }
  return Array.from(stepKeys);
}
