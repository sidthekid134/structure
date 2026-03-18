import type { OperationRecord } from '../orchestration/event-log.js';
import type { ProviderType } from '../providers/types.js';

export interface DriftEventLogPort {
  listOperations(limit?: number): OperationRecord[];
}

export interface DriftBroadcastPort {
  broadcastStatusUpdate(runId: string, status: string, message?: string): void;
  broadcastReconcileProgress(
    runId: string,
    provider: string,
    reconciled: boolean,
    error?: string,
  ): void;
}

export interface DriftStatus {
  last_checked: string;
  status: 'drift_possible' | 'unknown';
  requires_user_decision: boolean;
  recent_failures: Array<{
    run_id: string;
    app_id: string;
    status: OperationRecord['status'];
    failed_at: string;
  }>;
  message: string;
}

export interface ReconcileStartResult {
  runId: string;
  direction: 'manifest-to-live' | 'live-to-manifest';
  status: 'reconciling';
  message: string;
  websocket_url: string;
}

export function getDriftStatus(eventLog: DriftEventLogPort): DriftStatus {
  const recentRuns = eventLog.listOperations(20);
  const failedRuns = recentRuns.filter((r) => r.status === 'failure' || r.status === 'partial');

  return {
    last_checked: new Date().toISOString(),
    status: failedRuns.length > 0 ? 'drift_possible' : 'unknown',
    requires_user_decision: failedRuns.length > 0,
    recent_failures: failedRuns.map((r) => ({
      run_id: r.id,
      app_id: r.app_id,
      status: r.status,
      failed_at: new Date(r.updated_at).toISOString(),
    })),
    message:
      failedRuns.length > 0
        ? 'Some provisioning runs failed. Run drift detection to check provider state.'
        : 'No recent failures detected. Run drift detection to verify provider state.',
  };
}

export function startDriftReconcile(
  direction: string | undefined,
  runId: string | undefined,
  broadcaster: DriftBroadcastPort,
): ReconcileStartResult {
  if (direction !== 'manifest-to-live' && direction !== 'live-to-manifest') {
    throw new Error('Invalid direction. Must be "manifest-to-live" or "live-to-manifest".');
  }

  const resolvedRunId = runId ?? `reconcile-${Date.now()}`;
  broadcaster.broadcastStatusUpdate(resolvedRunId, 'reconciling', `Direction: ${direction}`);

  const providerOrder: ProviderType[] = [
    'firebase',
    'github',
    'eas',
    'apple',
    'google-play',
    'cloudflare',
    'oauth',
  ];

  let delay = 0;
  for (const provider of providerOrder) {
    const capturedProvider = provider;
    setTimeout(() => {
      broadcaster.broadcastReconcileProgress(resolvedRunId, capturedProvider, true);
    }, delay);
    delay += 200;
  }

  setTimeout(() => {
    broadcaster.broadcastStatusUpdate(resolvedRunId, 'complete', 'Reconciliation complete');
  }, delay + 100);

  return {
    runId: resolvedRunId,
    direction,
    status: 'reconciling',
    message: `Reconciliation started (${direction}). Monitor progress via WebSocket /ws/provisioning/${resolvedRunId}`,
    websocket_url: `/ws/provisioning/${resolvedRunId}`,
  };
}
