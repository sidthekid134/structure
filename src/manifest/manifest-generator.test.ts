import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProviderCredentials } from '../types/manifest';
import { DRIFT_REPORT_FILENAME, ManifestGenerator } from './manifest-generator';
import { MANIFEST_FILENAME, MANIFEST_VERSION, saveManifest } from './manifest-storage';
import { computeHash } from './hash-calculator';

// Mock adapters so we don't hit real APIs
jest.mock('./adapters/firebase-adapter');
jest.mock('./adapters/apple-adapter');
jest.mock('./adapters/github-adapter');

import { FirebaseAdapter } from './adapters/firebase-adapter';
import { AppleAdapter } from './adapters/apple-adapter';
import { GitHubAdapter } from './adapters/github-adapter';

const MockFirebaseAdapter = FirebaseAdapter as jest.MockedClass<typeof FirebaseAdapter>;
const MockAppleAdapter = AppleAdapter as jest.MockedClass<typeof AppleAdapter>;
const MockGitHubAdapter = GitHubAdapter as jest.MockedClass<typeof GitHubAdapter>;

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-gen-test-'));
  jest.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const githubConfig = {
  fullName: 'user/repo',
  private: false,
  defaultBranch: 'main',
  branchProtection: { enforceAdmins: false, requiredReviewCount: 0, dismissStaleReviews: false, requiredStatusChecks: null },
  environments: [],
};

function setupGithubMock(resources = [
  { provider: 'github', resourceType: 'repository', resourceId: 'user/repo', configuration: githubConfig },
]) {
  MockGitHubAdapter.prototype.authenticate = jest.fn().mockResolvedValue(undefined);
  MockGitHubAdapter.prototype.listResources = jest.fn().mockResolvedValue(resources);
}

const credentials: ProviderCredentials = {
  github: { token: 'ghp_test123' },
};

describe('ManifestGenerator.generateManifest', () => {
  beforeEach(() => {
    MockFirebaseAdapter.prototype.authenticate = jest.fn().mockResolvedValue(undefined);
    MockFirebaseAdapter.prototype.listResources = jest.fn().mockResolvedValue([]);
    MockAppleAdapter.prototype.authenticate = jest.fn().mockResolvedValue(undefined);
    MockAppleAdapter.prototype.listResources = jest.fn().mockResolvedValue([]);
    setupGithubMock();
  });

  it('generates a manifest file in projectRoot', async () => {
    const generator = new ManifestGenerator(path.join(tmpDir, 'locks'));
    await generator.generateManifest('proj-1', tmpDir, credentials);
    expect(fs.existsSync(path.join(tmpDir, MANIFEST_FILENAME))).toBe(true);
  });

  it('manifest contains queried resources', async () => {
    const generator = new ManifestGenerator(path.join(tmpDir, 'locks'));
    const manifest = await generator.generateManifest('proj-1', tmpDir, credentials);
    expect(manifest.resources).toHaveLength(1);
    expect(manifest.resources[0].provider).toBe('github');
    expect(manifest.resources[0].resourceId).toBe('user/repo');
  });

  it('manifest is idempotent (same resources → same hashes)', async () => {
    const generator = new ManifestGenerator(path.join(tmpDir, 'locks'));
    const m1 = await generator.generateManifest('proj-1', tmpDir, credentials);
    const m2 = await generator.generateManifest('proj-1', tmpDir, credentials);
    expect(m1.resources[0].configHash).toBe(m2.resources[0].configHash);
  });

  it('sets projectId and version on manifest', async () => {
    const generator = new ManifestGenerator(path.join(tmpDir, 'locks'));
    const manifest = await generator.generateManifest('my-proj', tmpDir, credentials);
    expect(manifest.projectId).toBe('my-proj');
    expect(manifest.version).toBe(MANIFEST_VERSION);
  });

  it('preserves old resources deleted from provider', async () => {
    // First run: resource exists
    setupGithubMock([
      { provider: 'github', resourceType: 'repository', resourceId: 'user/repo', configuration: githubConfig },
    ]);
    const generator = new ManifestGenerator(path.join(tmpDir, 'locks'));
    await generator.generateManifest('proj-1', tmpDir, credentials);

    // Second run: resource gone from live state
    MockGitHubAdapter.prototype.listResources = jest.fn().mockResolvedValue([]);
    const manifest2 = await generator.generateManifest('proj-1', tmpDir, credentials);

    // Old resource preserved in manifest
    expect(manifest2.resources.some((r) => r.resourceId === 'user/repo')).toBe(true);
  });

  it('acquires and releases lock for projectId', async () => {
    const locksDir = path.join(tmpDir, 'locks');
    const generator = new ManifestGenerator(locksDir);
    await generator.generateManifest('my-app', tmpDir, credentials);
    // Lock should be released after completion
    const lockFile = path.join(locksDir, 'my-app.lock');
    expect(fs.existsSync(lockFile)).toBe(false);
  });
});

describe('ManifestGenerator.reportDrift', () => {
  it('throws if no manifest exists', async () => {
    const generator = new ManifestGenerator(path.join(tmpDir, 'locks'));
    await expect(generator.reportDrift('proj', tmpDir, credentials)).rejects.toThrow(
      'No manifest found',
    );
  });

  it('writes drift report file', async () => {
    // Create existing manifest
    const hash = computeHash(githubConfig);
    saveManifest(tmpDir, {
      projectId: 'proj-1',
      generatedAt: Date.now(),
      version: MANIFEST_VERSION,
      resources: [
        {
          provider: 'github',
          resourceType: 'repository',
          resourceId: 'user/repo',
          configHash: hash,
          lastVerified: Date.now(),
          configuration: githubConfig,
        },
      ],
    });

    setupGithubMock(); // same config = no drift
    const generator = new ManifestGenerator(path.join(tmpDir, 'locks'));
    await generator.reportDrift('proj-1', tmpDir, credentials);

    expect(fs.existsSync(path.join(tmpDir, DRIFT_REPORT_FILENAME))).toBe(true);
    const report = JSON.parse(
      fs.readFileSync(path.join(tmpDir, DRIFT_REPORT_FILENAME), 'utf8'),
    );
    expect(report.summary.total).toBe(0);
  });

  it('detects drift when resource config changes', async () => {
    const oldConfig = { ...githubConfig, private: false };
    const newConfig = { ...githubConfig, private: true };
    const oldHash = computeHash(oldConfig);

    saveManifest(tmpDir, {
      projectId: 'proj-1',
      generatedAt: Date.now(),
      version: MANIFEST_VERSION,
      resources: [
        {
          provider: 'github',
          resourceType: 'repository',
          resourceId: 'user/repo',
          configHash: oldHash,
          lastVerified: Date.now(),
          configuration: oldConfig,
        },
      ],
    });

    setupGithubMock([
      { provider: 'github', resourceType: 'repository', resourceId: 'user/repo', configuration: newConfig },
    ]);

    const generator = new ManifestGenerator(path.join(tmpDir, 'locks'));
    await generator.reportDrift('proj-1', tmpDir, credentials);

    const report = JSON.parse(
      fs.readFileSync(path.join(tmpDir, DRIFT_REPORT_FILENAME), 'utf8'),
    );
    expect(report.summary.configChanges).toBe(1);
  });
});
