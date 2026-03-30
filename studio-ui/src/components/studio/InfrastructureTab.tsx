import { useCallback, useEffect, useRef, useState } from 'react';
import { ProvisioningGraphView } from './ProvisioningGraphView';
import { api } from './helpers';
import type { ProvisioningPlanResponse, WsStepProgressMessage } from './types';

// ---------------------------------------------------------------------------
// InfrastructureTab
// Wraps ProvisioningGraphView with real API data and WebSocket live updates.
// ---------------------------------------------------------------------------

interface InfrastructureTabProps {
  projectId: string;
}

export function InfrastructureTab({ projectId }: InfrastructureTabProps) {
  const [plan, setPlan] = useState<ProvisioningPlanResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const loadPlan = useCallback(async () => {
    try {
      const data = await api<ProvisioningPlanResponse>(
        `/api/projects/${encodeURIComponent(projectId)}/provisioning/plan`,
      );
      setPlan(data);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [projectId]);

  useEffect(() => {
    void loadPlan();
  }, [loadPlan]);

  // Auto-poll while any step is in-progress so long-running operations (e.g. GCP
  // project creation) surface their results even when WebSocket is unavailable.
  const hasInProgress = plan
    ? Object.values(plan.nodeStates).some((s) => s.status === 'in-progress')
    : false;
  useEffect(() => {
    if (!hasInProgress) return;
    const id = setInterval(() => { void loadPlan(); }, 3000);
    return () => clearInterval(id);
  }, [hasInProgress, loadPlan]);

  // WebSocket for live step progress updates
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(
      `${protocol}://${window.location.host}/ws/provisioning/${encodeURIComponent(projectId)}`,
    );
    wsRef.current = ws;

    ws.onmessage = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data as string) as WsStepProgressMessage | { type: string };
        if (msg.type === 'step_progress') {
          const stepMsg = msg as WsStepProgressMessage;
          setPlan((prev) => {
            if (!prev) return prev;
            const { nodeKey, status, environment, resourcesProduced, error: stepError } = stepMsg.data;
            const stateKey = environment ? `${nodeKey}@${environment}` : nodeKey;

            // Map WS status to NodeStatus
            const nodeStatus = (() => {
              switch (status) {
                case 'success': return 'completed' as const;
                case 'failure': return 'failed' as const;
                case 'waiting-on-user': return 'waiting-on-user' as const;
                case 'resolving': return 'resolving' as const;
                case 'running': return 'in-progress' as const;
                case 'skipped': return 'skipped' as const;
                case 'blocked': return 'blocked' as const;
                default: return 'not-started' as const;
              }
            })();

            return {
              ...prev,
              nodeStates: {
                ...prev.nodeStates,
                [stateKey]: {
                  nodeKey,
                  status: nodeStatus,
                  environment,
                  resourcesProduced: resourcesProduced ?? prev.nodeStates[stateKey]?.resourcesProduced,
                  error: stepError,
                  completedAt: nodeStatus === 'completed' ? Date.now() : undefined,
                  startedAt: nodeStatus === 'in-progress' ? Date.now() : prev.nodeStates[stateKey]?.startedAt,
                },
              },
            };
          });
        }
      } catch {
        // Ignore malformed messages
      }
    };

    return () => {
      ws.close();
    };
  }, [projectId]);

  const handleUserActionComplete = useCallback(
    async (nodeKey: string, resources?: Record<string, string>) => {
      await api(`/api/projects/${encodeURIComponent(projectId)}/provisioning/plan/user-action/${encodeURIComponent(nodeKey)}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resourcesProduced: resources }),
      });
      // Reload plan to get fresh server state
      await loadPlan();
    },
    [projectId, loadPlan],
  );

  const handleRefresh = useCallback(async () => {
    await loadPlan();
  }, [loadPlan]);

  if (error) {
    return (
      <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-600 dark:text-red-400">
        Failed to load provisioning plan: {error}
      </div>
    );
  }

  return (
    <ProvisioningGraphView
      projectId={projectId}
      plan={plan}
      onPlanChange={setPlan}
      onUserActionComplete={handleUserActionComplete}
      onRefresh={handleRefresh}
    />
  );
}
