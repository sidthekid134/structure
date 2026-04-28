import { buildProvisioningPlan, pruneNodesWithUnresolvedDependencies } from '../provisioning/step-registry.js';
import type { ProvisioningNode } from '../provisioning/graph.types.js';
import { registerBuiltinPlugins } from '../plugins/builtin/index.js';

beforeAll(() => {
  registerBuiltinPlugins();
});

describe('pruneNodesWithUnresolvedDependencies', () => {
  it('removes nodes in dependency order until all required edges resolve', () => {
    const nodes: ProvisioningNode[] = [
      {
        type: 'step',
        key: 'root',
        label: '',
        description: '',
        provider: 'firebase',
        environmentScope: 'global',
        automationLevel: 'full',
        dependencies: [],
        produces: [],
      },
      {
        type: 'step',
        key: 'mid',
        label: '',
        description: '',
        provider: 'eas',
        environmentScope: 'global',
        automationLevel: 'full',
        dependencies: [{ nodeKey: 'missing', required: true }],
        produces: [],
      },
      {
        type: 'step',
        key: 'top',
        label: '',
        description: '',
        provider: 'eas',
        environmentScope: 'global',
        automationLevel: 'full',
        dependencies: [{ nodeKey: 'mid', required: true }],
        produces: [],
      },
    ];
    const out = pruneNodesWithUnresolvedDependencies(nodes);
    expect(out.map((n) => n.key)).toEqual(['root']);
  });
});

describe('buildProvisioningPlan default providers', () => {
  it('does not fail when EAS is selected without Apple / Google Play (cross-provider submit steps pruned)', () => {
    expect(() =>
      buildProvisioningPlan('proj', ['firebase', 'github', 'eas'], ['development', 'production']),
    ).not.toThrow();

    const plan = buildProvisioningPlan('proj', ['firebase', 'github', 'eas'], ['development', 'production']);
    const keys = new Set(plan.nodes.map((n) => n.key));
    expect(keys.has('eas:configure-submit-apple')).toBe(false);
    expect(keys.has('eas:configure-submit-android')).toBe(false);
  });

  it('includes EAS submit steps when Apple and Google Play providers are selected', () => {
    const plan = buildProvisioningPlan(
      'proj',
      ['firebase', 'github', 'eas', 'apple', 'google-play'],
      ['development', 'production'],
    );
    const keys = new Set(plan.nodes.map((n) => n.key));
    expect(keys.has('eas:configure-submit-apple')).toBe(true);
    // ASC API credentials now come from the org-level Apple integration; the
    // dedicated apple:generate-asc-api-key step was removed.
    expect(keys.has('apple:generate-asc-api-key')).toBe(false);
    expect(keys.has('apple:create-app-store-listing')).toBe(true);
    expect(keys.has('eas:configure-submit-android')).toBe(true);
  });
});

describe('buildProvisioningPlan platform filtering', () => {
  it('drops android-only steps for an iOS-only project and relaxes deps that point at them', () => {
    const plan = buildProvisioningPlan(
      'proj',
      ['firebase', 'github', 'eas', 'apple', 'google-play', 'oauth'],
      ['development'],
      undefined,
      ['ios'],
    );
    const keys = new Set(plan.nodes.map((n) => n.key));

    expect(plan.platforms).toEqual(['ios']);
    expect(keys.has('firebase:register-android-app')).toBe(false);
    expect(keys.has('firebase:register-android-sha1')).toBe(false);
    expect(keys.has('google-play:create-app-listing')).toBe(false);
    expect(keys.has('eas:configure-submit-android')).toBe(false);
    expect(keys.has('cloudflare:setup-android-asset-links')).toBe(false);

    expect(keys.has('firebase:register-ios-app')).toBe(true);
    expect(keys.has('apple:register-app-id')).toBe(true);
    expect(keys.has('eas:configure-submit-apple')).toBe(true);
    expect(keys.has('oauth:configure-apple-sign-in')).toBe(true);
    // Split OAuth client registration keeps web + iOS, and drops Android for iOS-only projects.
    expect(keys.has('oauth:register-oauth-client-web')).toBe(true);
    expect(keys.has('oauth:register-oauth-client-ios')).toBe(true);
    expect(keys.has('oauth:register-oauth-client-android')).toBe(false);
  });

  it('drops ios-only steps for an Android-only project', () => {
    const plan = buildProvisioningPlan(
      'proj',
      ['firebase', 'github', 'eas', 'apple', 'google-play', 'oauth'],
      ['development'],
      undefined,
      ['android'],
    );
    const keys = new Set(plan.nodes.map((n) => n.key));

    expect(keys.has('firebase:register-ios-app')).toBe(false);
    expect(keys.has('apple:register-app-id')).toBe(false);
    expect(keys.has('eas:configure-submit-apple')).toBe(false);
    expect(keys.has('oauth:configure-apple-sign-in')).toBe(false);
    expect(keys.has('cloudflare:setup-apple-app-site-association')).toBe(false);

    expect(keys.has('firebase:register-android-app')).toBe(true);
    expect(keys.has('firebase:register-android-sha1')).toBe(true);
    expect(keys.has('google-play:create-app-listing')).toBe(true);
    expect(keys.has('eas:configure-submit-android')).toBe(true);
    expect(keys.has('oauth:register-oauth-client-web')).toBe(true);
    expect(keys.has('oauth:register-oauth-client-ios')).toBe(false);
    expect(keys.has('oauth:register-oauth-client-android')).toBe(true);
    // Android-only projects keep the SHA-1 dependency on the Android registration step.
    const oauthAndroid = plan.nodes.find((n) => n.key === 'oauth:register-oauth-client-android');
    expect(oauthAndroid?.dependencies?.some((d) => d.nodeKey === 'firebase:register-android-sha1')).toBe(true);
  });
});
