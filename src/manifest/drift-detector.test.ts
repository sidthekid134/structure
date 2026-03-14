import { Manifest } from '../types/manifest';
import { computeHash } from './hash-calculator';
import { DriftDetector } from './drift-detector';

const makeManifest = (resources: Manifest['resources']): Manifest => ({
  projectId: 'proj-1',
  generatedAt: Date.now(),
  version: '1.0',
  resources,
});

describe('DriftDetector.detectDrift', () => {
  const detector = new DriftDetector();

  const config1 = { name: 'MyApp', bundleId: 'com.example.app' };
  const config2 = { name: 'MyApp Updated', bundleId: 'com.example.app' };
  const hash1 = computeHash(config1);
  const hash2 = computeHash(config2);

  const manifestResource = {
    provider: 'firebase',
    resourceType: 'app',
    resourceId: 'app-001',
    configHash: hash1,
    lastVerified: Date.now(),
    configuration: config1,
  };

  it('returns empty findings when no drift', () => {
    const manifest = makeManifest([manifestResource]);
    const live = [
      { provider: 'firebase', resourceType: 'app', resourceId: 'app-001', configuration: config1 },
    ];
    const findings = detector.detectDrift(manifest, live);
    expect(findings).toHaveLength(0);
  });

  it('detects config_change when hash differs', () => {
    const manifest = makeManifest([manifestResource]);
    const live = [
      { provider: 'firebase', resourceType: 'app', resourceId: 'app-001', configuration: config2 },
    ];
    const findings = detector.detectDrift(manifest, live);
    expect(findings).toHaveLength(1);
    expect(findings[0].driftType).toBe('config_change');
    expect(findings[0].resourceId).toBe('app-001');
    expect(findings[0].oldHash).toBe(hash1);
    expect(findings[0].newHash).toBe(hash2);
    expect(findings[0].oldConfig).toEqual(config1);
    expect(findings[0].newConfig).toEqual(config2);
  });

  it('detects resource_deleted when resource not in live state', () => {
    const manifest = makeManifest([manifestResource]);
    const findings = detector.detectDrift(manifest, []);
    expect(findings).toHaveLength(1);
    expect(findings[0].driftType).toBe('resource_deleted');
    expect(findings[0].resourceId).toBe('app-001');
    expect(findings[0].oldHash).toBe(hash1);
    expect(findings[0].oldConfig).toEqual(config1);
  });

  it('detects resource_added when live has resource not in manifest', () => {
    const manifest = makeManifest([]);
    const live = [
      { provider: 'github', resourceType: 'repository', resourceId: 'repo-1', configuration: config1 },
    ];
    const findings = detector.detectDrift(manifest, live);
    expect(findings).toHaveLength(1);
    expect(findings[0].driftType).toBe('resource_added');
    expect(findings[0].resourceId).toBe('repo-1');
    expect(findings[0].newConfig).toEqual(config1);
  });

  it('handles multiple findings across providers', () => {
    const manifest = makeManifest([
      manifestResource,
      {
        provider: 'github',
        resourceType: 'repository',
        resourceId: 'repo-old',
        configHash: hash1,
        lastVerified: Date.now(),
        configuration: config1,
      },
    ]);
    const live = [
      // firebase app config changed
      { provider: 'firebase', resourceType: 'app', resourceId: 'app-001', configuration: config2 },
      // repo-old deleted
      // new repo added
      { provider: 'github', resourceType: 'repository', resourceId: 'repo-new', configuration: config1 },
    ];
    const findings = detector.detectDrift(manifest, live);
    expect(findings).toHaveLength(3);
    const types = findings.map((f) => f.driftType).sort();
    expect(types).toEqual(['config_change', 'resource_added', 'resource_deleted']);
  });

  it('sets detectedAt timestamp on findings', () => {
    const before = Date.now();
    const manifest = makeManifest([manifestResource]);
    const findings = detector.detectDrift(manifest, []);
    const after = Date.now();
    expect(findings[0].detectedAt).toBeGreaterThanOrEqual(before);
    expect(findings[0].detectedAt).toBeLessThanOrEqual(after);
  });

  it('does not detect drift for same-provider different resources', () => {
    const resource2 = { ...manifestResource, resourceId: 'app-002' };
    const manifest = makeManifest([manifestResource, resource2]);
    const live = [
      { provider: 'firebase', resourceType: 'app', resourceId: 'app-001', configuration: config1 },
      { provider: 'firebase', resourceType: 'app', resourceId: 'app-002', configuration: config1 },
    ];
    expect(detector.detectDrift(manifest, live)).toHaveLength(0);
  });
});
