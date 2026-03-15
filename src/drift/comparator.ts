/**
 * StateComparator — field-by-field comparison between manifest config and
 * live provider state, returning structured DriftDifference items.
 */

import {
  ProviderConfig,
  ProviderState,
  DriftDifference,
  ConflictType,
} from '../providers/types.js';

export class StateComparator {
  /**
   * Compares the manifest config against the live state field by field.
   * Returns an array of differences with old_value, new_value, and conflict_type.
   */
  static compare(
    manifest: ProviderConfig,
    liveState: ProviderState | null,
  ): DriftDifference[] {
    if (!liveState) {
      return [
        {
          field: 'provider',
          manifest_value: manifest.provider,
          live_value: null,
          conflict_type: 'missing_in_live',
        },
      ];
    }

    const differences: DriftDifference[] = [];
    const manifestObj = manifest as unknown as Record<string, unknown>;

    // Compare top-level manifest fields against live resource IDs / config hashes
    for (const [key, manifestValue] of Object.entries(manifestObj)) {
      if (key === 'provider') continue; // discriminator, not a resource

      const liveValue = this.resolveLiveValue(key, manifestValue, liveState);

      if (liveValue === undefined) {
        // Field is present in manifest but not tracked in live state
        differences.push({
          field: key,
          manifest_value: manifestValue,
          live_value: null,
          conflict_type: 'missing_in_live',
        });
      } else if (!this.deepEqual(manifestValue, liveValue)) {
        differences.push({
          field: key,
          manifest_value: manifestValue,
          live_value: liveValue,
          conflict_type: 'value_mismatch',
        });
      }
    }

    // Find orphaned resources in live state not in manifest
    const orphaned = this.findOrphanedResources(manifestObj, liveState);
    for (const orphan of orphaned) {
      differences.push({
        field: orphan,
        manifest_value: null,
        live_value: liveState.resource_ids[orphan] ?? null,
        conflict_type: 'orphaned_resource',
      });
    }

    return differences;
  }

  /**
   * Extracts orphaned resource keys — present in live state but not manifest.
   */
  static findOrphanedResources(
    manifestObj: Record<string, unknown>,
    liveState: ProviderState,
  ): string[] {
    const manifestKeys = new Set(Object.keys(manifestObj));
    const orphaned: string[] = [];

    for (const resourceKey of Object.keys(liveState.resource_ids)) {
      // Map resource_id keys back to manifest field names
      const baseKey = resourceKey.replace(/^service_|^env_|^workflow_/, '');
      if (!manifestKeys.has(baseKey) && !manifestKeys.has(resourceKey)) {
        orphaned.push(resourceKey);
      }
    }

    return orphaned;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private static resolveLiveValue(
    key: string,
    _manifestValue: unknown,
    liveState: ProviderState,
  ): unknown {
    // Check direct resource_id match
    if (liveState.resource_ids[key] !== undefined) {
      return liveState.resource_ids[key];
    }

    // Check config hash
    if (liveState.config_hashes[key] !== undefined) {
      return liveState.config_hashes[key];
    }

    return undefined;
  }

  private static deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (typeof a !== typeof b) return false;
    if (a === null || b === null) return a === b;

    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      return a.every((item, i) => this.deepEqual(item, b[i]));
    }

    if (typeof a === 'object' && typeof b === 'object') {
      const aObj = a as Record<string, unknown>;
      const bObj = b as Record<string, unknown>;
      const aKeys = Object.keys(aObj);
      const bKeys = Object.keys(bObj);
      if (aKeys.length !== bKeys.length) return false;
      return aKeys.every(k => this.deepEqual(aObj[k], bObj[k]));
    }

    return false;
  }
}
