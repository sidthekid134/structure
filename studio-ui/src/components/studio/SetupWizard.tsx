import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Loader2,
  Lock,
  PauseCircle,
  Play,
  RefreshCw,
  ScanSearch,
  ShieldAlert,
  SkipForward,
  Undo2,
  Upload,
  Zap,
} from 'lucide-react';
import { api } from './helpers';
import { CompletedStepArtifactsPanel } from './CompletedStepArtifactsPanel';
import {
  JOURNEY_PHASE_TITLE,
  type JourneyPhaseId,
  type NodeState,
  type NodeStatus,
  type ProvisioningGraphNode,
  type ProvisioningPlanResponse,
  type ProvisioningStepNode,
  type UserActionNode,
} from './types';
import { OAuthFlowPanel } from './OAuthFlowPanel';
import { effectiveUserActionInteractiveAction } from './user-action-interactive';

interface GroupedSidebarStep {
  node: ProvisioningGraphNode;
  index: number;
}

interface SidebarGroup {
  label: string;
  key: string;
  items: GroupedSidebarStep[];
}

function buildJourneySidebarGroups(
  orderedNodes: ProvisioningGraphNode[],
  journeyPhaseByNodeKey: Record<string, JourneyPhaseId> | undefined,
): SidebarGroup[] {
  const groups: SidebarGroup[] = [];
  for (let i = 0; i < orderedNodes.length; i++) {
    const node = orderedNodes[i]!;
    const phase: JourneyPhaseId = journeyPhaseByNodeKey?.[node.key] ?? 'verification';
    const label = JOURNEY_PHASE_TITLE[phase] ?? phase;
    const last = groups[groups.length - 1];
    if (last && last.label === label) {
      last.items.push({ node, index: i });
    } else {
      groups.push({
        label,
        key: `${phase}-${i}`,
        items: [{ node, index: i }],
      });
    }
  }
  return groups;
}

function getStateKey(node: ProvisioningGraphNode, environment?: string): string {
  if (node.type === 'step' && node.environmentScope === 'per-environment' && environment) {
    return `${node.key}@${environment}`;
  }
  return node.key;
}

function getNodeStatus(node: ProvisioningGraphNode, nodeStates: Record<string, NodeState>, environments: string[]) {
  if (node.type === 'step' && node.environmentScope === 'per-environment') {
    const statuses = environments.map((env) => nodeStates[`${node.key}@${env}`]?.status ?? 'not-started');
    if (statuses.some((s) => s === 'in-progress')) return 'in-progress';
    if (statuses.some((s) => s === 'failed')) return 'failed';
    if (statuses.some((s) => s === 'waiting-on-user')) return 'waiting-on-user';
    if (statuses.some((s) => s === 'resolving')) return 'resolving';
    if (statuses.every((s) => s === 'completed' || s === 'skipped')) return 'completed';
    if (statuses.some((s) => s === 'blocked')) return 'blocked';
    return 'not-started';
  }
  return nodeStates[node.key]?.status ?? 'not-started';
}

function statusIsDone(s: NodeStatus | undefined): boolean {
  return s === 'completed' || s === 'skipped';
}

function humanizeStatus(s: NodeStatus | undefined): string {
  if (!s) return 'not started';
  return s.replace(/-/g, ' ');
}

/**
 * Required dependencies for one execution context (global node, or one per-env instance).
 */
function getBlockersForInstance(
  node: ProvisioningGraphNode,
  instanceEnv: string | undefined,
  plan: ProvisioningPlanResponse,
): string[] {
  const nodeMap = new Map(plan.nodes.map((n) => [n.key, n]));
  const reasons: string[] = [];

  for (const dep of node.dependencies) {
    if (!dep.required) continue;
    const depNode = nodeMap.get(dep.nodeKey);
    if (!depNode) continue;

    const depPerEnv = depNode.type === 'step' && depNode.environmentScope === 'per-environment';

    if (depPerEnv) {
      if (instanceEnv !== undefined) {
        const sk = `${dep.nodeKey}@${instanceEnv}`;
        const st = plan.nodeStates[sk]?.status ?? 'not-started';
        if (!statusIsDone(st)) {
          reasons.push(`${depNode.label} (${instanceEnv}): ${humanizeStatus(st)}`);
        }
      } else {
        for (const env of plan.environments) {
          const sk = `${dep.nodeKey}@${env}`;
          const st = plan.nodeStates[sk]?.status ?? 'not-started';
          if (!statusIsDone(st)) {
            reasons.push(`${depNode.label} (${env}): ${humanizeStatus(st)}`);
          }
        }
      }
    } else {
      const st = plan.nodeStates[dep.nodeKey]?.status ?? 'not-started';
      if (!statusIsDone(st)) {
        reasons.push(`${depNode.label}: ${humanizeStatus(st)}`);
      }
    }
  }

  return reasons;
}

/**
 * Blockers for the next work on this node (first per-env instance that is not done and cannot run yet, or global).
 */
function getDependencyBlockers(node: ProvisioningGraphNode, plan: ProvisioningPlanResponse): string[] {
  const status = getNodeStatus(node, plan.nodeStates, plan.environments);
  if (status === 'completed' || status === 'skipped') return [];

  if (node.type === 'step' && node.environmentScope === 'per-environment') {
    for (const env of plan.environments) {
      const sk = `${node.key}@${env}`;
      const st = plan.nodeStates[sk]?.status ?? 'not-started';
      if (statusIsDone(st)) continue;
      const b = getBlockersForInstance(node, env, plan);
      if (b.length > 0) return b;
    }
    return [];
  }

  return getBlockersForInstance(node, undefined, plan);
}

function stepHasRunnableInstance(node: ProvisioningGraphNode, plan: ProvisioningPlanResponse): boolean {
  if (node.type !== 'step') return false;
  if (node.environmentScope === 'per-environment') {
    return plan.environments.some((env) => {
      const sk = `${node.key}@${env}`;
      const st = plan.nodeStates[sk]?.status ?? 'not-started';
      if (statusIsDone(st)) return false;
      return getBlockersForInstance(node, env, plan).length === 0;
    });
  }
  return getBlockersForInstance(node, undefined, plan).length === 0;
}

function userActionDepsSatisfied(node: ProvisioningGraphNode, plan: ProvisioningPlanResponse): boolean {
  if (node.type !== 'user-action') return true;
  return getBlockersForInstance(node, undefined, plan).length === 0;
}

/** Sidebar + messaging: waiting on upstream when not in a terminal/active state that already implies progress. */
function isDependencyWaiting(
  node: ProvisioningGraphNode,
  plan: ProvisioningPlanResponse,
  status: NodeStatus,
): boolean {
  if (status === 'completed' || status === 'skipped' || status === 'in-progress' || status === 'waiting-on-user' || status === 'resolving') {
    return false;
  }
  return getDependencyBlockers(node, plan).length > 0;
}

/** Fallback if API omits canonicalNodeOrder (should not happen for enriched plans). */
function computeFallbackNodeOrder(nodes: ProvisioningGraphNode[]) {
  const nodeMap = new Map(nodes.map((n) => [n.key, n]));
  const inDegree = new Map<string, number>();
  const edges = new Map<string, Set<string>>();
  for (const node of nodes) {
    inDegree.set(node.key, 0);
    edges.set(node.key, new Set());
  }
  for (const node of nodes) {
    for (const dep of node.dependencies) {
      if (!nodeMap.has(dep.nodeKey)) continue;
      inDegree.set(node.key, (inDegree.get(node.key) ?? 0) + 1);
      edges.get(dep.nodeKey)?.add(node.key);
    }
  }
  const queue: string[] = [];
  for (const [key, degree] of inDegree.entries()) {
    if (degree === 0) queue.push(key);
  }
  const order: string[] = [];
  let head = 0;
  while (head < queue.length) {
    const key = queue[head++]!;
    order.push(key);
    for (const next of edges.get(key) ?? new Set<string>()) {
      const degree = (inDegree.get(next) ?? 1) - 1;
      inDegree.set(next, degree);
      if (degree === 0) queue.push(next);
    }
  }
  if (order.length !== nodes.length) {
    for (const node of nodes) {
      if (!order.includes(node.key)) order.push(node.key);
    }
  }
  return order;
}

export function SetupWizard({
  projectId,
  plan,
  onPlanChange,
  onUserActionComplete,
  onRefresh,
}: {
  projectId: string;
  plan: ProvisioningPlanResponse | null;
  onPlanChange: (plan: ProvisioningPlanResponse) => void;
  onUserActionComplete: (nodeKey: string, resources?: Record<string, string>) => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  const [credentialText, setCredentialText] = useState('');
  const [resourceInputs, setResourceInputs] = useState<Record<string, string>>({});
  const [isRunning, setIsRunning] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isReverting, setIsReverting] = useState(false);
  const [isRevalidating, setIsRevalidating] = useState(false);
  const [isSkipping, setIsSkipping] = useState(false);
  const [isSyncingPlan, setIsSyncingPlan] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sidebarFocusIndex, setSidebarFocusIndex] = useState<number | null>(null);

  const syncAndRefresh = useCallback(async () => {
    try {
      await api(`/api/projects/${encodeURIComponent(projectId)}/provisioning/plan/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
    } catch { /* best-effort */ }
    await onRefresh();
  }, [projectId, onRefresh]);

  const orderedNodes = useMemo(() => {
    if (!plan) return [];
    const byKey = new Map(plan.nodes.map((n) => [n.key, n]));
    const keys =
      plan.canonicalNodeOrder?.length
        ? plan.canonicalNodeOrder.filter((k) => byKey.has(k))
        : computeFallbackNodeOrder(plan.nodes);
    return keys.map((key) => byKey.get(key)).filter(Boolean) as ProvisioningGraphNode[];
  }, [plan]);

  const sidebarGroups = useMemo(
    () => buildJourneySidebarGroups(orderedNodes, plan?.journeyPhaseByNodeKey),
    [orderedNodes, plan?.journeyPhaseByNodeKey],
  );

  const currentIndex = useMemo(() => {
    if (!plan) return 0;
    const idx = orderedNodes.findIndex((node) => {
      const status = getNodeStatus(node, plan.nodeStates, plan.environments);
      return status !== 'completed' && status !== 'skipped';
    });
    return idx >= 0 ? idx : Math.max(orderedNodes.length - 1, 0);
  }, [orderedNodes, plan]);

  const displayIndex = useMemo(() => {
    if (sidebarFocusIndex === null) return currentIndex;
    if (sidebarFocusIndex < 0 || sidebarFocusIndex >= orderedNodes.length) return currentIndex;
    return sidebarFocusIndex;
  }, [sidebarFocusIndex, currentIndex, orderedNodes.length]);

  useEffect(() => {
    setSidebarFocusIndex(null);
  }, [projectId]);

  const currentNode = orderedNodes[displayIndex] ?? null;
  const currentStatus = currentNode && plan ? getNodeStatus(currentNode, plan.nodeStates, plan.environments) : 'not-started';

  const phaseProgress = useMemo(() => {
    if (!plan || !currentNode) return { done: 0, total: 0, phase: null as JourneyPhaseId | null };
    const displayPhaseId = plan.journeyPhaseByNodeKey[currentNode.key] ?? 'verification';
    const peers = orderedNodes.filter(
      (n) => (plan.journeyPhaseByNodeKey[n.key] ?? 'verification') === displayPhaseId,
    );
    const done = peers.filter((n) => {
      const s = getNodeStatus(n, plan.nodeStates, plan.environments);
      return s === 'completed' || s === 'skipped';
    }).length;
    return { done, total: peers.length, phase: displayPhaseId };
  }, [plan, orderedNodes, currentNode]);

  const currentBlockers = useMemo(() => {
    if (!plan || !currentNode) return [] as string[];
    return getDependencyBlockers(currentNode, plan);
  }, [plan, currentNode]);

  const isTeardown = currentNode?.type === 'step' && currentNode.direction === 'teardown';

  const planHasInProgress = useMemo(() => {
    if (!plan) return false;
    return Object.values(plan.nodeStates).some((s) => s.status === 'in-progress');
  }, [plan]);

  const isFirebaseProviderStep =
    currentNode?.type === 'step' && currentNode.provider === 'firebase';
  const stepRunnable =
    currentNode?.type === 'step' &&
    !isFirebaseProviderStep &&
    currentStatus !== 'completed' &&
    currentStatus !== 'skipped' &&
    currentStatus !== 'in-progress' &&
    stepHasRunnableInstance(currentNode, plan!);
  const canRunCurrent = Boolean(stepRunnable);
  const isUserAction = currentNode?.type === 'user-action';
  const userActionCanSubmit =
    isUserAction &&
    currentStatus !== 'completed' &&
    userActionDepsSatisfied(currentNode, plan!);

  async function runCurrentStep() {
    if (!currentNode || currentNode.type !== 'step') return;
    setError(null);
    setIsRunning(true);
    try {
      await api(`/api/projects/${encodeURIComponent(projectId)}/provisioning/plan/run/nodes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodeKeys: [currentNode.key] }),
      });
      await onRefresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsRunning(false);
    }
  }

  async function submitUserAction() {
    if (!currentNode || currentNode.type !== 'user-action') return;
    setError(null);
    setIsSubmitting(true);
    const pinnedIndex = displayIndex;
    try {
      const payload: Record<string, string> = {};
      if (currentNode.verification.type === 'credential-upload') {
        payload[currentNode.verification.secretKey] = credentialText.trim();
      } else {
        for (const produced of currentNode.produces) {
          const value = resourceInputs[produced.key]?.trim();
          if (value) payload[produced.key] = value;
        }
      }
      await onUserActionComplete(currentNode.key, payload);
      setCredentialText('');
      setResourceInputs({});
      await onRefresh();
      setSidebarFocusIndex(pinnedIndex);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsSubmitting(false);
    }
  }

  async function skipStep() {
    if (!currentNode || !plan) return;
    setError(null);
    setIsSkipping(true);
    try {
      const updated = await api<ProvisioningPlanResponse>(
        `/api/projects/${encodeURIComponent(projectId)}/provisioning/plan/node/skip`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nodeKey: currentNode.key }),
        },
      );
      onPlanChange(updated);
      await onRefresh();
      setSidebarFocusIndex(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsSkipping(false);
    }
  }

  async function revertStep() {
    if (!currentNode) return;
    if (
      !window.confirm(
        'Revert this step and delete the associated cloud resources? Dependent steps will also be reverted.',
      )
    ) {
      return;
    }
    setError(null);
    setIsReverting(true);

    async function executeRevert() {
      const result = await api<
        ProvisioningPlanResponse & { revertWarnings?: string[]; needsReauth?: boolean; sessionId?: string; authUrl?: string }
      >(
        `/api/projects/${encodeURIComponent(projectId)}/provisioning/plan/node/reset`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nodeKey: currentNode!.key }),
        },
      );

      if (result.needsReauth && result.authUrl && result.sessionId) {
        window.open(result.authUrl, '_blank', 'noopener,noreferrer');
        const sid = result.sessionId;
        for (let i = 0; i < 300; i++) {
          await new Promise((r) => setTimeout(r, 1500));
          try {
            const status = await api<{ phase: string; connected?: boolean; error?: string }>(
              `/api/projects/${encodeURIComponent(projectId)}/integrations/firebase/connect/oauth/${encodeURIComponent(sid)}`,
            );
            if (status.phase === 'completed' && status.connected) {
              // Re-authenticated — retry the revert now that we have a token.
              const retried = await api<ProvisioningPlanResponse & { revertWarnings?: string[] }>(
                `/api/projects/${encodeURIComponent(projectId)}/provisioning/plan/node/reset`,
                {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ nodeKey: currentNode!.key }),
                },
              );
              onPlanChange(retried);
              await onRefresh();
              if (retried.revertWarnings?.length) {
                setError(`Partial revert: ${retried.revertWarnings.join('; ')}`);
              }
              return;
            }
            if (status.phase === 'failed' || status.phase === 'expired') {
              setError(status.error ?? 'Google re-authentication failed. Please try again.');
              return;
            }
          } catch {
            // polling error — keep trying
          }
        }
        setError('Re-authentication timed out. Please try again.');
        return;
      }

      onPlanChange(result);
      await onRefresh();
      if (result.revertWarnings?.length) {
        setError(`Partial revert: ${result.revertWarnings.join('; ')}`);
      }
    }

    try {
      await executeRevert();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsReverting(false);
    }
  }

  async function revalidateStep() {
    if (!currentNode || currentNode.type !== 'step') return;
    setError(null);
    setIsRevalidating(true);
    try {
      const res = await api<{
        supported: boolean;
        message?: string;
        plan: ProvisioningPlanResponse;
        results?: Array<{ environment?: string; stillValid: boolean }>;
      }>(`/api/projects/${encodeURIComponent(projectId)}/provisioning/plan/node/revalidate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodeKey: currentNode.key }),
      });
      onPlanChange(res.plan);
      await onRefresh();
      if (!res.supported) {
        setError(res.message ?? 'Revalidation is not available for this step.');
      } else if (res.results?.length) {
        const failed = res.results.filter((r) => !r.stillValid);
        if (failed.length > 0) {
          setError(
            failed.length === res.results.length
              ? 'Revalidation failed: this step no longer matches upstream state and was reset.'
              : `Revalidation: ${failed.length} environment(s) no longer match and were reset.`,
          );
        }
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsRevalidating(false);
    }
  }

  async function syncPlanStatus() {
    setError(null);
    setIsSyncingPlan(true);
    const pinnedIndex = displayIndex;
    try {
      const result = await api<{
        ok?: boolean;
        needsReauth?: boolean;
        sessionId?: string;
        authUrl?: string;
        firebaseResults?: Array<{ nodeKey: string; reconciled: boolean; message: string }>;
      }>(`/api/projects/${encodeURIComponent(projectId)}/provisioning/plan/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      if (result.needsReauth && result.authUrl && result.sessionId) {
        window.open(result.authUrl, '_blank', 'noopener,noreferrer');
        const sid = result.sessionId;
        for (let i = 0; i < 300; i++) {
          await new Promise((r) => setTimeout(r, 1500));
          try {
            const status = await api<{ phase: string; connected?: boolean; error?: string }>(
              `/api/projects/${encodeURIComponent(projectId)}/integrations/firebase/connect/oauth/${encodeURIComponent(sid)}`,
            );
            if (status.phase === 'completed' && status.connected) {
              await api(`/api/projects/${encodeURIComponent(projectId)}/provisioning/plan/sync`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
              });
              break;
            }
            if (status.phase === 'failed' || status.phase === 'expired') {
              setError(status.error ?? 'Google re-authentication failed. Please try again.');
              setIsSyncingPlan(false);
              return;
            }
          } catch {
            // polling error — keep trying
          }
        }
        await onRefresh();
        setSidebarFocusIndex(pinnedIndex);
        setIsSyncingPlan(false);
        return;
      }

      await onRefresh();
      setSidebarFocusIndex(pinnedIndex);

      const failed = result.firebaseResults?.filter((r) => !r.reconciled);
      if (failed?.length) {
        setError(
          `Firebase sync issues:\n${failed.map((r) => `• ${r.nodeKey.replace('firebase:', '')}: ${r.message}`).join('\n')}`,
        );
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsSyncingPlan(false);
    }
  }

  const showRevert =
    currentStatus === 'completed' || currentStatus === 'skipped' || currentStatus === 'failed';
  const showRevalidate =
    currentNode?.type === 'step' && currentStatus === 'completed' && !isTeardown;
  const showSkip =
    Boolean(currentNode && plan) &&
    !['completed', 'skipped', 'in-progress'].includes(currentStatus) &&
    !planHasInProgress;

  if (!plan || !currentNode) {
    return (
      <div className="rounded-xl border border-border p-6 text-sm text-muted-foreground">
        Loading setup wizard...
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(220px,300px)_1fr] gap-4">
      <nav
        aria-label="Setup steps"
        className="rounded-xl border border-border bg-card p-3 max-h-[min(72vh,640px)] overflow-y-auto flex flex-col gap-4"
      >
        {sidebarGroups.map((group) => (
          <div key={group.key}>
            <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-2 px-1">
              {group.label}
            </p>
            <ul className="flex flex-col gap-1">
              {group.items.map(({ node, index }) => {
                const status = getNodeStatus(node, plan.nodeStates, plan.environments);
                const isActive = index === displayIndex;
                const isWizardCursor = index === currentIndex && sidebarFocusIndex === null;
                const waitingOnDeps = isDependencyWaiting(node, plan, status);
                return (
                  <li key={node.key}>
                    <button
                      type="button"
                      onClick={() => setSidebarFocusIndex(index)}
                      title={waitingOnDeps ? 'Waiting on upstream steps — select to see details' : undefined}
                      className={`w-full text-left rounded-lg border px-2.5 py-2 flex items-start gap-2 transition-colors ${isActive
                          ? 'border-primary/50 bg-primary/5 ring-1 ring-primary/20'
                          : 'border-transparent hover:bg-muted/60'
                        } ${waitingOnDeps ? 'opacity-65 saturate-75' : ''}`}
                    >
                      <span
                        className={`mt-0.5 shrink-0 w-5 h-5 rounded-full border flex items-center justify-center ${status === 'completed'
                            ? 'border-emerald-500 bg-emerald-500 text-white'
                            : status === 'in-progress'
                              ? 'border-primary bg-primary/15 text-primary'
                              : status === 'resolving'
                                ? 'border-cyan-500/50 bg-cyan-500/10 text-cyan-600 dark:text-cyan-400'
                                : status === 'failed'
                                  ? 'border-red-500/50 bg-red-500/10 text-red-600 dark:text-red-400'
                                  : status === 'waiting-on-user'
                                    ? 'border-amber-500/50 bg-amber-500/10 text-amber-600 dark:text-amber-400'
                                    : isWizardCursor
                                      ? 'border-primary/40 bg-primary/10 text-primary'
                                      : 'border-border bg-background text-muted-foreground'
                          }`}
                        aria-hidden
                      >
                        {status === 'completed' ? (
                          <CheckCircle2 size={11} strokeWidth={2.5} />
                        ) : status === 'in-progress' ? (
                          <Loader2 size={11} className="animate-spin" />
                        ) : status === 'resolving' ? (
                          <Zap size={10} className="animate-pulse" />
                        ) : status === 'failed' ? (
                          <AlertTriangle size={10} />
                        ) : status === 'waiting-on-user' ? (
                          <PauseCircle size={11} />
                        ) : (
                          <span className="text-[9px] font-bold leading-none">{index + 1}</span>
                        )}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5 flex-wrap">
                          <span className="text-xs font-semibold text-foreground leading-snug line-clamp-2">
                            {node.label}
                          </span>
                          {node.type === 'user-action' && (
                            <span className="shrink-0 text-[9px] font-bold uppercase tracking-wide text-amber-700 dark:text-amber-400 bg-amber-500/15 px-1 py-px rounded">
                              You
                            </span>
                          )}
                          {waitingOnDeps && (
                            <span
                              className="shrink-0 inline-flex items-center gap-0.5 text-[9px] font-bold uppercase tracking-wide text-muted-foreground bg-muted px-1 py-px rounded border border-border"
                              aria-hidden
                            >
                              <Lock size={9} strokeWidth={2.5} />
                              Blocked
                            </span>
                          )}
                        </span>
                        {node.type === 'step' && node.environmentScope === 'per-environment' && (
                          <span className="text-[10px] text-muted-foreground mt-0.5 block">
                            Per environment ({plan.environments.length})
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className="min-w-0 flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {canRunCurrent && (
            <button
              type="button"
              onClick={() => void runCurrentStep()}
              disabled={isRunning}
              className="inline-flex items-center gap-2 rounded-lg bg-primary text-primary-foreground px-3 py-2 text-xs font-bold disabled:opacity-50"
            >
              {isRunning ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
              {isRunning ? 'Running...' : isTeardown ? 'Confirm Deletion' : 'Run Step'}
            </button>
          )}

          {isUserAction && currentStatus !== 'completed' && (
            <button
              type="button"
              onClick={() => void submitUserAction()}
              disabled={isSubmitting || !userActionCanSubmit}
              className="inline-flex items-center gap-2 rounded-lg bg-primary text-primary-foreground px-3 py-2 text-xs font-bold disabled:opacity-50"
            >
              {isSubmitting ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
              {isSubmitting ? 'Submitting...' : 'Complete Step'}
            </button>
          )}

          {currentStatus === 'resolving' && (
            <span className="inline-flex items-center gap-1 text-xs text-cyan-600 dark:text-cyan-400 animate-pulse">
              <Zap size={12} />
              Auto-resolving gate
            </span>
          )}

          {currentStatus === 'waiting-on-user' && (
            <span className="inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
              <PauseCircle size={12} />
              Waiting for user action
            </span>
          )}

          {showSkip ? (
            <button
              type="button"
              disabled={isSkipping}
              className="inline-flex items-center gap-1 rounded-lg border border-border bg-card px-3 py-2 text-xs font-semibold text-muted-foreground hover:bg-muted/60 hover:text-foreground disabled:opacity-50"
              onClick={() => void skipStep()}
            >
              {isSkipping ? <Loader2 size={12} className="animate-spin" /> : <SkipForward size={12} />}
              {isSkipping ? 'Skipping…' : 'Skip'}
            </button>
          ) : null}

          {showRevert ? (
            <button
              type="button"
              onClick={() => void revertStep()}
              disabled={isReverting || planHasInProgress}
              title={planHasInProgress ? 'Finish in-progress steps first' : undefined}
              className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/35 bg-card px-3 py-2 text-xs font-semibold text-red-700 dark:text-red-400 hover:bg-red-500/10 disabled:opacity-50"
            >
              {isReverting ? <Loader2 size={13} className="animate-spin" /> : <Undo2 size={13} />}
              {isReverting ? 'Reverting…' : 'Revert'}
            </button>
          ) : null}

          {showRevalidate ? (
            <button
              type="button"
              onClick={() => void revalidateStep()}
              disabled={isRevalidating || planHasInProgress}
              title={planHasInProgress ? 'Finish in-progress steps first' : undefined}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-xs font-semibold text-muted-foreground hover:bg-muted/60 hover:text-foreground disabled:opacity-50"
            >
              {isRevalidating ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
              {isRevalidating ? 'Checking…' : 'Revalidate'}
            </button>
          ) : null}

          {!isTeardown ? (
            <button
              type="button"
              onClick={() => void syncPlanStatus()}
              disabled={planHasInProgress || isRunning || isSyncingPlan}
              title={
                planHasInProgress
                  ? 'Wait for in-progress steps to finish'
                  : 'Walk the plan and reconcile statuses with live providers, then save (request finishes when sync is done)'
              }
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-xs font-semibold text-muted-foreground hover:bg-muted/60 hover:text-foreground disabled:opacity-50"
            >
              {isSyncingPlan ? <Loader2 size={13} className="animate-spin" /> : <ScanSearch size={13} />}
              {isSyncingPlan ? 'Syncing…' : 'Sync status'}
            </button>
          ) : null}
        </div>

        {error ? (
          <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-3 flex items-start gap-2">
            <AlertTriangle size={14} className="text-red-500 mt-0.5" />
            <p className="text-xs text-red-700 dark:text-red-300">{error}</p>
          </div>
        ) : null}

        <div className={`rounded-xl border bg-card p-5 space-y-4 ${isTeardown ? 'border-red-500/30' : 'border-border'}`}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">
                {phaseProgress.phase ? JOURNEY_PHASE_TITLE[phaseProgress.phase] : 'Setup'} — Step{' '}
                {displayIndex + 1} of {orderedNodes.length}
              </p>
              {phaseProgress.total > 0 ? (
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  {phaseProgress.done} of {phaseProgress.total} complete in this stage
                </p>
              ) : null}
              <h3 className="text-lg font-semibold mt-1">{currentNode.label}</h3>
              <p className="text-sm text-muted-foreground mt-1">{currentNode.description}</p>
              {currentBlockers.length > 0 ? (
                <div
                  className="mt-3 rounded-lg border border-amber-500/35 bg-amber-500/5 p-3"
                  role="status"
                  aria-live="polite"
                >
                  <p className="text-xs font-semibold text-amber-800 dark:text-amber-200 flex items-center gap-1.5">
                    <Lock size={12} className="shrink-0 opacity-80" />
                    Not ready yet — complete these first:
                  </p>
                  <ul className="mt-2 list-disc pl-4 text-xs text-amber-900/90 dark:text-amber-100/90 space-y-1">
                    {currentBlockers.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
            <span
              className={`text-[10px] font-bold uppercase px-2 py-1 rounded border shrink-0 ${currentStatus === 'completed'
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                  : currentStatus === 'in-progress'
                    ? 'border-primary/30 bg-primary/10 text-primary'
                    : currentStatus === 'resolving'
                      ? 'border-cyan-500/30 bg-cyan-500/10 text-cyan-600 dark:text-cyan-400'
                      : currentStatus === 'waiting-on-user'
                        ? 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400'
                        : currentStatus === 'failed'
                          ? 'border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400'
                          : 'border-border bg-muted text-muted-foreground'
                }`}
            >
              {currentStatus === 'resolving' ? 'auto-resolving' : currentStatus.replace('-', ' ')}
            </span>
          </div>

          {isTeardown && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-3 flex items-start gap-2">
              <ShieldAlert size={14} className="text-red-500 mt-0.5" />
              <p className="text-xs text-red-700 dark:text-red-300">
                This is a destructive teardown step. Confirm resource ownership before continuing.
              </p>
            </div>
          )}

          {currentNode.type === 'step' &&
            !isTeardown &&
            (currentNode as ProvisioningStepNode).interactiveAction?.type === 'oauth' &&
            currentStatus !== 'completed' &&
            currentStatus !== 'skipped' && (
              <OAuthFlowPanel
                variant="embedded"
                projectId={projectId}
                label={(currentNode as ProvisioningStepNode).interactiveAction!.label}
                onCompleted={syncAndRefresh}
              />
            )}

          {(currentStatus === 'completed' || currentStatus === 'skipped') && (
            <CompletedStepArtifactsPanel
              node={currentNode}
              plan={plan}
              terminalStatus={currentStatus === 'skipped' ? 'skipped' : 'completed'}
            />
          )}

          {isUserAction && currentStatus !== 'completed' && currentStatus !== 'skipped' && (() => {
            const userNode = currentNode as UserActionNode;
            const oauthInteractive = effectiveUserActionInteractiveAction(userNode);
            const credentialVerification =
              userNode.verification.type === 'credential-upload' ? userNode.verification : null;

            return (
              <div className="space-y-3">
                {userNode.helpUrl && (
                  <a
                    href={userNode.helpUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary hover:underline"
                  >
                    <ExternalLink size={12} />
                    Open instructions
                  </a>
                )}

                {/* Interactive OAuth flow (API enriches plan; fallback matches server registry) */}
                {oauthInteractive?.type === 'oauth' && (
                  <OAuthFlowPanel
                    projectId={projectId}
                    label={oauthInteractive.label}
                    onCompleted={syncAndRefresh}
                  />
                )}

                {credentialVerification && (
                  <div className="space-y-2">
                    <label className="text-xs font-semibold">
                      {credentialVerification.secretKey}
                    </label>
                    <textarea
                      className="w-full min-h-[140px] rounded-lg border border-border bg-background px-3 py-2 text-xs font-mono resize-y"
                      placeholder="Paste the full credential payload for this step..."
                      value={credentialText}
                      onChange={(event) => setCredentialText(event.target.value)}
                    />
                  </div>
                )}

                {!credentialVerification &&
                  currentNode.produces.map((resource) => (
                    <label key={resource.key} className="block space-y-1">
                      <span className="text-xs font-semibold">{resource.label}</span>
                      <input
                        className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                        placeholder={resource.description}
                        value={resourceInputs[resource.key] ?? ''}
                        onChange={(event) =>
                          setResourceInputs((prev) => ({ ...prev, [resource.key]: event.target.value }))
                        }
                      />
                    </label>
                  ))}

                {userNode.category === 'external-configuration' && (
                  <div className="rounded-lg border border-border bg-muted/30 p-3">
                    <ol className="list-decimal pl-4 text-xs text-muted-foreground space-y-1">
                      <li>Open the provider portal for this step.</li>
                      <li>Apply the required configuration exactly as described.</li>
                      <li>Return here and mark the step complete.</li>
                    </ol>
                  </div>
                )}
              </div>
            );
          })()}

          {currentNode.type === 'step' &&
            currentNode.environmentScope === 'per-environment' &&
            currentStatus !== 'completed' &&
            currentStatus !== 'skipped' && (
            <div className="rounded-lg border border-border p-3">
              <p className="text-xs font-semibold mb-2">Environment progress</p>
              <div className="space-y-1">
                {plan.environments.map((env) => {
                  const key = getStateKey(currentNode, env);
                  const status = plan.nodeStates[key]?.status ?? 'not-started';
                  return (
                    <div key={env} className="flex items-center justify-between text-xs">
                      <span className="font-mono">{env}</span>
                      <span className="text-muted-foreground">{status}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

