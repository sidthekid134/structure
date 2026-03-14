import { LiveResource, ManifestResource } from '../types/manifest';
import { computeHash } from './hash-calculator';

/**
 * Checks whether a provisioning step needs to be performed or can be skipped
 * because the work was already done in a previous run.
 */
export class IdempotencyChecker {
  /**
   * Returns true if the manifest resource's hash matches the given hash,
   * meaning the resource config is unchanged and the step can be skipped.
   */
  isUnchanged(existing: ManifestResource, currentHash: string): boolean {
    return existing.configHash === currentHash;
  }

  /**
   * Checks whether a live resource already exists in the live state,
   * comparing by provider and resourceId.
   */
  resourceExistsInLiveState(
    resourceId: string,
    provider: string,
    liveResources: LiveResource[],
  ): boolean {
    return liveResources.some(
      (r) => r.provider === provider && r.resourceId === resourceId,
    );
  }

  /**
   * Checks whether a live resource has the same configuration as the stored manifest entry.
   * Returns true if no update is needed.
   */
  configMatchesLiveState(
    existing: ManifestResource,
    liveResource: LiveResource,
  ): boolean {
    const liveHash = computeHash(liveResource.configuration);
    return existing.configHash === liveHash;
  }

  /**
   * Determines whether a manifest resource step can be skipped entirely.
   * Logs the reason for skipping.
   */
  shouldSkip(
    step: string,
    existing: ManifestResource | undefined,
    liveResource: LiveResource | undefined,
  ): boolean {
    if (!existing && !liveResource) return false;

    if (!liveResource) {
      // Resource doesn't exist in live state — needs creation
      return false;
    }

    if (!existing) {
      // No manifest entry — can't determine idempotency
      return false;
    }

    const liveHash = computeHash(liveResource.configuration);
    if (existing.configHash === liveHash) {
      console.log(
        `[idempotency] Skipping step "${step}" for ${existing.provider}/${existing.resourceType}/${existing.resourceId}: already up to date`,
      );
      return true;
    }

    return false;
  }
}
