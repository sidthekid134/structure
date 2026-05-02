import { globalPluginRegistry } from '../plugins/plugin-registry';
import { registerBuiltinPlugins } from '../plugins/builtin/index';
import { BUILTIN_INTEGRATIONS } from '../plugins/builtin-integrations';

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
});
