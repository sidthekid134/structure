import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Manifest } from '../types/manifest';
import {
  createEmptyManifest,
  loadManifest,
  MANIFEST_FILENAME,
  MANIFEST_VERSION,
  ManifestValidationError,
  mergeResources,
  saveManifest,
  validateManifest,
} from './manifest-storage';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-storage-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const validManifest: Manifest = {
  projectId: 'proj-123',
  generatedAt: 1700000000000,
  version: MANIFEST_VERSION,
  resources: [
    {
      provider: 'firebase',
      resourceType: 'app',
      resourceId: 'app-id-1',
      configHash: 'a'.repeat(64),
      lastVerified: 1700000000000,
    },
  ],
};

describe('validateManifest', () => {
  it('accepts a valid manifest', () => {
    expect(() => validateManifest(validManifest)).not.toThrow();
  });

  it('accepts a manifest with optional lastDriftCheck', () => {
    expect(() =>
      validateManifest({ ...validManifest, lastDriftCheck: Date.now() }),
    ).not.toThrow();
  });

  it('rejects missing projectId', () => {
    const { projectId: _, ...bad } = validManifest;
    expect(() => validateManifest(bad)).toThrow(ManifestValidationError);
  });

  it('rejects empty projectId', () => {
    expect(() => validateManifest({ ...validManifest, projectId: '' })).toThrow(
      ManifestValidationError,
    );
  });

  it('rejects missing version', () => {
    const { version: _, ...bad } = validManifest;
    expect(() => validateManifest(bad)).toThrow(ManifestValidationError);
  });

  it('rejects missing resources array', () => {
    const { resources: _, ...bad } = validManifest;
    expect(() => validateManifest(bad)).toThrow(ManifestValidationError);
  });

  it('rejects resource with invalid configHash (not 64 hex chars)', () => {
    const bad: Manifest = {
      ...validManifest,
      resources: [{ ...validManifest.resources[0], configHash: 'not-a-hash' }],
    };
    expect(() => validateManifest(bad)).toThrow(ManifestValidationError);
  });

  it('rejects resource missing required fields', () => {
    const bad = {
      ...validManifest,
      resources: [{ provider: 'firebase', resourceType: 'app' }],
    };
    expect(() => validateManifest(bad)).toThrow(ManifestValidationError);
  });

  it('rejects unknown top-level fields', () => {
    expect(() => validateManifest({ ...validManifest, unknownField: 'value' })).toThrow(
      ManifestValidationError,
    );
  });
});

describe('saveManifest / loadManifest', () => {
  it('saves and loads a manifest correctly', () => {
    saveManifest(tmpDir, validManifest);
    const loaded = loadManifest(tmpDir);
    expect(loaded).toEqual(validManifest);
  });

  it('returns null when manifest does not exist', () => {
    expect(loadManifest(tmpDir)).toBeNull();
  });

  it('writes to a temp file first (atomic write)', () => {
    saveManifest(tmpDir, validManifest);
    const tmpFile = path.join(tmpDir, MANIFEST_FILENAME + '.tmp');
    expect(fs.existsSync(tmpFile)).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, MANIFEST_FILENAME))).toBe(true);
  });

  it('throws ManifestValidationError on invalid JSON in file', () => {
    fs.writeFileSync(path.join(tmpDir, MANIFEST_FILENAME), 'not json');
    expect(() => loadManifest(tmpDir)).toThrow(ManifestValidationError);
  });

  it('throws ManifestValidationError when loading invalid manifest', () => {
    fs.writeFileSync(
      path.join(tmpDir, MANIFEST_FILENAME),
      JSON.stringify({ projectId: '', generatedAt: 1, version: '1.0', resources: [] }),
    );
    expect(() => loadManifest(tmpDir)).toThrow(ManifestValidationError);
  });

  it('manifest file is JSON-parseable', () => {
    saveManifest(tmpDir, validManifest);
    const raw = fs.readFileSync(path.join(tmpDir, MANIFEST_FILENAME), 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('rejects saving invalid manifest', () => {
    const bad = { ...validManifest, projectId: '' };
    expect(() => saveManifest(tmpDir, bad)).toThrow(ManifestValidationError);
  });
});

describe('createEmptyManifest', () => {
  it('creates a valid empty manifest', () => {
    const m = createEmptyManifest('my-project');
    expect(m.projectId).toBe('my-project');
    expect(m.resources).toEqual([]);
    expect(m.version).toBe(MANIFEST_VERSION);
    expect(() => validateManifest(m)).not.toThrow();
  });
});

describe('mergeResources', () => {
  const baseHash = 'a'.repeat(64);
  const resource1 = {
    provider: 'firebase',
    resourceType: 'app',
    resourceId: 'app-1',
    configHash: baseHash,
    lastVerified: 1000,
  };
  const resource2 = {
    provider: 'github',
    resourceType: 'repository',
    resourceId: 'repo-1',
    configHash: 'b'.repeat(64),
    lastVerified: 1000,
  };

  it('includes all fresh resources', () => {
    const merged = mergeResources([], [resource1, resource2]);
    expect(merged).toHaveLength(2);
  });

  it('preserves old resources not in fresh set (deleted resources kept)', () => {
    const merged = mergeResources([resource1, resource2], [resource1]);
    // resource2 was removed from live, but preserved in merge
    expect(merged.some((r) => r.resourceId === 'repo-1')).toBe(true);
  });

  it('does not duplicate fresh resources', () => {
    const merged = mergeResources([resource1], [resource1]);
    const count = merged.filter((r) => r.resourceId === 'app-1').length;
    expect(count).toBe(1);
  });

  it('fresh resource replaces existing resource', () => {
    const updated = { ...resource1, configHash: 'c'.repeat(64), lastVerified: 2000 };
    const merged = mergeResources([resource1], [updated]);
    const found = merged.find((r) => r.resourceId === 'app-1');
    expect(found?.configHash).toBe('c'.repeat(64));
  });
});
