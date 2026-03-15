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
import { WebSocketServer, WebSocket } from 'ws';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'studio-test-'));
}

function getJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
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
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
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

// ---------------------------------------------------------------------------
// StudioServer lifecycle
// ---------------------------------------------------------------------------

describe('StudioServer', () => {
  let server: StudioServer;
  let port: number;

  beforeEach(async () => {
    const storeDir = makeTempDir();
    port = 30000 + Math.floor(Math.random() * 5000);
    server = new StudioServer({ port, host: '127.0.0.1', storeDir });
    await server.listen();
  });

  afterEach(async () => {
    await server.close();
  });

  it('starts and responds to health check', async () => {
    const data = await getJson(`http://127.0.0.1:${port}/api/health`) as Record<string, unknown>;
    expect(data.status).toBe('ok');
    expect(typeof data.timestamp).toBe('string');
    expect(typeof data.websocket_connections).toBe('number');
  });

  it('serves static index.html on root', async () => {
    const html = await new Promise<string>((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/`, (res) => {
        let body = '';
        res.on('data', (c: Buffer) => { body += c.toString(); });
        res.on('end', () => resolve(body));
      }).on('error', reject);
    });
    expect(html).toContain('Studio UI');
    expect(html).toContain('<!DOCTYPE html>');
  });

  it('returns empty provisioning list when no runs exist', async () => {
    const data = await getJson(`http://127.0.0.1:${port}/api/provisioning`) as Record<string, unknown>;
    expect(Array.isArray(data.runs)).toBe(true);
    expect((data.runs as unknown[]).length).toBe(0);
    expect(data.total).toBe(0);
  });

  it('returns 404 for unknown provisioning run', async () => {
    await new Promise<void>((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/api/provisioning/nonexistent-run`, (res) => {
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

  it('rejects invalid reconcile direction', async () => {
    await new Promise<void>((resolve, reject) => {
      const body = JSON.stringify({ direction: 'invalid-direction' });
      const req = http.request(`http://127.0.0.1:${port}/api/drift/reconcile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
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
  });

  afterEach(async () => {
    await server.close();
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
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
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
    // Create a failed run
    const log = new EventLog(storeDir);
    log.createOperation('op-failed-001', 'my-test-app');
    log.updateOperationStatus('op-failed-001', 'failure');
    log.close();

    // Restart server to pick up new run
    await server.close();
    server = new StudioServer({ port, host: '127.0.0.1', storeDir });
    await server.listen();

    const data = await postJson(
      `http://127.0.0.1:${port}/api/provisioning/op-failed-001/resume`,
      { choice: 'trust-log' },
    ) as Record<string, unknown>;
    expect(data.status).toBe('resuming');
    expect(data.choice).toBe('trust-log');
  });

  it('rejects resume with invalid choice', async () => {
    // Create a failed run first
    const log = new EventLog(storeDir);
    log.createOperation('op-failed-002', 'my-test-app');
    log.updateOperationStatus('op-failed-002', 'failure');
    log.close();

    await server.close();
    server = new StudioServer({ port, host: '127.0.0.1', storeDir });
    await server.listen();

    await new Promise<void>((resolve, reject) => {
      const body = JSON.stringify({ choice: 'invalid-choice' });
      const req = http.request(
        `http://127.0.0.1:${port}/api/provisioning/op-failed-002/resume`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
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
