import { DriftFinding, LiveResource, Manifest } from '../types/manifest';
import { computeHash } from './hash-calculator';

export class DriftDetector {
  detectDrift(manifest: Manifest, liveResources: LiveResource[]): DriftFinding[] {
    const findings: DriftFinding[] = [];
    const now = Date.now();

    // Build a map of live resources for quick lookup
    const liveMap = new Map<string, LiveResource>();
    for (const live of liveResources) {
      liveMap.set(`${live.provider}:${live.resourceId}`, live);
    }

    // Build a map of manifest resources for quick lookup
    const manifestMap = new Map(
      manifest.resources.map((r) => [`${r.provider}:${r.resourceId}`, r]),
    );

    // Check each manifest resource against live state
    for (const resource of manifest.resources) {
      const key = `${resource.provider}:${resource.resourceId}`;
      const liveResource = liveMap.get(key);

      if (!liveResource) {
        // Resource exists in manifest but not in live state — deleted
        findings.push({
          driftType: 'resource_deleted',
          resourceId: resource.resourceId,
          provider: resource.provider,
          resourceType: resource.resourceType,
          oldHash: resource.configHash,
          oldConfig: resource.configuration,
          detectedAt: now,
        });
        continue;
      }

      // Resource exists in both — check for config changes
      const liveHash = computeHash(liveResource.configuration);
      if (liveHash !== resource.configHash) {
        findings.push({
          driftType: 'config_change',
          resourceId: resource.resourceId,
          provider: resource.provider,
          resourceType: resource.resourceType,
          oldHash: resource.configHash,
          newHash: liveHash,
          oldConfig: resource.configuration,
          newConfig: liveResource.configuration,
          detectedAt: now,
        });
      }
    }

    // Check for new resources in live state not in manifest
    for (const live of liveResources) {
      const key = `${live.provider}:${live.resourceId}`;
      if (!manifestMap.has(key)) {
        findings.push({
          driftType: 'resource_added',
          resourceId: live.resourceId,
          provider: live.provider,
          resourceType: live.resourceType,
          newHash: computeHash(live.configuration),
          newConfig: live.configuration,
          detectedAt: now,
        });
      }
    }

    return findings;
  }
}
