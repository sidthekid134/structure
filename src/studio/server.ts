/**
 * Studio UI Server — local web interface for project management and monitoring.
 *
 * Starts an Express HTTP server on localhost:3000 serving:
 *   - Static dashboard UI (HTML/CSS/JS)
 *   - REST API endpoints under /api/
 *   - WebSocket endpoint at /ws/provisioning/:runId
 *
 * Usage:
 *   const server = new StudioServer({ port: 3000, storeDir: '~/.platform' });
 *   await server.listen();
 */

import 'dotenv/config';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import express from 'express';
import { WebSocketServer } from 'ws';
import { EventLog } from '../orchestration/event-log.js';
import { createApiRouter } from './api.js';
import { WsHandler } from './ws-handler.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface StudioServerOptions {
  /** Port to listen on. Defaults to 3000. */
  port?: number;
  /** Host to bind to. Defaults to 127.0.0.1 (localhost only). */
  host?: string;
  /** Directory for SQLite event log and secret stores. Defaults to ~/.platform */
  storeDir?: string;
  /** Enables live-reload + source static serving for local development. */
  devMode?: boolean;
}

// ---------------------------------------------------------------------------
// StudioServer
// ---------------------------------------------------------------------------

export class StudioServer {
  private readonly app: express.Application;
  private readonly httpServer: http.Server;
  private readonly wss: WebSocketServer;
  private readonly eventLog: EventLog;
  private readonly devMode: boolean;
  private readonly staticDir: string;
  private readonly liveReloadClients = new Set<http.ServerResponse>();
  private staticWatcher?: fs.FSWatcher;
  readonly wsHandler: WsHandler;

  constructor(private readonly options: StudioServerOptions = {}) {
    const storeDir =
      options.storeDir ??
      path.join(process.env['HOME'] ?? '/tmp', '.platform');

    this.eventLog = new EventLog(storeDir);
    this.devMode = options.devMode ?? process.env['STUDIO_DEV_MODE'] === '1';
    this.staticDir = this.resolveStaticDir();
    this.app = express();
    this.httpServer = http.createServer(this.app);
    this.wss = new WebSocketServer({ noServer: true });
    this.wsHandler = new WsHandler(this.wss);

    this.setupMiddleware();
    this.setupRoutes(storeDir);
    this.setupWebSocket();
    if (this.devMode) {
      this.setupLiveReloadWatcher();
    }
  }

  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------

  private setupMiddleware(): void {
    this.app.use(express.json());
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
        const durationMs = Date.now() - start;
        const message = `[studio-api] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${durationMs}ms)`;
        if (res.statusCode >= 500) {
          console.error(message);
          return;
        }
        if (res.statusCode >= 400) {
          console.warn(message);
          return;
        }
        console.log(message);
      });
      next();
    });
  }

  private setupRoutes(storeDir: string): void {
    this.app.use(express.static(this.staticDir, { index: false }));

    // REST API
    this.app.use('/api', createApiRouter(this.eventLog, this.wsHandler, storeDir, this.devMode));

    this.app.get('/__studio_live_reload', (_req, res) => {
      if (!this.devMode) {
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

      if (match) {
        const runId = match[1];
        this.wss.handleUpgrade(request, socket, head, (ws) => {
          this.wsHandler.handleConnection(ws, runId);
        });
      } else {
        socket.destroy();
      }
    });
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  listen(): Promise<void> {
    const port = this.options.port ?? 3000;
    const host = this.options.host ?? '127.0.0.1';

    return new Promise((resolve) => {
      this.httpServer.listen(port, host, () => {
        console.log(`Studio UI running at http://${host}:${port}`);
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
      this.httpServer.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  get server(): http.Server {
    return this.httpServer;
  }

  private resolveStaticDir(): string {
    if (!this.devMode) {
      return path.join(__dirname, 'static');
    }

    const sourceStaticDir = path.join(process.cwd(), 'src', 'studio', 'static');
    if (!fs.existsSync(sourceStaticDir)) {
      throw new Error(`Dev mode requires static assets at ${sourceStaticDir}`);
    }
    return sourceStaticDir;
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
// CLI entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  const studio = new StudioServer({
    devMode: process.env['STUDIO_DEV_MODE'] === '1',
  });
  studio.listen().catch((err: Error) => {
    console.error('Failed to start Studio UI:', err.message);
    process.exit(1);
  });
}
