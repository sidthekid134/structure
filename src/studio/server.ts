/**
 * Studio UI Server — local web interface for project management and monitoring.
 *
 * Starts an Express HTTP server on localhost (default 3737) serving:
 *   - Static dashboard UI (HTML/CSS/JS)
 *   - REST API endpoints under /api/
 *   - WebSocket endpoint at /ws/provisioning/:runId
 *
 * Usage:
 *   const server = new StudioServer({ port: 3737, storeDir: '…' });
 *   await server.listen();
 */

import 'dotenv/config';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import express from 'express';
import cookieParser from 'cookie-parser';
import { WebSocketServer } from 'ws';
import { EventLog } from '../orchestration/event-log.js';
import { createApiRouter } from './api.js';
import { WsHandler } from './ws-handler.js';
import { registerBuiltinPlugins } from '../plugins/builtin/index.js';
import { createAuthMiddlewares, validateWsEphemeralToken, logoutHandler } from './auth.js';
import { createWebAuthnRouter } from './auth-webauthn-router.js';
import { createLifecycleRouter } from './lifecycle-router.js';
import { VaultManager } from '../vault.js';
import { getVaultSession, VaultSealedError } from './vault-session.js';
import { resolveStudioStoreDir } from './store-dir.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface StudioServerOptions {
  /**
   * Port to listen on. Defaults to 3737. Pass `0` to let the OS pick a free
   * ephemeral port.
   */
  port?: number;
  /** Host to bind to. Defaults to 127.0.0.1 (localhost only). */
  host?: string;
  /** Directory for SQLite event log and secret stores. Defaults to ~/.platform */
  storeDir?: string;
  /** Serve dashboard assets from `src/studio/static` and enable live reload (local DX only). */
  serveUiFromSource?: boolean;
  /**
   * If set, writes a single-line `<port>` file to this absolute path once the
   * server is listening, then deletes it on shutdown. Wrapper scripts use
   * this when binding to port 0 to discover the OS-assigned ephemeral port.
   */
  portFile?: string;
}

/** Safe request logging: field names + value shapes only (no raw secrets). */
function describeJsonBodyShape(body: unknown, depth = 0): string {
  if (body === null || body === undefined) return String(body);
  if (depth > 4) return '…';
  if (typeof body === 'string') return `string(${body.length} chars)`;
  if (typeof body === 'number' || typeof body === 'boolean') return String(body);
  if (Array.isArray(body)) {
    if (body.length === 0) return '[]';
    const first = describeJsonBodyShape(body[0], depth + 1);
    return body.length === 1 ? `[${first}]` : `[${first}, … ×${body.length}]`;
  }
  if (typeof body === 'object') {
    const o = body as Record<string, unknown>;
    const parts = Object.keys(o).map((k) => `${k}=${describeJsonBodyShape(o[k], depth + 1)}`);
    return `{${parts.join(', ')}}`;
  }
  return typeof body;
}

// ---------------------------------------------------------------------------
// StudioServer
// ---------------------------------------------------------------------------

export class StudioServer {
  private readonly app: express.Application;
  private readonly httpServer: http.Server;
  private readonly wss: WebSocketServer;
  private readonly eventLog: EventLog;
  private readonly serveUiFromSource: boolean;
  private readonly staticDir: string;
  private readonly liveReloadClients = new Set<http.ServerResponse>();
  private staticWatcher?: fs.FSWatcher;
  private readonly auth: ReturnType<typeof createAuthMiddlewares>;
  private readonly vaultManager: VaultManager;
  readonly wsHandler: WsHandler;

  constructor(private readonly options: StudioServerOptions = {}) {
    const storeDir =
      options.storeDir ??
      resolveStudioStoreDir(process.env);

    // Lock down newly-created files: vault, token, event log, secret stores
    // all become 0600 / 0700 by default. Defense-in-depth against another
    // OS user reading credentials on a shared machine.
    process.umask(0o077);
    fs.mkdirSync(storeDir, { recursive: true, mode: 0o700 });
    enforceDirMode(storeDir, 0o700);

    this.eventLog = new EventLog(storeDir);
    this.serveUiFromSource =
      options.serveUiFromSource ?? process.env['STUDIO_SERVE_UI_FROM_SOURCE'] === '1';
    this.staticDir = this.resolveStaticDir();
    this.app = express();
    this.httpServer = http.createServer(this.app);
    this.wss = new WebSocketServer({ noServer: true });
    this.wsHandler = new WsHandler(this.wss);

    // Per-install bearer token + origin guard. Token is generated on first
    // run and persisted at <storeDir>/api-token (mode 0600).
    this.auth = createAuthMiddlewares({ storeDir });

    // Vault session — sealed until passkey WebAuthn unlock sets the DEK.
    this.vaultManager = new VaultManager(
      path.join(storeDir, 'credentials.enc'),
      () => { /* vault logs suppressed */ },
    );

    this.setupMiddleware();
    this.setupRoutes(storeDir);
    this.setupWebSocket();
    // Recursive `fs.watch` holds many FDs on large trees (can hit EMFILE under Jest/sandbox).
    // HTTP tests only need the SSE route when enabled; file-triggered reload is unnecessary there.
    if (this.serveUiFromSource && process.env['NODE_ENV'] !== 'test') {
      this.setupLiveReloadWatcher();
    }
  }

  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------

  private setupMiddleware(): void {
    this.app.use(cookieParser());
    this.app.use(express.json({ limit: '25mb' }));
    this.app.use(express.urlencoded({ extended: false }));

    // Security headers
    this.app.use((_req, res, next) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Referrer-Policy', 'no-referrer');
      next();
    });

    // Request logging for backend API visibility in terminal.
    this.app.use((req, res, next) => {
      const start = Date.now();
      res.on('finish', () => {
        if (!req.originalUrl.startsWith('/api')) {
          return;
        }
        if (req.originalUrl === '/api/health' || req.originalUrl.startsWith('/api/health?')) {
          return;
        }
        const durationMs = Date.now() - start;
        const message = `[studio-api] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${durationMs}ms)`;
        if (res.statusCode >= 500) {
          console.error(message);
        } else if (res.statusCode >= 400) {
          console.warn(message);
        } else {
          console.log(message);
        }
        // Second line: JSON body shape only (never log raw secrets / token values).
        if (req.method !== 'GET' && req.method !== 'HEAD' && req.body && typeof req.body === 'object') {
          const keys = Object.keys(req.body as object);
          if (keys.length > 0) {
            const detail = describeJsonBodyShape(req.body);
            const line = `[studio-api]   req body: ${detail}`;
            if (res.statusCode >= 500) {
              console.error(line);
            } else if (res.statusCode >= 400) {
              console.warn(line);
            } else {
              console.log(line);
            }
          }
        }
      });
      next();
    });
  }

  private setupRoutes(storeDir: string): void {
    this.app.use(express.static(this.staticDir, { index: false }));

    // Bootstrap plugins before the API router starts handling requests
    registerBuiltinPlugins();

    // ── Auth chain ────────────────────────────────────────────────────────
    // Order matters: originGuard rejects cross-origin requests early, then
    // sessionGuard enforces cookie session or legacy bearer token.
    this.app.use('/api', this.auth.originGuard);
    this.app.use('/api', createWebAuthnRouter(storeDir, this.vaultManager));
    this.app.get('/api/auth/session', this.auth.sessionHandler);
    this.app.post('/api/auth/handoff', this.auth.handoffHandler);
    this.app.get('/api/auth/create-handoff', this.auth.createHandoffHandler);
    this.app.post('/api/auth/dev-session', this.auth.devSessionHandler);
    this.app.get('/api/auth/ws-token', this.auth.wsTokenHandler);
    this.app.use('/api', this.auth.sessionGuard);
    this.app.post('/api/auth/logout', logoutHandler());

    // ── Lifecycle (version, vault seal/unseal) ────────────────────────────
    this.app.use(
      '/api',
      createLifecycleRouter({
        vaultManager: this.vaultManager,
        vaultPath: path.join(storeDir, 'credentials.enc'),
        storeDir,
      }),
    );

    // ── Main feature API ──────────────────────────────────────────────────
    this.app.use('/api', createApiRouter(this.eventLog, this.wsHandler, storeDir, this.serveUiFromSource));

    this.app.use((err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (err instanceof VaultSealedError) {
        res.status(423).json({ code: 'VAULT_SEALED', error: err.message });
        return;
      }
      next(err);
    });

    this.app.get('/__studio_live_reload', (_req, res) => {
      if (!this.serveUiFromSource) {
        res.status(404).end();
        return;
      }
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();
      res.write('event: ready\ndata: {"ok":true}\n\n');
      this.liveReloadClients.add(res);
      res.on('close', () => {
        this.liveReloadClients.delete(res);
      });
    });

    this.app.get('/', (_req, res) => {
      res.sendFile(path.join(this.staticDir, 'index.html'));
    });

    // SPA fallback — serve index.html for any unmatched route
    this.app.get('*', (_req, res) => {
      res.sendFile(path.join(this.staticDir, 'index.html'));
    });
  }

  private setupWebSocket(): void {
    this.httpServer.on('upgrade', (request, socket, head) => {
      const url = request.url ?? '';
      const match = url.match(/^\/ws\/provisioning\/([^/?#]+)/);

      if (!match) {
        socket.destroy();
        return;
      }

      // Bearer token check — browsers can't set custom headers on the
      // WebSocket constructor, so we accept the token via `?token=` or via
      // the `Sec-WebSocket-Protocol` subprotocol header (more secure: not
      // logged in URL access logs). The bundled UI uses `?token=`.
      const presented = this.extractWsToken(request);
      let wsAuthorized = false;
      if (presented) {
        wsAuthorized =
          validateWsEphemeralToken(presented) || this.constantTimeEquals(presented, this.auth.token);
      }
      if (!wsAuthorized) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      const runId = match[1];
      this.wss.handleUpgrade(request, socket, head, (ws) => {
        this.wsHandler.handleConnection(ws, runId);
      });
    });
  }

  private extractWsToken(request: http.IncomingMessage): string | null {
    const url = request.url ?? '';
    const qIndex = url.indexOf('?');
    if (qIndex >= 0) {
      const params = new URLSearchParams(url.slice(qIndex + 1));
      const t = params.get('token');
      if (t) return t;
    }
    const subprotocol = request.headers['sec-websocket-protocol'];
    if (typeof subprotocol === 'string') {
      // Format: "vault.bearer, <token>" — convention used by the UI.
      const parts = subprotocol.split(',').map((p) => p.trim());
      if (parts[0] === 'vault.bearer' && parts[1]) return parts[1];
    }
    return null;
  }

  private constantTimeEquals(a: string, b: string): boolean {
    const ab = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    if (ab.length !== bb.length) return false;
    // crypto.timingSafeEqual would also work — local impl avoids extra import.
    let diff = 0;
    for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
    return diff === 0;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  listen(): Promise<void> {
    const port = this.options.port ?? 3737;
    const host = this.options.host ?? '127.0.0.1';

    // Reject any non-loopback bind unless explicitly whitelisted by env.
    // This is defense-in-depth: the daemon stores plaintext credentials in
    // memory and must never be reachable from another machine.
    if (!isLoopbackAddress(host) && process.env['STUDIO_ALLOW_PUBLIC_BIND'] !== '1') {
      throw new Error(
        `Refusing to bind to non-loopback address "${host}". ` +
        `Set STUDIO_ALLOW_PUBLIC_BIND=1 only if you understand the risks.`,
      );
    }

    return new Promise((resolve, reject) => {
      this.httpServer.once('error', reject);
      this.httpServer.listen(port, host, () => {
        const addr = this.httpServer.address();
        const boundPort =
          typeof addr === 'object' && addr !== null ? addr.port : port;

        // Write the port file *before* logging the ready signal so any
        // wrapper script can race-free read the port and launch the UI.
        if (this.options.portFile) {
          try {
            fs.mkdirSync(path.dirname(this.options.portFile), {
              recursive: true,
              mode: 0o700,
            });
            fs.writeFileSync(this.options.portFile, String(boundPort) + '\n', {
              mode: 0o600,
            });
          } catch (err) {
            console.error(
              `Failed to write port file ${this.options.portFile}:`,
              (err as Error).message,
            );
          }
        }

        if (process.env['NODE_ENV'] !== 'test') {
          const browseHost =
            host === '127.0.0.1' || host === '::1' || host === '[::1]' ? 'localhost' : host;
          console.log(`Studio UI running at http://${browseHost}:${boundPort}`);
          console.log(`Vault session: ${getVaultSession().isSealed() ? 'sealed' : 'unsealed'}`);
          if (this.serveUiFromSource) {
            const tokenPath = path.join(this.options.storeDir ?? '~/.platform', 'api-token');
            console.log(`API token: ${this.auth.token.slice(0, 8)}… (full token at ${tokenPath})`);
          }
          // Sentinel line wrappers may parse to detect readiness (port bound).
          console.log(`STUDIO_READY ${boundPort}`);
        }
        resolve();
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.staticWatcher?.close();
      this.staticWatcher = undefined;
      for (const client of this.liveReloadClients) {
        client.end();
      }
      this.liveReloadClients.clear();
      this.wsHandler.closeAll();
      this.eventLog.close();
      if (this.options.portFile) {
        try { fs.unlinkSync(this.options.portFile); } catch { /* ignore */ }
      }
      this.httpServer.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  get server(): http.Server {
    return this.httpServer;
  }

  /**
   * The per-install API bearer token. Test code and integration callers can
   * read this to construct authenticated requests; production callers should
   * fetch it from `<storeDir>/api-token` instead.
   */
  get apiToken(): string {
    return this.auth.token;
  }

  private resolveStaticDir(): string {
    const bundledDir = path.join(__dirname, 'static');
    const bundledIndex = path.join(bundledDir, 'index.html');

    if (!this.serveUiFromSource) {
      return bundledDir;
    }

    const sourceStaticDir = path.join(process.cwd(), 'src', 'studio', 'static');
    const sourceIndex = path.join(sourceStaticDir, 'index.html');

    // Tests: no long wait; repo checkout should already contain built UI under src/studio/static.
    if (process.env['NODE_ENV'] === 'test') {
      if (!fs.existsSync(sourceStaticDir)) {
        throw new Error(`STUDIO_SERVE_UI_FROM_SOURCE requires ${sourceStaticDir}`);
      }
      return sourceStaticDir;
    }

    // dev:full starts the backend before Vite writes index.html — wait, then fall back to bundled.
    if (!fs.existsSync(sourceIndex)) {
      waitSyncForFile(
        sourceIndex,
        120_000,
        1_500,
        '[studio] Waiting for src/studio/static/index.html (studio-ui build)…',
      );
    }

    if (fs.existsSync(sourceIndex)) {
      return sourceStaticDir;
    }

    if (fs.existsSync(bundledIndex)) {
      console.warn(
        '[studio] Timed out waiting for source UI — serving bundled static; restart the backend after ui:watch emits files to use src/studio/static.',
      );
      return bundledDir;
    }

    throw new Error(
      `Dashboard UI not found. Expected ${sourceIndex} (run npm run ui:build or ui:watch) or bundled ${bundledIndex}.`,
    );
  }

  private setupLiveReloadWatcher(): void {
    this.staticWatcher = fs.watch(this.staticDir, { recursive: true }, (_eventType, filename) => {
      if (!filename) {
        return;
      }
      const changedFile = filename.toString();
      if (!changedFile.endsWith('.html') && !changedFile.endsWith('.css') && !changedFile.endsWith('.js')) {
        return;
      }
      this.broadcastLiveReload(changedFile);
    });
  }

  private broadcastLiveReload(changedPath: string): void {
    const data = JSON.stringify({ path: changedPath, timestamp: Date.now() });
    for (const client of this.liveReloadClients) {
      client.write(`event: reload\ndata: ${data}\n\n`);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function enforceDirMode(dir: string, mode: number): void {
  try {
    fs.chmodSync(dir, mode);
  } catch {
    // Filesystem may not support chmod (e.g. FAT32, some Windows volumes).
  }
}

/**
 * Blocks the startup thread until `filePath` exists or `timeoutMs` elapses.
 * Used so `npm run dev:full` does not serve `/` before Vite writes `index.html`.
 */
function waitSyncForFile(filePath: string, timeoutMs: number, logAfterMs: number, message: string): void {
  const sab = new SharedArrayBuffer(4);
  const ia = new Int32Array(sab);
  const start = Date.now();
  let logged = false;
  while (!fs.existsSync(filePath)) {
    if (Date.now() - start > timeoutMs) {
      return;
    }
    if (!logged && Date.now() - start > logAfterMs) {
      console.log(message);
      logged = true;
    }
    Atomics.wait(ia, 0, 0, 100);
  }
}

function isLoopbackAddress(host: string): boolean {
  const h = host.toLowerCase();
  return (
    h === '127.0.0.1' ||
    h === 'localhost' ||
    h === '::1' ||
    h === '[::1]' ||
    h.startsWith('127.')
  );
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------
//
// Environment knobs:
//
//   STUDIO_PORT          Listen port; `0` = OS picks an ephemeral port.
//   STUDIO_HOST          Bind host (always 127.0.0.1 unless explicitly
//                        overridden via STUDIO_ALLOW_PUBLIC_BIND=1).
//   STUDIO_STORE_DIR     Persistent state directory (vault, token, SQLite).
//   STUDIO_PROFILE       Optional profile suffix for OS app-data isolation
//                        (e.g. "dev" => studio-pro-dev data dir).
//   STUDIO_PORT_FILE     If set, daemon writes the chosen port here.
//   STUDIO_SERVE_UI_FROM_SOURCE `1` serves UI from src/studio/static + live reload.
//
if (require.main === module) {
  const portEnv = process.env['STUDIO_PORT'];
  const port = portEnv !== undefined ? parseInt(portEnv, 10) : undefined;
  const studio = new StudioServer({
    serveUiFromSource: process.env['STUDIO_SERVE_UI_FROM_SOURCE'] === '1',
    port: Number.isFinite(port) ? port : undefined,
    host: process.env['STUDIO_HOST'],
    storeDir: process.env['STUDIO_STORE_DIR'],
    portFile: process.env['STUDIO_PORT_FILE'],
  });
  studio.listen().catch((err: Error) => {
    console.error('Failed to start Studio UI:', err.message);
    process.exit(1);
  });
  // Graceful shutdown so the daemon exits cleanly on signal.
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, () => {
      studio.close().finally(() => process.exit(0));
    });
  }
}
