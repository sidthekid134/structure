import type { OperationRecord } from '../orchestration/event-log.js';

export interface ProvisioningEventLogPort {
  getOperation(runId: string): OperationRecord | null;
  updateOperationStatus(runId: string, status: OperationRecord['status']): void;
}

export interface ProvisioningBroadcastPort {
  broadcastStatusUpdate(runId: string, status: string, message?: string): void;
  broadcastProgress(
    runId: string,
    provider: string,
    step: string,
    status: string,
    details?: unknown,
  ): void;
}

export type ResumeChoice = 'full-revalidate' | 'trust-log';

export interface ResumeRunResult {
  runId: string;
  choice: ResumeChoice;
  status: 'resuming';
  message: string;
}

export function resumeProvisioningRun(
  runId: string,
  choice: string | undefined,
  eventLog: ProvisioningEventLogPort,
  broadcaster: ProvisioningBroadcastPort,
): ResumeRunResult {
  if (choice !== 'full-revalidate' && choice !== 'trust-log') {
    throw new Error('Invalid choice. Must be "full-revalidate" or "trust-log".');
  }

  const record = eventLog.getOperation(runId);
  if (!record) {
    throw new Error(`Run "${runId}" not found`);
  }

  if (record.status !== 'failure' && record.status !== 'partial') {
    throw new Error(
      `Run is in status "${record.status}" and cannot be resumed. Only "failure" or "partial" runs can be resumed.`,
    );
  }

  broadcaster.broadcastStatusUpdate(runId, 'resuming', `User chose: ${choice}`);
  eventLog.updateOperationStatus(runId, 'running');
  broadcaster.broadcastProgress(runId, 'system', 'resume', 'running', { choice });

  return {
    runId,
    choice,
    status: 'resuming',
    message: `Resume initiated with strategy: ${choice}. Monitor progress via WebSocket /ws/provisioning/${runId}`,
  };
}
