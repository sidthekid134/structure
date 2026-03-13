import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingestion-test-'));

jest.mock('os', () => ({
  ...jest.requireActual('os'),
  homedir: () => tmpDir,
}));

import { CredentialIngestionService } from './ingestion';
import { NotFoundError } from './vault';

const PASSWORD = 'test-master-password';
const vaultFile = path.join(tmpDir, '.platform', 'credentials.enc');

function service(): CredentialIngestionService {
  return new CredentialIngestionService(PASSWORD);
}

afterEach(() => {
  if (fs.existsSync(vaultFile)) fs.unlinkSync(vaultFile);
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('CredentialIngestionService.addCredential', () => {
  it('rejects unknown provider', () => {
    const result = service().addCredential('unknown', { api_key: 'anything' });
    expect(result.success).toBe(false);
    expect(result.errors[0]).toMatch(/Unknown provider/);
  });

  it('rejects missing required field', () => {
    const result = service().addCredential('openai', {});
    expect(result.success).toBe(false);
    expect(result.errors[0]).toMatch(/Missing required field/);
  });

  it('rejects invalid OpenAI key format', () => {
    const result = service().addCredential('openai', { api_key: 'bad-key' });
    expect(result.success).toBe(false);
    expect(result.errors[0]).toMatch(/Invalid format/);
  });

  it('accepts valid OpenAI key', () => {
    const result = service().addCredential('openai', { api_key: 'sk-abcdefghijklmnopqrstu' });
    expect(result.success).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('accepts valid Anthropic key', () => {
    const result = service().addCredential('anthropic', { api_key: 'sk-ant-abcdefghijklmnopqrstu' });
    expect(result.success).toBe(true);
  });

  it('accepts valid GitHub token', () => {
    const result = service().addCredential('github', { token: 'ghp_abcdefghijklmnopqrstuvwxyz' });
    expect(result.success).toBe(true);
  });

  it('accepts valid Apple credentials', () => {
    const result = service().addCredential('apple', {
      key_id: 'ABCDE12345',
      team_id: 'FGHIJ67890',
      private_key: '-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----',
    });
    expect(result.success).toBe(true);
  });
});

describe('CredentialIngestionService.getCredential', () => {
  it('retrieves stored credential', () => {
    const svc = service();
    svc.addCredential('openai', { api_key: 'sk-retrievetest12345678901' });
    expect(svc.getCredential('openai', 'api_key')).toBe('sk-retrievetest12345678901');
  });

  it('throws NotFoundError for missing credential', () => {
    expect(() => service().getCredential('openai', 'api_key')).toThrow(NotFoundError);
  });
});

describe('CredentialIngestionService.updateCredential', () => {
  it('updates an existing credential', () => {
    const svc = service();
    svc.addCredential('openai', { api_key: 'sk-original1234567890123' });
    const result = svc.updateCredential('openai', 'api_key', 'sk-updated12345678901234');
    expect(result.success).toBe(true);
    expect(svc.getCredential('openai', 'api_key')).toBe('sk-updated12345678901234');
  });

  it('rejects invalid format on update', () => {
    const result = service().updateCredential('openai', 'api_key', 'bad-key');
    expect(result.success).toBe(false);
    expect(result.errors[0]).toMatch(/Invalid format/);
  });

  it('rejects unknown provider on update', () => {
    const result = service().updateCredential('unknown', 'api_key', 'sk-abc123');
    expect(result.success).toBe(false);
  });

  it('rejects unknown field on update', () => {
    const result = service().updateCredential('openai', 'nonexistent_field', 'value');
    expect(result.success).toBe(false);
    expect(result.errors[0]).toMatch(/Unknown field/);
  });
});

describe('CredentialIngestionService.deleteCredential', () => {
  it('deletes a stored credential', () => {
    const svc = service();
    svc.addCredential('openai', { api_key: 'sk-deletetest12345678901' });
    svc.deleteCredential('openai', 'api_key');
    expect(() => svc.getCredential('openai', 'api_key')).toThrow(NotFoundError);
  });

  it('throws NotFoundError when deleting non-existent credential', () => {
    expect(() => service().deleteCredential('openai', 'api_key')).toThrow(NotFoundError);
  });
});

describe('CredentialIngestionService.listProviders', () => {
  it('returns all six supported providers', () => {
    const providers = service().listProviders();
    const ids = providers.map((p) => p.id);
    expect(ids).toContain('openai');
    expect(ids).toContain('anthropic');
    expect(ids).toContain('vertex_ai');
    expect(ids).toContain('firebase');
    expect(ids).toContain('apple');
    expect(ids).toContain('github');
  });

  it('includes requiredFields for each provider', () => {
    const providers = service().listProviders();
    for (const p of providers) {
      expect(Array.isArray(p.requiredFields)).toBe(true);
      expect(p.requiredFields.length).toBeGreaterThan(0);
    }
  });
});

describe('CredentialIngestionService.listStoredKeys', () => {
  it('lists keys without exposing values', () => {
    const svc = service();
    svc.addCredential('anthropic', { api_key: 'sk-ant-secret12345678901234' });
    const keys = svc.listStoredKeys('anthropic');
    expect(keys).toContain('api_key');
    expect(keys).not.toContain('sk-ant-secret12345678901234');
  });

  it('returns empty array for provider with no stored credentials', () => {
    expect(service().listStoredKeys('github')).toEqual([]);
  });
});
