import { LiveResource, ManifestResource } from '../types/manifest';
import { computeHash } from './hash-calculator';
import { IdempotencyChecker } from './idempotency-checker';

const config = { name: 'MyApp', bundleId: 'com.example.app' };
const hash = computeHash(config);

const manifestResource: ManifestResource = {
  provider: 'firebase',
  resourceType: 'app',
  resourceId: 'app-1',
  configHash: hash,
  lastVerified: Date.now(),
  configuration: config,
};

const liveResource: LiveResource = {
  provider: 'firebase',
  resourceType: 'app',
  resourceId: 'app-1',
  configuration: config,
};

describe('IdempotencyChecker', () => {
  const checker = new IdempotencyChecker();

  describe('isUnchanged', () => {
    it('returns true when hash matches', () => {
      expect(checker.isUnchanged(manifestResource, hash)).toBe(true);
    });

    it('returns false when hash differs', () => {
      expect(checker.isUnchanged(manifestResource, 'b'.repeat(64))).toBe(false);
    });
  });

  describe('resourceExistsInLiveState', () => {
    it('returns true when resource exists in live state', () => {
      expect(checker.resourceExistsInLiveState('app-1', 'firebase', [liveResource])).toBe(true);
    });

    it('returns false when resource does not exist', () => {
      expect(checker.resourceExistsInLiveState('app-999', 'firebase', [liveResource])).toBe(false);
    });

    it('returns false when provider differs', () => {
      expect(checker.resourceExistsInLiveState('app-1', 'github', [liveResource])).toBe(false);
    });
  });

  describe('configMatchesLiveState', () => {
    it('returns true when config matches', () => {
      expect(checker.configMatchesLiveState(manifestResource, liveResource)).toBe(true);
    });

    it('returns false when config differs', () => {
      const changed: LiveResource = {
        ...liveResource,
        configuration: { name: 'Different', bundleId: 'com.other' },
      };
      expect(checker.configMatchesLiveState(manifestResource, changed)).toBe(false);
    });
  });

  describe('shouldSkip', () => {
    it('returns true and logs when resource is unchanged', () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      const result = checker.shouldSkip('create-app', manifestResource, liveResource);
      expect(result).toBe(true);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Skipping step "create-app"'),
      );
      consoleSpy.mockRestore();
    });

    it('returns false when no existing resource', () => {
      expect(checker.shouldSkip('create-app', undefined, liveResource)).toBe(false);
    });

    it('returns false when no live resource', () => {
      expect(checker.shouldSkip('create-app', manifestResource, undefined)).toBe(false);
    });

    it('returns false when both are undefined', () => {
      expect(checker.shouldSkip('create-app', undefined, undefined)).toBe(false);
    });

    it('returns false when config has changed', () => {
      const changed: LiveResource = {
        ...liveResource,
        configuration: { name: 'Changed App' },
      };
      expect(checker.shouldSkip('create-app', manifestResource, changed)).toBe(false);
    });
  });
});
