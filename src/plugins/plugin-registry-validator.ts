/**
 * Plugin registry validator — runs after all plugins are registered to catch
 * structural drift between PluginDefinition fields and the rest of the system.
 *
 * Each check throws an `AggregateRegistryError` listing every problem found
 * (rather than failing fast) so a single boot surface every issue at once.
 *
 * Mirrors the assertions in `src/__tests__/integration-registry.test.ts` so
 * production startup catches the same drift the test suite catches.
 */

import type { PluginRegistry } from './plugin-registry.js';
import { JOURNEY_PHASE_ORDER } from '../provisioning/journey-phases.js';
import { ALL_MOBILE_PLATFORMS } from '../provisioning/graph.types.js';

export class AggregateRegistryError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(
      `Plugin registry failed validation with ${problems.length} problem(s):\n` +
        problems.map((p) => `  - ${p}`).join('\n'),
    );
    this.name = 'AggregateRegistryError';
    this.problems = problems;
  }
}

export interface ValidatePluginRegistryOptions {
  /**
   * When true (default) the validator throws on any problem. Set false to
   * collect problems without throwing — useful for tests/diagnostics.
   */
  throwOnError?: boolean;
}

export interface ValidatePluginRegistryResult {
  ok: boolean;
  problems: string[];
}

export function validatePluginRegistry(
  registry: PluginRegistry,
  options: ValidatePluginRegistryOptions = {},
): ValidatePluginRegistryResult {
  const { throwOnError = true } = options;
  const problems: string[] = [];

  const plugins = registry.getAllPlugins();
  const pluginIds = new Set(plugins.map((p) => p.id));
  const validPhases = new Set<string>(JOURNEY_PHASE_ORDER);
  const validPlatforms = new Set<string>(ALL_MOBILE_PLATFORMS);

  // 1. Module references resolve.
  for (const plugin of plugins) {
    for (const dep of plugin.requiredModules) {
      if (!pluginIds.has(dep)) {
        problems.push(`${plugin.id}.requiredModules references unknown module "${dep}"`);
      }
    }
    for (const dep of plugin.optionalModules) {
      if (!pluginIds.has(dep)) {
        problems.push(`${plugin.id}.optionalModules references unknown module "${dep}"`);
      }
    }
  }

  // 2. Module dependency graph is acyclic.
  {
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string, path: string[]): void => {
      if (visited.has(id)) return;
      if (visiting.has(id)) {
        problems.push(`module dependency cycle: ${[...path, id].join(' -> ')}`);
        return;
      }
      visiting.add(id);
      const plugin = plugins.find((p) => p.id === id);
      if (plugin) {
        for (const dep of plugin.requiredModules) {
          visit(dep, [...path, id]);
        }
      }
      visiting.delete(id);
      visited.add(id);
    };
    for (const plugin of plugins) {
      visit(plugin.id, []);
    }
  }

  // 3. Step keys: shared keys across plugins must reference the same node
  //    object (intentional sharing of cross-cutting steps, e.g. cicd:*).
  {
    const owner = new Map<string, { pluginId: string; node: unknown }>();
    for (const plugin of plugins) {
      for (const step of plugin.steps) {
        const prev = owner.get(step.key);
        if (prev && prev.node !== step) {
          problems.push(
            `step "${step.key}" defined as different objects by "${prev.pluginId}" and "${plugin.id}"`,
          );
        } else if (!prev) {
          owner.set(step.key, { pluginId: plugin.id, node: step });
        }
      }
    }
  }
  {
    const owner = new Map<string, { pluginId: string; node: unknown }>();
    for (const plugin of plugins) {
      for (const step of plugin.teardownSteps) {
        const prev = owner.get(step.key);
        if (prev && prev.node !== step) {
          problems.push(
            `teardown step "${step.key}" defined as different objects by "${prev.pluginId}" and "${plugin.id}"`,
          );
        } else if (!prev) {
          owner.set(step.key, { pluginId: plugin.id, node: step });
        }
      }
    }
  }

  // 4. Every dependency nodeKey resolves to a known step / teardown / user action.
  {
    const stepKeys = new Set(plugins.flatMap((p) => p.steps.map((s) => s.key)));
    const teardownKeys = new Set(plugins.flatMap((p) => p.teardownSteps.map((s) => s.key)));
    const userActionKeys = new Set(plugins.flatMap((p) => p.userActions.map((a) => a.key)));
    const knownKeys = new Set([...stepKeys, ...teardownKeys, ...userActionKeys]);
    for (const plugin of plugins) {
      const allNodes = [...plugin.steps, ...plugin.teardownSteps, ...plugin.userActions];
      for (const node of allNodes) {
        for (const dep of node.dependencies ?? []) {
          if (!knownKeys.has(dep.nodeKey)) {
            problems.push(
              `${plugin.id}: node "${node.key}" depends on unknown node "${dep.nodeKey}"`,
            );
          }
        }
      }
    }
  }

  // 5. Platform masks are valid mobile platforms.
  for (const plugin of plugins) {
    const allNodes = [...plugin.steps, ...plugin.teardownSteps, ...plugin.userActions];
    for (const node of allNodes) {
      for (const p of node.platforms ?? []) {
        if (!validPlatforms.has(p)) {
          problems.push(`${plugin.id}: node "${node.key}" has invalid platform "${p}"`);
        }
      }
    }
    for (const p of plugin.platforms ?? []) {
      if (!validPlatforms.has(p)) {
        problems.push(`${plugin.id}: invalid module platform "${p}"`);
      }
    }
  }

  // 6. Journey phases are known.
  for (const plugin of plugins) {
    if (plugin.defaultJourneyPhase && !validPhases.has(plugin.defaultJourneyPhase)) {
      problems.push(
        `${plugin.id}.defaultJourneyPhase references unknown journey phase "${plugin.defaultJourneyPhase}"`,
      );
    }
    for (const [stepKey, phase] of Object.entries(plugin.journeyPhaseOverrides ?? {})) {
      if (!validPhases.has(phase)) {
        problems.push(
          `${plugin.id}.journeyPhaseOverrides[${stepKey}] references unknown journey phase "${phase}"`,
        );
      }
    }
  }

  // 7. Templates referenced by plugins are registered.
  {
    const templates = registry.getProjectTemplates();
    const templateIds = new Set(Object.keys(templates));
    for (const plugin of plugins) {
      for (const tid of plugin.includedInTemplates ?? []) {
        if (!templateIds.has(tid)) {
          problems.push(
            `${plugin.id}.includedInTemplates references unknown template "${tid}"`,
          );
        }
      }
    }

    // 8. Templates are closed under requiredModules.
    const catalog = registry.getModuleCatalog();
    for (const [tid, template] of Object.entries(templates)) {
      const moduleSet = new Set(template.modules);
      for (const mid of template.modules) {
        const def = catalog[mid];
        if (!def) {
          problems.push(`template "${tid}" references unknown module "${mid}"`);
          continue;
        }
        for (const req of def.requiredModules) {
          if (!moduleSet.has(req)) {
            problems.push(
              `template "${tid}" includes "${mid}" which requires "${req}", but "${req}" is not in the template`,
            );
          }
        }
      }
    }
  }

  // 9. Integration ids resolve.
  {
    const integrationIds = new Set(registry.getIntegrations().map((i) => i.id));
    for (const plugin of plugins) {
      const id = registry.resolveIntegrationId(plugin);
      if (!integrationIds.has(id)) {
        problems.push(
          `${plugin.id} resolves to integration "${id}" which is not registered`,
        );
      }
    }
  }

  if (problems.length > 0 && throwOnError) {
    throw new AggregateRegistryError(problems);
  }

  return { ok: problems.length === 0, problems };
}
