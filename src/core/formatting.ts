import type { OperationEvent, OperationRecord } from '../orchestration/event-log.js';
import type { IntegrationConfigRecord } from '../studio/project-manager.js';

export function formatRun(record: OperationRecord, events: OperationEvent[]): object {
  return {
    id: record.id,
    app_id: record.app_id,
    status: record.status,
    created_at: new Date(record.created_at).toISOString(),
    updated_at: new Date(record.updated_at).toISOString(),
    events: events.map((e) => ({
      id: e.id,
      provider: e.provider,
      step: e.step,
      status: e.status,
      error_message: e.error_message,
      timestamp: new Date(e.timestamp).toISOString(),
      result: e.result_json ? JSON.parse(e.result_json) : null,
    })),
  };
}

export function integrationProgress(
  integrations: Partial<Record<string, IntegrationConfigRecord>>,
): {
  configured: number;
  total: number;
} {
  const list = Object.values(integrations).filter(
    (entry): entry is IntegrationConfigRecord => entry !== undefined,
  );
  return {
    configured: list.filter((entry) => entry.status === 'configured').length,
    total: list.length,
  };
}
