/**
 * Tests for Phase 3: Studio UI Web Dashboard
 *
 * Tests cover:
 *   - StudioServer startup and shutdown
 *   - REST API endpoints (health, provisioning, secrets, drift, architecture)
 *   - WsHandler connection management and broadcasting
 *   - EventLog listOperations() additions
 */

import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { StudioServer } from '../studio/server';
import { WsHandler } from '../studio/ws-handler';
import { EventLog } from '../orchestration/event-log';
import { VaultManager } from '../vault';
import { writeVaultMeta } from '../studio/vault-meta';
import { getVaultSession } from '../studio/vault-session';
import { GitHubConnectionService } from '../core/github-connection';
import { WebSocketServer, WebSocket } from 'ws';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'studio-test-'));
}

// Module-level token threaded through helpers below. Set in each `beforeEach`
// from `server.apiToken` so requests carry the bearer token added by the
// per-install auth middleware.
let __currentApiToken = '';
function setApiToken(token: string): void { __currentApiToken = token; }
function authHeaders(): Record<string, string> {
  return __currentApiToken ? { Authorization: `Bearer ${__currentApiToken}` } : {};
}

function getJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    http.get(url, { headers: authHeaders() }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function postJson(url: string, payload: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...authHeaders(),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function getJsonWithStatus(url: string): Promise<{ statusCode: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    http.get(url, { headers: authHeaders() }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', () => {
        try {
          resolve({
            statusCode: res.statusCode ?? 0,
            body: JSON.parse(body),
          });
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

function postJsonWithStatus(url: string, payload: unknown): Promise<{ statusCode: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          ...authHeaders(),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          try {
            resolve({
              statusCode: res.statusCode ?? 0,
              body: JSON.parse(data),
            });
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function deleteJsonWithStatus(url: string): Promise<{ statusCode: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      { method: 'DELETE', headers: authHeaders() },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          try {
            const parsed = data.trim().length > 0 ? JSON.parse(data) : null;
            resolve({
              statusCode: res.statusCode ?? 0,
              body: parsed,
            });
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// StudioServer lifecycle
// ---------------------------------------------------------------------------

describe('StudioServer', () => {
  let server: StudioServer;
  let port: number;
  let storeDir: string;
  /** Matches encrypted vault on disk for this suite. */
  let testVaultDek: Buffer;
  const originalExpoToken = process.env['EXPO_TOKEN'];

  beforeEach(async () => {
    delete process.env['EXPO_TOKEN'];
    storeDir = makeTempDir();
    port = 30000 + Math.floor(Math.random() * 5000);
    const vaultPath = path.join(storeDir, 'credentials.enc');
    testVaultDek = Buffer.alloc(32, 0xab);
    const vm = new VaultManager(vaultPath);
    vm.saveVaultFromMasterKey(testVaultDek, vm.loadVaultFromMasterKey(testVaultDek));
    writeVaultMeta(storeDir, { vaultKeyMode: 'dek-v1' });
    server = new StudioServer({ port, host: '127.0.0.1', storeDir });
    await server.listen();
    getVaultSession().setVaultDEK(testVaultDek);
    setApiToken(server.apiToken);
  });

  afterEach(async () => {
    await server.close();
    setApiToken('');
    if (originalExpoToken === undefined) {
      delete process.env['EXPO_TOKEN'];
    } else {
      process.env['EXPO_TOKEN'] = originalExpoToken;
    }
  });

  it('starts and responds to health check', async () => {
    const data = await getJson(`http://127.0.0.1:${port}/api/health`) as Record<string, unknown>;
    expect(data.status).toBe('ok');
    expect(typeof data.timestamp).toBe('string');
    expect(typeof data.websocket_connections).toBe('number');
    expect(data.serve_ui_from_source).toBe(false);
  });

  it('serves static index.html on root', async () => {
    const html = await new Promise<string>((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/`, { headers: authHeaders() }, (res) => {
        let body = '';
        res.on('data', (c: Buffer) => { body += c.toString(); });
        res.on('end', () => resolve(body));
      }).on('error', reject);
    });
    expect(html).toContain('<div id="root"></div>');
    expect(html.toLowerCase()).toContain('<!doctype html>');
  });

  it('returns empty provisioning list when no runs exist', async () => {
    const data = await getJson(`http://127.0.0.1:${port}/api/provisioning`) as Record<string, unknown>;
    expect(Array.isArray(data.runs)).toBe(true);
    expect((data.runs as unknown[]).length).toBe(0);
    expect(data.total).toBe(0);
  });

  it('returns 404 for unknown provisioning run', async () => {
    await new Promise<void>((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/api/provisioning/nonexistent-run`, { headers: authHeaders() }, (res) => {
        expect(res.statusCode).toBe(404);
        resolve();
      }).on('error', reject);
    });
  });

  it('returns architecture graph with nodes and edges', async () => {
    const data = await getJson(`http://127.0.0.1:${port}/api/architecture`) as Record<string, unknown>;
    expect(Array.isArray(data.nodes)).toBe(true);
    expect(Array.isArray(data.edges)).toBe(true);
    const nodes = data.nodes as Array<{ id: string }>;
    const nodeIds = nodes.map(n => n.id);
    expect(nodeIds).toContain('firebase');
    expect(nodeIds).toContain('github');
    expect(nodeIds).toContain('eas');
  });

  it('returns secret schema for all providers', async () => {
    const data = await getJson(`http://127.0.0.1:${port}/api/secrets`) as Record<string, unknown>;
    expect(Array.isArray(data.providers)).toBe(true);
    const providers = data.providers as Array<{ provider: string; secrets: unknown[] }>;
    const providerNames = providers.map(p => p.provider);
    expect(providerNames).toContain('firebase');
    expect(providerNames).toContain('github');
    const firebase = providers.find(p => p.provider === 'firebase')!;
    expect(firebase.secrets.length).toBeGreaterThan(0);
  });

  it('returns drift status', async () => {
    const data = await getJson(`http://127.0.0.1:${port}/api/drift`) as Record<string, unknown>;
    expect(typeof data.status).toBe('string');
    expect(typeof data.last_checked).toBe('string');
    expect(Array.isArray(data.recent_failures)).toBe(true);
  });

  it('rejects project-scoped providers at organization level', async () => {
    const response = await postJsonWithStatus(
      `http://127.0.0.1:${port}/api/organization/integrations`,
      { provider: 'firebase' },
    );
    expect(response.statusCode).toBe(400);
    const body = response.body as Record<string, unknown>;
    expect(String(body.error)).toContain('Unsupported organization module');
  });

  it('deletes a project record without infrastructure teardown', async () => {
    const created = await postJsonWithStatus(
      `http://127.0.0.1:${port}/api/projects`,
      {
        name: 'Delete Me',
        slug: 'delete-me',
        domain: 'delete-me.example.com',
        bundleId: 'com.example.deleteme',
        platforms: ['ios', 'android'],
      },
    );
    expect(created.statusCode).toBe(201);

    const deleted = await deleteJsonWithStatus(
      `http://127.0.0.1:${port}/api/projects/delete-me`,
    );
    expect(deleted.statusCode).toBe(204);
    expect(deleted.body).toBeNull();

    const lookup = await getJsonWithStatus(
      `http://127.0.0.1:${port}/api/projects/delete-me`,
    );
    expect(lookup.statusCode).toBe(404);
  });

  it('returns integration dependencies with standardized Firebase plan', async () => {
    const created = await postJsonWithStatus(
      `http://127.0.0.1:${port}/api/projects`,
      {
        name: 'Dependency Project',
        slug: 'dependency-project',
        domain: 'dependency-project.example.com',
        bundleId: 'com.example.dependency',
        platforms: ['ios', 'android'],
      },
    );
    expect(created.statusCode).toBe(201);

    const data = await getJson(
      `http://127.0.0.1:${port}/api/projects/dependency-project/integrations/dependencies`,
    ) as {
      project: { bundleId: string; domain: string };
      providers: Array<{
        provider: string;
        dependencies: Array<{ key: string; status: string; value: string | null }>;
        plannedResources: Array<{ key: string; standardized_name: string }>;
      }>;
    };

    expect(data.project.bundleId).toBe('com.example.dependency');
    expect(data.project.domain).toBe('dependency-project.example.com');
    const firebase = data.providers.find((provider) => provider.provider === 'firebase');
    expect(firebase).toBeDefined();
    const bundleDependency = firebase!.dependencies.find((dependency) => dependency.key === 'bundle_id');
    expect(bundleDependency?.status).toBe('ready');
    expect(bundleDependency?.value).toBe('com.example.dependency');
    const domainDep = firebase!.dependencies.find((dependency) => dependency.key === 'project_domain');
    expect(domainDep?.status).toBe('ready');
    expect(domainDep?.value).toBe('dependency-project.example.com');
    const serviceAccount = firebase!.plannedResources.find(
      (resource) => resource.key === 'provisioner_service_account',
    );
    expect(serviceAccount?.standardized_name).toContain('platform-provisioner@');
  });

  it('reports EAS integration unavailable when EXPO_TOKEN is missing', async () => {
    const data = await getJson(`http://127.0.0.1:${port}/api/integrations/eas/connection`) as Record<string, unknown>;
    expect(data.available).toBe(false);
    expect(data.connected).toBe(false);
    expect(data.requires_token).toBe(true);
  });

  it('reports GitHub integration unavailable when token is missing', async () => {
    const data = await getJson(`http://127.0.0.1:${port}/api/integrations/github/connection`) as Record<string, unknown>;
    expect(data.available).toBe(false);
    expect(data.connected).toBe(false);
    expect(data.requires_token).toBe(true);
  });

  it('stores EAS token and syncs org integration', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          meActor: {
            id: 'expo-user-id-123',
            accounts: [
              { id: 'account-1', name: 'sidmoparthi' },
              { id: 'account-2', name: 'bite-food-journal' },
            ],
          },
        },
      }),
    } as Response);

    try {
      const connection = await postJsonWithStatus(
        `http://127.0.0.1:${port}/api/organization/integrations/eas/connect`,
        { token: 'test-token' },
      );
      expect(connection.statusCode).toBe(200);
      const body = connection.body as Record<string, unknown>;
      expect(body.available).toBe(true);
      expect(body.connected).toBe(true);

      const organization = await getJson(`http://127.0.0.1:${port}/api/organization`) as {
        integrations: Record<string, { status: string; config: Record<string, string> }>;
      };
      expect(organization.integrations.eas).toBeDefined();
      expect(organization.integrations.eas.status).toBe('configured');
      expect(organization.integrations.eas.config.token_source).toBe('credential_vault');

      const vaultPath = path.join(storeDir, 'credentials.enc');
      const vault = new VaultManager(vaultPath);
      const passphrase = testVaultDek;
      expect(vault.getCredential(passphrase, 'eas', 'expo_token')).toBe('test-token');
      expect(vault.getCredential(passphrase, 'eas', 'expo_username')).toBe('sidmoparthi');
      expect(vault.getCredential(passphrase, 'eas', 'expo_user_id')).toBe('expo-user-id-123');
      expect(vault.getCredential(passphrase, 'eas', 'expo_accounts')).toBe(
        JSON.stringify(['sidmoparthi', 'bite-food-journal']),
      );

      const vaultRaw = fs.readFileSync(vaultPath, 'utf8');
      expect(vaultRaw).not.toContain('test-token');
      expect(vaultRaw).not.toContain('sidmoparthi');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('disables EAS connection and clears connection metadata', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          meActor: {
            id: 'expo-user-id-123',
            accounts: [{ id: 'account-1', name: 'sidmoparthi' }],
          },
        },
      }),
    } as Response);

    try {
      await postJsonWithStatus(
        `http://127.0.0.1:${port}/api/organization/integrations/eas/connect`,
        { token: 'test-token' },
      );
      const disabled = await deleteJsonWithStatus(
        `http://127.0.0.1:${port}/api/organization/integrations/eas/connection`,
      );
      expect(disabled.statusCode).toBe(200);
      const body = disabled.body as Record<string, unknown>;
      expect(body.connected).toBe(false);
      expect(body.requires_token).toBe(true);

      const organization = await getJson(`http://127.0.0.1:${port}/api/organization`) as {
        integrations: Record<string, { status: string; config: Record<string, string> }>;
      };
      expect(organization.integrations.eas.status).toBe('pending');
      expect(organization.integrations.eas.config.expo_username).toBeUndefined();

      const vaultPath = path.join(storeDir, 'credentials.enc');
      const vault = new VaultManager(vaultPath);
      const passphrase = testVaultDek;
      expect(vault.getCredential(passphrase, 'eas', 'expo_token')).toBeUndefined();
      expect(vault.getCredential(passphrase, 'eas', 'expo_username')).toBeUndefined();
      expect(vault.getCredential(passphrase, 'eas', 'expo_user_id')).toBeUndefined();
      expect(vault.getCredential(passphrase, 'eas', 'expo_accounts')).toBeUndefined();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('stores GitHub token and syncs org integration', async () => {
    const spy = jest
      .spyOn(GitHubConnectionService.prototype, 'fetchGitHubConnectionDetails')
      .mockResolvedValue({
        userId: '12345',
        username: 'sidmoparthi',
        orgNames: ['acme-mobile', 'example-inc'],
        scopes: ['repo', 'workflow'],
      });

    try {
      const connection = await postJsonWithStatus(
        `http://127.0.0.1:${port}/api/organization/integrations/github/connect`,
        { token: 'ghp_test_token_123' },
      );
      expect(connection.statusCode).toBe(200);
      const body = connection.body as Record<string, unknown>;
      expect(body.available).toBe(true);
      expect(body.connected).toBe(true);

      const organization = await getJson(`http://127.0.0.1:${port}/api/organization`) as {
        integrations: Record<string, { status: string; config: Record<string, string> }>;
      };
      expect(organization.integrations.github).toBeDefined();
      expect(organization.integrations.github.status).toBe('configured');
      expect(organization.integrations.github.config.token_source).toBe('credential_vault');
      expect(organization.integrations.github.config.username).toBe('sidmoparthi');

      const vaultPath = path.join(storeDir, 'credentials.enc');
      const vault = new VaultManager(vaultPath);
      const passphrase = testVaultDek;
      expect(vault.getCredential(passphrase, 'github', 'token')).toBe('ghp_test_token_123');
      expect(vault.getCredential(passphrase, 'github', 'username')).toBe('sidmoparthi');
      expect(vault.getCredential(passphrase, 'github', 'user_id')).toBe('12345');
      expect(vault.getCredential(passphrase, 'github', 'orgs')).toBe(
        JSON.stringify(['acme-mobile', 'example-inc']),
      );

      const vaultRaw = fs.readFileSync(vaultPath, 'utf8');
      expect(vaultRaw).not.toContain('ghp_test_token_123');
      expect(vaultRaw).not.toContain('sidmoparthi');
    } finally {
      spy.mockRestore();
    }
  });

  it('disables GitHub connection and clears connection metadata', async () => {
    const spy = jest
      .spyOn(GitHubConnectionService.prototype, 'fetchGitHubConnectionDetails')
      .mockResolvedValue({
        userId: '12345',
        username: 'sidmoparthi',
        orgNames: ['acme-mobile'],
        scopes: ['repo', 'workflow'],
      });

    try {
      await postJsonWithStatus(
        `http://127.0.0.1:${port}/api/organization/integrations/github/connect`,
        { token: 'ghp_test_token_123' },
      );
      const disabled = await deleteJsonWithStatus(
        `http://127.0.0.1:${port}/api/organization/integrations/github/connection`,
      );
      expect(disabled.statusCode).toBe(200);
      const body = disabled.body as Record<string, unknown>;
      expect(body.connected).toBe(false);
      expect(body.requires_token).toBe(true);

      const organization = await getJson(`http://127.0.0.1:${port}/api/organization`) as {
        integrations: Record<string, { status: string; config: Record<string, string> }>;
      };
      expect(organization.integrations.github.status).toBe('pending');
      expect(organization.integrations.github.config.username).toBeUndefined();

      const vaultPath = path.join(storeDir, 'credentials.enc');
      const vault = new VaultManager(vaultPath);
      const passphrase = testVaultDek;
      expect(vault.getCredential(passphrase, 'github', 'token')).toBeUndefined();
      expect(vault.getCredential(passphrase, 'github', 'username')).toBeUndefined();
      expect(vault.getCredential(passphrase, 'github', 'user_id')).toBeUndefined();
      expect(vault.getCredential(passphrase, 'github', 'orgs')).toBeUndefined();
      expect(vault.getCredential(passphrase, 'github', 'scopes')).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects invalid reconcile direction', async () => {
    await new Promise<void>((resolve, reject) => {
      const body = JSON.stringify({ direction: 'invalid-direction' });
      const req = http.request(`http://127.0.0.1:${port}/api/drift/reconcile`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          ...authHeaders(),
        },
      }, (res) => {
        expect(res.statusCode).toBe(400);
        resolve();
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  });

  it('accepts valid reconcile direction manifest-to-live', async () => {
    const data = await postJson(`http://127.0.0.1:${port}/api/drift/reconcile`, {
      direction: 'manifest-to-live',
    }) as Record<string, unknown>;
    expect(data.status).toBe('reconciling');
    expect(typeof data.runId).toBe('string');
  });

  it('accepts valid reconcile direction live-to-manifest', async () => {
    const data = await postJson(`http://127.0.0.1:${port}/api/drift/reconcile`, {
      direction: 'live-to-manifest',
    }) as Record<string, unknown>;
    expect(data.status).toBe('reconciling');
  });
});

// ---------------------------------------------------------------------------
// Provisioning run with EventLog seeding
// ---------------------------------------------------------------------------

describe('StudioServer with seeded EventLog', () => {
  let server: StudioServer;
  let port: number;
  let storeDir: string;

  beforeEach(async () => {
    storeDir = makeTempDir();
    // Seed the event log before creating the server
    const log = new EventLog(storeDir);
    log.createOperation('op-test-app-001', 'my-test-app');
    log.updateOperationStatus('op-test-app-001', 'success');
    log.append('op-test-app-001', 'firebase', 'provision', 'success');
    log.append('op-test-app-001', 'github', 'provision', 'success');
    log.close();

    port = 30000 + Math.floor(Math.random() * 5000);
    server = new StudioServer({ port, host: '127.0.0.1', storeDir });
    await server.listen();
    setApiToken(server.apiToken);
  });

  afterEach(async () => {
    await server.close();
    setApiToken('');
  });

  it('lists seeded provisioning run', async () => {
    const data = await getJson(`http://127.0.0.1:${port}/api/provisioning`) as Record<string, unknown>;
    const runs = data.runs as Array<{ id: string; app_id: string; status: string }>;
    expect(runs.length).toBe(1);
    expect(runs[0].id).toBe('op-test-app-001');
    expect(runs[0].app_id).toBe('my-test-app');
    expect(runs[0].status).toBe('success');
  });

  it('returns run detail with events', async () => {
    const data = await getJson(`http://127.0.0.1:${port}/api/provisioning/op-test-app-001`) as Record<string, unknown>;
    expect(data.id).toBe('op-test-app-001');
    expect(data.app_id).toBe('my-test-app');
    expect(Array.isArray(data.events)).toBe(true);
    const events = data.events as Array<{ provider: string; step: string; status: string }>;
    expect(events.length).toBe(2);
    expect(events[0].provider).toBe('firebase');
    expect(events[1].provider).toBe('github');
  });

  it('rejects resume of a successful run', async () => {
    await new Promise<void>((resolve, reject) => {
      const body = JSON.stringify({ choice: 'trust-log' });
      const req = http.request(
        `http://127.0.0.1:${port}/api/provisioning/op-test-app-001/resume`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            ...authHeaders(),
          },
        },
        (res) => {
          expect(res.statusCode).toBe(409);
          resolve();
        },
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  });

  it('allows resume of a failed run', async () => {
    const log = new EventLog(storeDir);
    log.createOperation('op-failed-001', 'my-test-app');
    log.updateOperationStatus('op-failed-001', 'failure');
    log.close();

    await server.close();
    server = new StudioServer({ port, host: '127.0.0.1', storeDir });
    await server.listen();
    setApiToken(server.apiToken);

    const data = await postJson(
      `http://127.0.0.1:${port}/api/provisioning/op-failed-001/resume`,
      { choice: 'trust-log' },
    ) as Record<string, unknown>;
    expect(data.status).toBe('resuming');
    expect(data.choice).toBe('trust-log');
  });

  it('rejects resume with invalid choice', async () => {
    const log = new EventLog(storeDir);
    log.createOperation('op-failed-002', 'my-test-app');
    log.updateOperationStatus('op-failed-002', 'failure');
    log.close();

    await server.close();
    server = new StudioServer({ port, host: '127.0.0.1', storeDir });
    await server.listen();
    setApiToken(server.apiToken);

    await new Promise<void>((resolve, reject) => {
      const body = JSON.stringify({ choice: 'invalid-choice' });
      const req = http.request(
        `http://127.0.0.1:${port}/api/provisioning/op-failed-002/resume`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            ...authHeaders(),
          },
        },
        (res) => {
          expect(res.statusCode).toBe(400);
          resolve();
        },
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  });
});

describe('StudioServer serve UI from source', () => {
  let server: StudioServer;
  let port: number;

  beforeEach(async () => {
    const storeDir = makeTempDir();
    port = 33000 + Math.floor(Math.random() * 5000);
    server = new StudioServer({ port, host: '127.0.0.1', storeDir, serveUiFromSource: true });
    await server.listen();
    setApiToken(server.apiToken);
  });

  afterEach(async () => {
    await server.close();
    setApiToken('');
  });

  it('reports serve_ui_from_source enabled in health response', async () => {
    const data = await getJson(`http://127.0.0.1:${port}/api/health`) as Record<string, unknown>;
    expect(data.serve_ui_from_source).toBe(true);
  });

  it('exposes live reload event stream endpoint', async () => {
    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        `http://127.0.0.1:${port}/__studio_live_reload`,
        { method: 'GET' },
        (res) => {
          expect(res.statusCode).toBe(200);
          expect(String(res.headers['content-type'])).toContain('text/event-stream');
          req.destroy();
          resolve();
        },
      );
      req.on('error', reject);
      req.end();
    });
  });
});

// ---------------------------------------------------------------------------
// WsHandler
// ---------------------------------------------------------------------------

describe('WsHandler', () => {
  let wss: WebSocketServer;
  let wsHandler: WsHandler;
  let port: number;

  beforeEach(() => {
    port = 31000 + Math.floor(Math.random() * 5000);
    wss = new WebSocketServer({ port, host: '127.0.0.1' });
    wsHandler = new WsHandler(wss);
  });

  afterEach(() => {
    wsHandler.closeAll();
    wss.close();
  });

  it('starts with zero connections', () => {
    expect(wsHandler.connectionCount).toBe(0);
    expect(wsHandler.subscribedRunIds).toEqual([]);
  });

  it('registers connection on handleConnection()', (done) => {
    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    wss.on('connection', (ws) => {
      wsHandler.handleConnection(ws, 'test-run-1');
      expect(wsHandler.connectionCount).toBe(1);
      expect(wsHandler.subscribedRunIds).toContain('test-run-1');
      // Wait for client to be open before closing
      client.on('open', () => { client.close(); done(); });
      // If already open
      if (client.readyState === WebSocket.OPEN) { client.close(); done(); }
    });
  });

  it('sends connected message on join', (done) => {
    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    client.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      expect(msg.type).toBe('connected');
      expect(msg.runId).toBe('test-run-x');
      client.close();
      done();
    });
    wss.on('connection', (ws) => {
      wsHandler.handleConnection(ws, 'test-run-x');
    });
  });

  it('broadcasts progress message to subscribed client', (done) => {
    const runId = 'broadcast-run';
    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    let msgCount = 0;

    client.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      msgCount++;
      if (msg.type === 'progress') {
        expect(msg.data.provider).toBe('firebase');
        expect(msg.data.status).toBe('success');
        client.close();
        done();
      }
    });

    client.on('open', () => {
      // Wait for wss connection event to register handler
    });

    wss.on('connection', (ws) => {
      wsHandler.handleConnection(ws, runId);
      // Send broadcast after a brief delay
      setTimeout(() => {
        wsHandler.broadcastProgress(runId, 'firebase', 'provision', 'success');
      }, 50);
    });
  });

  it('does not broadcast to non-subscribed runId', (done) => {
    const runId = 'run-a';
    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    let extraMessages = 0;

    client.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type !== 'connected') extraMessages++;
    });

    wss.on('connection', (ws) => {
      wsHandler.handleConnection(ws, runId);
      // Broadcast to a DIFFERENT runId
      setTimeout(() => {
        wsHandler.broadcastProgress('different-run', 'github', 'provision', 'success');
        // Check after 100ms that no extra messages arrived
        setTimeout(() => {
          expect(extraMessages).toBe(0);
          client.close();
          done();
        }, 100);
      }, 50);
    });
  });

  it('removes client on disconnect', (done) => {
    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    wss.on('connection', (ws) => {
      wsHandler.handleConnection(ws, 'run-close-test');
      expect(wsHandler.connectionCount).toBe(1);
      // Wait for client to be open before closing to avoid pre-open close error
      const doClose = () => {
        client.close();
        setTimeout(() => {
          expect(wsHandler.connectionCount).toBe(0);
          done();
        }, 100);
      };
      if (client.readyState === WebSocket.OPEN) {
        doClose();
      } else {
        client.on('open', doClose);
      }
    });
  });

  it('broadcasts status update message', (done) => {
    const runId = 'status-run';
    const client = new WebSocket(`ws://127.0.0.1:${port}`);

    client.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'status_update') {
        expect(msg.data.status).toBe('complete');
        client.close();
        done();
      }
    });

    wss.on('connection', (ws) => {
      wsHandler.handleConnection(ws, runId);
      setTimeout(() => {
        wsHandler.broadcastStatusUpdate(runId, 'complete', 'Done');
      }, 50);
    });
  });
});

// ---------------------------------------------------------------------------
// EventLog.listOperations additions
// ---------------------------------------------------------------------------

describe('EventLog.listOperations', () => {
  let storeDir: string;
  let log: EventLog;

  beforeEach(() => {
    storeDir = makeTempDir();
    log = new EventLog(storeDir);
  });

  afterEach(() => {
    log.close();
  });

  it('returns empty array when no operations', () => {
    expect(log.listOperations()).toEqual([]);
  });

  it('returns operations in descending order by created_at', () => {
    // Insert operations with distinct timestamps using fake clock offsets
    const db = (log as unknown as { db: { prepare: (s: string) => { run: (...args: unknown[]) => void } } }).db;
    const base = Date.now();
    db.prepare('INSERT INTO operations (id, app_id, status, created_at, updated_at) VALUES (?,?,?,?,?)').run('op-1', 'app-a', 'running', base,     base);
    db.prepare('INSERT INTO operations (id, app_id, status, created_at, updated_at) VALUES (?,?,?,?,?)').run('op-2', 'app-b', 'running', base + 1, base + 1);
    db.prepare('INSERT INTO operations (id, app_id, status, created_at, updated_at) VALUES (?,?,?,?,?)').run('op-3', 'app-c', 'running', base + 2, base + 2);

    const ops = log.listOperations();
    expect(ops.length).toBe(3);
    // Most recent first
    expect(ops[0].id).toBe('op-3');
    expect(ops[1].id).toBe('op-2');
    expect(ops[2].id).toBe('op-1');
  });

  it('respects limit parameter', () => {
    for (let i = 0; i < 10; i++) {
      log.createOperation(`op-${i}`, 'app');
    }
    const ops = log.listOperations(3);
    expect(ops.length).toBe(3);
  });

  it('listOperationsByAppId filters by app_id', () => {
    log.createOperation('op-app1-1', 'app1');
    log.createOperation('op-app2-1', 'app2');
    log.createOperation('op-app1-2', 'app1');

    const app1Ops = log.listOperationsByAppId('app1');
    expect(app1Ops.length).toBe(2);
    expect(app1Ops.every(o => o.app_id === 'app1')).toBe(true);

    const app2Ops = log.listOperationsByAppId('app2');
    expect(app2Ops.length).toBe(1);
    expect(app2Ops[0].id).toBe('op-app2-1');
  });

  it('listOperationsByAppId returns empty for unknown app', () => {
    log.createOperation('op-1', 'app1');
    expect(log.listOperationsByAppId('nonexistent')).toEqual([]);
  });
});
