/**
 * WsHandler — manages WebSocket connections for real-time provisioning updates.
 *
 * Clients connect to /ws/provisioning/:runId and receive JSON messages as
 * provisioning events occur. The server broadcasts to all subscribers for a
 * given runId.
 */

import { WebSocket, WebSocketServer } from 'ws';

// ---------------------------------------------------------------------------
// Message types
// ---------------------------------------------------------------------------

export type WsMessageType =
  | 'connected'
  | 'progress'
  | 'step_progress'
  | 'status_update'
  | 'reconcile_progress'
  | 'error'
  | 'complete';

export interface WsMessage {
  type: WsMessageType;
  runId: string;
  timestamp: string;
  data: unknown;
}

// ---------------------------------------------------------------------------
// WsHandler
// ---------------------------------------------------------------------------

export class WsHandler {
  /** runId → set of active WebSocket connections */
  private readonly clients = new Map<string, Set<WebSocket>>();

  constructor(private readonly wss: WebSocketServer) {}

  /**
   * Called when a client connects to /ws/provisioning/:runId.
   * Registers the socket and sets up lifecycle handlers.
   */
  handleConnection(ws: WebSocket, runId: string): void {
    if (!this.clients.has(runId)) {
      this.clients.set(runId, new Set());
    }
    this.clients.get(runId)!.add(ws);

    // Send confirmation message
    this.send(ws, {
      type: 'connected',
      runId,
      timestamp: new Date().toISOString(),
      data: { message: `Subscribed to provisioning run ${runId}` },
    });

    ws.on('close', () => {
      const set = this.clients.get(runId);
      if (set) {
        set.delete(ws);
        if (set.size === 0) this.clients.delete(runId);
      }
    });

    ws.on('error', (err) => {
      console.error(`[WsHandler] Error on run ${runId}: ${err.message}`);
      const set = this.clients.get(runId);
      if (set) {
        set.delete(ws);
        if (set.size === 0) this.clients.delete(runId);
      }
    });
  }

  /**
   * Broadcasts a message to all clients subscribed to runId.
   */
  broadcast(runId: string, message: WsMessage): void {
    const set = this.clients.get(runId);
    if (!set || set.size === 0) return;

    const payload = JSON.stringify(message);
    for (const client of set) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  /**
   * Broadcasts a provisioning progress event.
   */
  broadcastProgress(
    runId: string,
    provider: string,
    step: string,
    status: string,
    details?: unknown,
  ): void {
    this.broadcast(runId, {
      type: 'progress',
      runId,
      timestamp: new Date().toISOString(),
      data: { provider, step, status, details },
    });
  }

  /**
   * Broadcasts a run status update (e.g. running → success).
   */
  broadcastStatusUpdate(runId: string, status: string, message?: string): void {
    this.broadcast(runId, {
      type: 'status_update',
      runId,
      timestamp: new Date().toISOString(),
      data: { status, message },
    });
  }

  /**
   * Broadcasts a reconciliation progress update.
   */
  broadcastReconcileProgress(
    runId: string,
    provider: string,
    reconciled: boolean,
    error?: string,
  ): void {
    this.broadcast(runId, {
      type: 'reconcile_progress',
      runId,
      timestamp: new Date().toISOString(),
      data: { provider, reconciled, error },
    });
  }

  /**
   * Broadcasts a step-level progress event (for the new DAG-based provisioning).
   * Clients listening on the project's provisioning channel receive these events.
   */
  broadcastStepProgress(
    projectId: string,
    nodeKey: string,
    nodeType: 'step' | 'user-action',
    status: string,
    environment?: string,
    resourcesProduced?: Record<string, string>,
    error?: string,
    userPrompt?: string,
  ): void {
    this.broadcast(projectId, {
      type: 'step_progress',
      runId: projectId,
      timestamp: new Date().toISOString(),
      data: {
        nodeKey,
        nodeType,
        status,
        environment,
        resourcesProduced,
        error,
        userPrompt,
      },
    });
  }

  /** Sends a message to a single WebSocket. */
  private send(ws: WebSocket, message: WsMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  /** Closes all active connections (used on server shutdown). */
  closeAll(): void {
    for (const set of this.clients.values()) {
      for (const ws of set) {
        ws.close();
      }
    }
    this.clients.clear();
  }

  get connectionCount(): number {
    let count = 0;
    for (const set of this.clients.values()) count += set.size;
    return count;
  }

  get subscribedRunIds(): string[] {
    return [...this.clients.keys()];
  }
}
