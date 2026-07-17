import { globalPluginRegistry } from '../plugins/plugin-registry';
import { registerBuiltinPlugins } from '../plugins/builtin/index';
import { BUILTIN_INTEGRATIONS } from '../plugins/builtin-integrations';
import { buildProvisioningPlanForModules } from '../provisioning/step-registry';
import {
  JOURNEY_PHASE_ORDER,
} from '../provisioning/journey-phases';
import { ALL_MOBILE_PLATFORMS } from '../provisioning/graph.types';

describe('Integration → Plugin → Step registry', () => {
  beforeAll(() => {
    registerBuiltinPlugins();
  });

  it('registers all built-in integrations on construction', () => {
    const integrations = globalPluginRegistry.getIntegrations();
    const ids = integrations.map((i) => i.id).sort();
    const expected = BUILTIN_INTEGRATIONS.map((i) => i.id).sort();
    expect(ids).toEqual(expected);
  });

  it('returns integrations sorted by `order`', () => {
    const integrations = globalPluginRegistry.getIntegrations();
    const orders = integrations.map((i) => i.order);
    const sorted = [...orders].sort((a, b) => a - b);
    expect(orders).toEqual(sorted);
  });

  it('every built-in plugin resolves to a registered integration', () => {
    const integrationIds = new Set(globalPluginRegistry.getIntegrations().map((i) => i.id));
    for (const plugin of globalPluginRegistry.getAllPlugins()) {
      const id = globalPluginRegistry.resolveIntegrationId(plugin);
      expect(integrationIds.has(id)).toBe(true);
    }
  });

  it('groups Firebase plugins under the gcp integration', () => {
    const gcpPlugins = globalPluginRegistry.getPluginsForIntegration('gcp').map((p) => p.id);
    expect(gcpPlugins).toEqual(
      expect.arrayContaining([
        'firebase-core',
        'firebase-auth',
        'firebase-firestore',
        'firebase-storage',
        'firebase-messaging',
      ]),
    );
  });

  it('exposes integrations via getPluginCatalog()', () => {
    const catalog = globalPluginRegistry.getPluginCatalog();
    expect(catalog.integrations).toBeDefined();
    expect(catalog.integrations.length).toBe(BUILTIN_INTEGRATIONS.length);
    const gcp = catalog.integrations.find((i) => i.id === 'gcp');
    expect(gcp?.pluginIds).toEqual(expect.arrayContaining(['firebase-core', 'firebase-auth']));
  });

  it('every module entry in the catalog carries an integrationId', () => {
    const catalog = globalPluginRegistry.getPluginCatalog();
    for (const [moduleId, module] of Object.entries(catalog.modules)) {
      expect(module.integrationId).toBeDefined();
      expect(typeof module.integrationId).toBe('string');
      // sanity: integrationId is a known integration
      expect(catalog.integrations.find((i) => i.id === module.integrationId)).toBeDefined();
      // moduleId matches the entry id
      expect(module.id).toBe(moduleId);
    }
  });

  it('getStepsForIntegration returns the union of plugin steps for that integration', () => {
    const gcpSteps = globalPluginRegistry.getStepsForIntegration('gcp');
    const fromPlugins = globalPluginRegistry
      .getPluginsForIntegration('gcp')
      .flatMap((p) => p.steps.map((s) => s.key));
    // dedupe (both sources may include shared steps in multi-plugin scenarios)
    expect(new Set(gcpSteps.map((s) => s.key))).toEqual(new Set(fromPlugins));
  });

  it('keeps web-only Cloud Run plans from pulling API deployment nodes through combo checks', () => {
    const plan = buildProvisioningPlanForModules(
      'web-only',
      ['gcp-serverless-web'],
      ['dev'],
    );
    const nodeKeys = new Set(plan.nodes.map((node) => node.key));

    expect(nodeKeys.has('web:cicd-verify-deploy')).toBe(true);
    expect(nodeKeys.has('api:deploy-cloud-run')).toBe(false);
    expect(nodeKeys.has('combo:cross-service-smoke-check')).toBe(false);
    expect(nodeKeys.has('gcp:prepare-runtime-foundation')).toBe(true);
    expect(nodeKeys.has('web:sync-runtime-config')).toBe(false);
  });

  it('keeps Cloud Run foundation on Google Cloud without pulling Firebase app services', () => {
    const plan = buildProvisioningPlanForModules(
      'gcp-only',
      ['gcp-serverless-web'],
      ['dev'],
    );
    const nodeKeys = new Set(plan.nodes.map((node) => node.key));

    expect(plan.selectedModules).toEqual(expect.arrayContaining(['gcp-project-foundation']));
    expect(plan.selectedModules).not.toContain('firebase-core');
    expect(nodeKeys.has('firebase:create-gcp-project')).toBe(true);
    expect(nodeKeys.has('firebase:enable-firebase')).toBe(false);
    expect(nodeKeys.has('firebase:create-provisioner-sa')).toBe(false);
    expect(nodeKeys.has('firebase:bind-provisioner-iam')).toBe(false);
    expect(nodeKeys.has('firebase:generate-sa-key')).toBe(false);
    expect(nodeKeys.has('firebase:register-ios-app')).toBe(false);
    expect(nodeKeys.has('firebase:register-android-app')).toBe(false);
  });

  it('does not pull Firebase or Google Cloud foundation for GitHub-only CI', () => {
    const plan = buildProvisioningPlanForModules(
      'github-only',
      ['github-ci'],
      ['dev'],
    );
    const nodeKeys = new Set(plan.nodes.map((node) => node.key));

    expect(plan.selectedModules).toEqual(expect.arrayContaining(['github-repo', 'github-ci']));
    expect(plan.selectedModules).not.toContain('gcp-project-foundation');
    expect(plan.selectedModules).not.toContain('firebase-core');
    expect(nodeKeys.has('firebase:create-gcp-project')).toBe(false);
    expect(nodeKeys.has('firebase:enable-firebase')).toBe(false);
  });

  it('keeps auth callback route hosting out of Cloudflare-only domain plans', () => {
    const plan = buildProvisioningPlanForModules(
      'domain-only',
      ['cloudflare-domain'],
      ['dev'],
    );
    const nodeKeys = new Set(plan.nodes.map((node) => node.key));

    expect(nodeKeys.has('cloudflare:configure-dns')).toBe(true);
    expect(nodeKeys.has('cloudflare:configure-ssl')).toBe(true);
    expect(nodeKeys.has('cloudflare:configure-deep-link-routes')).toBe(false);
    expect(nodeKeys.has('oauth:link-deep-link-domain')).toBe(false);
  });

  it('adds full-stack Cloud Run coordination only when both web and API modules are selected', () => {
    const plan = buildProvisioningPlanForModules(
      'fullstack',
      ['gcp-serverless-fullstack'],
      ['dev'],
    );
    const nodeKeys = new Set(plan.nodes.map((node) => node.key));

    expect(plan.selectedModules).toEqual(
      expect.arrayContaining([
        'gcp-serverless-api',
        'gcp-serverless-web',
        'gcp-serverless-fullstack',
      ]),
    );
    expect(nodeKeys.has('api:deploy-cloud-run')).toBe(true);
    expect(nodeKeys.has('web:cicd-verify-deploy')).toBe(true);
    expect(nodeKeys.has('combo:cross-service-smoke-check')).toBe(true);
    expect(nodeKeys.has('api:push-artifact')).toBe(false);
    expect(nodeKeys.has('combo:align-env-contract')).toBe(false);
    expect(nodeKeys.has('combo:sync-oauth-callback-domains')).toBe(false);
  });

  it('marks serverless steps as non-revertible in step capabilities', () => {
    const apiDeployCaps = globalPluginRegistry.getStepCapabilities('api:deploy-cloud-run');
    const foundationCaps = globalPluginRegistry.getStepCapabilities('gcp:prepare-runtime-foundation');
    const fullstackCaps = globalPluginRegistry.getStepCapabilities('combo:cross-service-smoke-check');

    expect(apiDeployCaps.supportsRevert).toBe(false);
    expect(foundationCaps.supportsRevert).toBe(false);
    expect(fullstackCaps.supportsRevert).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Plugin registry invariants — guard against drift between PluginDefinition
// fields and the rest of the system. Failure here means the registry contains
// a structurally inconsistent definition that would otherwise produce silent
// runtime bugs.
// ---------------------------------------------------------------------------

describe('Plugin registry invariants', () => {
  beforeAll(() => {
    registerBuiltinPlugins();
  });

  it('every requiredModules / optionalModules id resolves to a registered plugin', () => {
    const known = new Set(globalPluginRegistry.getAllPlugins().map((p) => p.id));
    const errors: string[] = [];
    for (const plugin of globalPluginRegistry.getAllPlugins()) {
      for (const dep of plugin.requiredModules) {
        if (!known.has(dep)) errors.push(`${plugin.id}.requiredModules: unknown "${dep}"`);
      }
      for (const dep of plugin.optionalModules) {
        if (!known.has(dep)) errors.push(`${plugin.id}.optionalModules: unknown "${dep}"`);
      }
    }
    expect(errors).toEqual([]);
  });

  it('module dependency graph is acyclic', () => {
    const catalog = globalPluginRegistry.getModuleCatalog();
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const cycles: string[] = [];
    const visit = (id: string, path: string[]): void => {
      if (visited.has(id)) return;
      if (visiting.has(id)) {
        cycles.push([...path, id].join(' -> '));
        return;
      }
      visiting.add(id);
      const def = catalog[id];
      if (def) {
        for (const dep of def.requiredModules) {
          visit(dep, [...path, id]);
        }
      }
      visiting.delete(id);
      visited.add(id);
    };
    for (const id of Object.keys(catalog)) {
      visit(id, []);
    }
    expect(cycles).toEqual([]);
  });

  // Multiple plugins are allowed to list the same step in their `steps` array
  // (used for cross-cutting steps like `cicd:*` shared by gcp-serverless-api
  // and gcp-serverless-web). The contract is that they MUST share the exact
  // same node object — distinct objects with the same key indicate drift
  // between two definitions of "the same" step.
  it('shared step keys reference the same node object across plugins', () => {
    const owner = new Map<string, { pluginId: string; node: unknown }>();
    const collisions: string[] = [];
    for (const plugin of globalPluginRegistry.getAllPlugins()) {
      for (const step of plugin.steps) {
        const prev = owner.get(step.key);
        if (prev && prev.node !== step) {
          collisions.push(
            `step "${step.key}" defined as different objects by "${prev.pluginId}" and "${plugin.id}"`,
          );
        } else if (!prev) {
          owner.set(step.key, { pluginId: plugin.id, node: step });
        }
      }
    }
    expect(collisions).toEqual([]);
  });

  it('shared teardown step keys reference the same node object across plugins', () => {
    const owner = new Map<string, { pluginId: string; node: unknown }>();
    const collisions: string[] = [];
    for (const plugin of globalPluginRegistry.getAllPlugins()) {
      for (const step of plugin.teardownSteps) {
        const prev = owner.get(step.key);
        if (prev && prev.node !== step) {
          collisions.push(
            `teardown "${step.key}" defined as different objects by "${prev.pluginId}" and "${plugin.id}"`,
          );
        } else if (!prev) {
          owner.set(step.key, { pluginId: plugin.id, node: step });
        }
      }
    }
    expect(collisions).toEqual([]);
  });

  it('every step.dependencies[].nodeKey resolves to a known step or user action', () => {
    const stepKeys = new Set(
      globalPluginRegistry.getAllPlugins().flatMap((p) => p.steps.map((s) => s.key)),
    );
    const teardownKeys = new Set(
      globalPluginRegistry.getAllPlugins().flatMap((p) => p.teardownSteps.map((s) => s.key)),
    );
    const userActionKeys = new Set(
      globalPluginRegistry.getAllPlugins().flatMap((p) => p.userActions.map((a) => a.key)),
    );
    const knownKeys = new Set([...stepKeys, ...teardownKeys, ...userActionKeys]);
    const errors: string[] = [];
    for (const plugin of globalPluginRegistry.getAllPlugins()) {
      const allNodes = [...plugin.steps, ...plugin.teardownSteps, ...plugin.userActions];
      for (const node of allNodes) {
        for (const dep of node.dependencies ?? []) {
          if (!knownKeys.has(dep.nodeKey)) {
            errors.push(`${plugin.id}: node "${node.key}" depends on unknown "${dep.nodeKey}"`);
          }
        }
      }
    }
    expect(errors).toEqual([]);
  });

  it('every node.platforms entry is a valid mobile platform', () => {
    const valid = new Set(ALL_MOBILE_PLATFORMS);
    const errors: string[] = [];
    for (const plugin of globalPluginRegistry.getAllPlugins()) {
      const allNodes = [...plugin.steps, ...plugin.teardownSteps, ...plugin.userActions];
      for (const node of allNodes) {
        for (const p of node.platforms ?? []) {
          if (!valid.has(p)) errors.push(`${plugin.id}: ${node.key} has invalid platform "${p}"`);
        }
      }
      for (const p of plugin.platforms ?? []) {
        if (!valid.has(p)) errors.push(`${plugin.id}: invalid module platform "${p}"`);
      }
    }
    expect(errors).toEqual([]);
  });

  it('every defaultJourneyPhase / journeyPhaseOverrides id is a known journey phase', () => {
    const validPhases = new Set(JOURNEY_PHASE_ORDER);
    const errors: string[] = [];
    for (const plugin of globalPluginRegistry.getAllPlugins()) {
      if (plugin.defaultJourneyPhase && !validPhases.has(plugin.defaultJourneyPhase)) {
        errors.push(`${plugin.id}.defaultJourneyPhase: unknown "${plugin.defaultJourneyPhase}"`);
      }
      for (const [stepKey, phase] of Object.entries(plugin.journeyPhaseOverrides ?? {})) {
        if (!validPhases.has(phase)) {
          errors.push(`${plugin.id}.journeyPhaseOverrides[${stepKey}]: unknown phase "${phase}"`);
        }
      }
    }
    expect(errors).toEqual([]);
  });

  it('every includedInTemplates id resolves to a derived template', () => {
    const templates = globalPluginRegistry.getProjectTemplates();
    const knownTemplates = new Set(Object.keys(templates));
    const errors: string[] = [];
    for (const plugin of globalPluginRegistry.getAllPlugins()) {
      for (const tid of plugin.includedInTemplates ?? []) {
        if (!knownTemplates.has(tid)) {
          errors.push(`${plugin.id}.includedInTemplates: unknown template "${tid}"`);
        }
      }
    }
    expect(errors).toEqual([]);
  });

  it('every template is closed under requiredModules (no unsatisfiable hard deps)', () => {
    const templates = globalPluginRegistry.getProjectTemplates();
    const catalog = globalPluginRegistry.getModuleCatalog();
    const errors: string[] = [];
    for (const [tid, template] of Object.entries(templates)) {
      const moduleSet = new Set(template.modules);
      for (const mid of template.modules) {
        const def = catalog[mid];
        if (!def) {
          errors.push(`template "${tid}" references unknown module "${mid}"`);
          continue;
        }
        for (const req of def.requiredModules) {
          if (!moduleSet.has(req)) {
            errors.push(
              `template "${tid}" includes "${mid}" which requires "${req}", but the template does not include "${req}"`,
            );
          }
        }
      }
    }
    expect(errors).toEqual([]);
  });

  it('snapshots the resolved module set per built-in template', () => {
    const templates = globalPluginRegistry.getProjectTemplates();
    const snapshot: Record<string, string[]> = {};
    for (const [tid, t] of Object.entries(templates)) {
      snapshot[tid] = [...t.modules].sort();
    }
    expect(snapshot).toMatchInlineSnapshot(`
{
  "api-backend": [
    "firebase-auth",
    "firebase-core",
    "firebase-firestore",
    "gcp-project-foundation",
    "gcp-serverless-api",
    "gcp-serverless-core",
    "github-ci",
    "github-repo",
  ],
  "custom": [],
  "mobile-app": [
    "apple-signing",
    "cloudflare-domain",
    "eas-builds",
    "eas-submit",
    "firebase-auth",
    "firebase-core",
    "firebase-firestore",
    "firebase-messaging",
    "firebase-storage",
    "gcp-project-foundation",
    "github-ci",
    "github-repo",
    "google-play-publishing",
    "oauth-social",
  ],
  "web-app": [
    "cloudflare-domain",
    "firebase-auth",
    "firebase-core",
    "firebase-firestore",
    "gcp-project-foundation",
    "gcp-serverless-core",
    "gcp-serverless-web",
    "github-ci",
    "github-repo",
    "oauth-social",
  ],
}
`);
  });
});
