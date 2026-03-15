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

import * as http from 'http';
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
}

// ---------------------------------------------------------------------------
// StudioServer
// ---------------------------------------------------------------------------

export class StudioServer {
  private readonly app: express.Application;
  private readonly httpServer: http.Server;
  private readonly wss: WebSocketServer;
  private readonly eventLog: EventLog;
  readonly wsHandler: WsHandler;

  constructor(private readonly options: StudioServerOptions = {}) {
    const storeDir =
      options.storeDir ??
      path.join(process.env['HOME'] ?? '/tmp', '.platform');

    this.eventLog = new EventLog(storeDir);
    this.app = express();
    this.httpServer = http.createServer(this.app);
    this.wss = new WebSocketServer({ noServer: true });
    this.wsHandler = new WsHandler(this.wss);

    this.setupMiddleware();
    this.setupRoutes(storeDir);
    this.setupWebSocket();
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
  }

  private setupRoutes(storeDir: string): void {
    // Static files from src/studio/static/
    const staticDir = path.join(__dirname, 'static');
    this.app.use(express.static(staticDir));

    // REST API
    this.app.use('/api', createApiRouter(this.eventLog, this.wsHandler, storeDir));

    // SPA fallback — serve index.html for any unmatched route
    this.app.get('*', (_req, res) => {
      res.sendFile(path.join(staticDir, 'index.html'));
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
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  const studio = new StudioServer();
  studio.listen().catch((err: Error) => {
    console.error('Failed to start Studio UI:', err.message);
    process.exit(1);
  });
}
