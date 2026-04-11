import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Bell,
  Info,
  CheckCircle2,
  Cloud,
  Database,
  ExternalLink,
  GitBranch,
  Github,
  Globe,
  HardDrive,
  KeyRound,
  Loader2,
  Lock,
  Package,
  PauseCircle,
  Play,
  RefreshCw,
  ScanSearch,
  ShieldAlert,
  ShieldCheck,
  SkipForward,
  MinusCircle,
  Smartphone,
  Undo2,
  Upload,
  X,
  Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { api, provisioningNodeDescription } from './helpers';
import { useOAuthSession } from '../../hooks/useOAuthSession';
import { CompletedStepArtifactsPanel } from './CompletedStepArtifactsPanel';
import {
  JOURNEY_PHASE_TITLE,
  type JourneyPhaseId,
  type NodeState,
  type NodeStatus,
  type ProvisioningGraphNode,
  type ProvisioningPlanResponse,
  type ProvisioningStepNode,
  type RevertManualAction,
  type UserActionNode,
} from './types';
import { OAuthFlowPanel } from './OAuthFlowPanel';
import { effectiveUserActionInteractiveAction } from './user-action-interactive';

// ---------------------------------------------------------------------------
// Module display metadata — icon + color per module ID
// Served dynamically from plan.pluginDisplayMeta; built-in icons are loaded
// lazily so new plugins that ship their own icon names don't break here.
// ---------------------------------------------------------------------------

interface ModuleDisplayMeta {
  icon: LucideIcon;
  iconColor: string;
  bgColor: string;
  borderColor: string;
  textColor: string;
}

/** Lucide icon name → component. Only the icons used by built-in plugins need to be here. */
const ICON_MAP: Record<string, LucideIcon> = {
  Bell, Cloud, Database, GitBranch, Github, Globe, HardDrive,
  KeyRound, Package, Play, ShieldCheck, Smartphone, Upload,
};

/** Converts plugin-registry PluginDisplayMeta to local ModuleDisplayMeta */
function toModuleDisplayMeta(meta: { icon: string; colors: { text: string; bg: string; border: string } }): ModuleDisplayMeta {
  return {
    icon: ICON_MAP[meta.icon] ?? Package,
    iconColor: meta.colors.text.split(' ')[0] ?? 'text-muted-foreground',
    bgColor: meta.colors.bg,
    borderColor: meta.colors.border,
    textColor: meta.colors.text,
  };
}

const DEFAULT_MODULE_DISPLAY: ModuleDisplayMeta = {
  icon: Package,
  iconColor: 'text-muted-foreground',
  bgColor: 'bg-muted',
  borderColor: 'border-border',
  textColor: 'text-muted-foreground',
};

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
  phaseTitles?: Record<string, string>,
): SidebarGroup[] {
  const titles = phaseTitles ?? JOURNEY_PHASE_TITLE;
  const groups: SidebarGroup[] = [];
  for (let i = 0; i < orderedNodes.length; i++) {
    const node = orderedNodes[i]!;
    const phase: JourneyPhaseId = journeyPhaseByNodeKey?.[node.key] ?? 'verification';
    const label = titles[phase] ?? JOURNEY_PHASE_TITLE[phase] ?? phase;
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

/** Expo robot tokens cannot call app deletion; server still returns a generic warning line. */
function isExpoRobotDeleteRevertWarning(line: string): boolean {
  return /robot access to this api is not supported/i.test(line);
}

type PlanNodeResetResponse = ProvisioningPlanResponse & {
  revertWarnings?: string[];
  revertManualActions?: RevertManualAction[];
  needsReauth?: boolean;
  sessionId?: string;
  authUrl?: string;
};

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
  onRecomputePlan,
}: {
  projectId: string;
  plan: ProvisioningPlanResponse | null;
  onPlanChange: (plan: ProvisioningPlanResponse) => void;
  onUserActionComplete: (nodeKey: string, resources?: Record<string, string>) => Promise<void>;
  onRefresh: () => Promise<void>;
  onRecomputePlan?: () => Promise<void>;
}) {
  const [credentialText, setCredentialText] = useState('');
  const [resourceInputs, setResourceInputs] = useState<Record<string, string>>({});
  const [isRunning, setIsRunning] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isReverting, setIsReverting] = useState(false);
  const [isRevalidating, setIsRevalidating] = useState(false);
  const [isSkipping, setIsSkipping] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [syncInfo, setSyncInfo] = useState<string | null>(null);
  const [sidebarFocusIndex, setSidebarFocusIndex] = useState<number | null>(null);
  const [revertManualGuide, setRevertManualGuide] = useState<RevertManualAction[] | null>(null);
  const [manualRevertNodeKey, setManualRevertNodeKey] = useState<string | null>(null);
  const [isFinalizingManualRevert, setIsFinalizingManualRevert] = useState(false);
  const [stepInputs, setStepInputs] = useState<Record<string, string>>({});
  const [stepInputsDirty, setStepInputsDirty] = useState(false);
  const [savingStepInputs, setSavingStepInputs] = useState(false);
  const [isRecomputing, setIsRecomputing] = useState(false);

  const gcpOAuthSession = useOAuthSession({ projectId, providerId: 'gcp' });

  const applyPlanResetResponse = useCallback(
    (result: PlanNodeResetResponse, revertedNodeKey: string) => {
      onPlanChange(result);
      void onRefresh();
      const bannerWarnings =
        result.revertWarnings?.filter((w) => !isExpoRobotDeleteRevertWarning(w)) ?? [];
      if (result.revertManualActions?.length) {
        setRevertManualGuide(result.revertManualActions);
        setManualRevertNodeKey(revertedNodeKey);
        if (bannerWarnings.length === 0) {
          setSyncInfo(
            'Manual cleanup is required on expo.dev. The step will be marked reverted after you confirm Done.',
          );
        }
      } else {
        setManualRevertNodeKey(null);
      }
      if (bannerWarnings.length > 0) {
        setError(`Partial revert: ${bannerWarnings.join('; ')}`);
      } else if (result.revertWarnings?.length && !result.revertManualActions?.length) {
        setError(`Partial revert: ${result.revertWarnings.join('; ')}`);
      }
    },
    [onPlanChange, onRefresh],
  );

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
    () => buildJourneySidebarGroups(orderedNodes, plan?.journeyPhaseByNodeKey, plan?.journeyPhaseTitles),
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
    setRevertManualGuide(null);
    setManualRevertNodeKey(null);
  }, [projectId]);

  const currentNode = orderedNodes[displayIndex] ?? null;
  const currentStatus = currentNode && plan ? getNodeStatus(currentNode, plan.nodeStates, plan.environments) : 'not-started';

  const currentStepNode = currentNode?.type === 'step' ? (currentNode as ProvisioningStepNode) : null;
  const currentInputFields = currentStepNode?.inputFields?.length ? currentStepNode.inputFields : null;
  const currentNodeState = currentNode && plan ? plan.nodeStates[currentNode.key] : undefined;

  useEffect(() => {
    if (!currentInputFields) {
      setStepInputs({});
      setStepInputsDirty(false);
      return;
    }
    const saved = currentNodeState?.userInputs ?? {};
    const defaults: Record<string, string> = {};
    for (const field of currentInputFields) {
      defaults[field.key] = saved[field.key] ?? field.defaultValue ?? '';
    }
    setStepInputs(defaults);
    setStepInputsDirty(false);
  }, [currentNode?.key, currentNodeState?.userInputs]);

  const handleStepInputChange = (key: string, value: string) => {
    setStepInputs((prev) => ({ ...prev, [key]: value }));
    setStepInputsDirty(true);
  };

  const handleSaveStepInputs = async () => {
    if (!currentNode) return;
    setSavingStepInputs(true);
    setError(null);
    try {
      await api(`/api/projects/${encodeURIComponent(projectId)}/provisioning/plan/node/${encodeURIComponent(currentNode.key)}/inputs`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputs: stepInputs }),
      });
      setStepInputsDirty(false);
      await onRefresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingStepInputs(false);
    }
  };

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

  // Auto-poll while any step is in-progress so the UI updates when long-running
  // operations (e.g. GCP project creation) complete, even without a WebSocket event.
  useEffect(() => {
    if (!planHasInProgress) return;
    const id = setInterval(() => { void onRefresh(); }, 3000);
    return () => clearInterval(id);
  }, [planHasInProgress, onRefresh]);

  const stepRunnable =
    currentNode?.type === 'step' &&
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
    setSyncInfo(null);
    setIsRunning(true);
    try {
      const result = await api<{ started?: boolean; needsReauth?: boolean; sessionId?: string; authUrl?: string }>(
        `/api/projects/${encodeURIComponent(projectId)}/provisioning/plan/run/nodes`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nodeKeys: [currentNode.key] }) },
      );

      if (result.needsReauth && result.sessionId && result.authUrl) {
        // OAuth required — authenticate first, then retry the step automatically.
        const reauthStatus = await gcpOAuthSession.pollExternal(result.sessionId, result.authUrl);
        if (reauthStatus?.phase === 'completed' && reauthStatus.connected) {
          await api(`/api/projects/${encodeURIComponent(projectId)}/provisioning/plan/run/nodes`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nodeKeys: [currentNode.key] }),
          });
        } else {
          setError(gcpOAuthSession.error ?? 'Google sign-in required before running this step.');
          return;
        }
      }

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
    setSyncInfo(null);
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
    setError(null);
    setSyncInfo(null);
    setIsReverting(true);

    async function executeRevert() {
      const result = await api<PlanNodeResetResponse>(
        `/api/projects/${encodeURIComponent(projectId)}/provisioning/plan/node/reset`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nodeKey: currentNode!.key }),
        },
      );

      if (result.needsReauth && result.authUrl && result.sessionId) {
        const reauthStatus = await gcpOAuthSession.pollExternal(result.sessionId, result.authUrl);
        if (reauthStatus?.phase === 'completed' && reauthStatus.connected) {
          const retried = await api<PlanNodeResetResponse>(
            `/api/projects/${encodeURIComponent(projectId)}/provisioning/plan/node/reset`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ nodeKey: currentNode!.key }),
            },
          );
          applyPlanResetResponse(retried, currentNode!.key);
        } else {
          setError(gcpOAuthSession.error ?? 'Google re-authentication failed. Please try again.');
        }
        return;
      }

      applyPlanResetResponse(result, currentNode!.key);
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
    setSyncInfo(null);
    setIsRevalidating(true);
    const priorStatus = currentStatus;
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
        setSyncInfo(res.message ?? 'Sync is not available for this step.');
      } else if (res.results?.length) {
        const failed = res.results.filter((r) => !r.stillValid);
        if (failed.length > 0) {
          if (priorStatus === 'completed') {
            setError(
              failed.length === res.results.length
                ? 'Resource no longer exists in the provider — step has been reset.'
                : `${failed.length} environment(s) no longer exist and were reset.`,
            );
          } else {
            setSyncInfo('Not created yet — run this step to provision the resource.');
          }
        }
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsRevalidating(false);
    }
  }

  async function cancelStep() {
    if (!currentNode) return;
    setIsCancelling(true);
    setError(null);
    try {
      const updated = await api<ProvisioningPlanResponse>(
        `/api/projects/${encodeURIComponent(projectId)}/provisioning/plan/node/cancel`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nodeKey: currentNode.key }),
        },
      );
      onPlanChange(updated);
      await onRefresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsCancelling(false);
    }
  }

  async function finalizeManualRevert(): Promise<void> {
    if (!manualRevertNodeKey) {
      setRevertManualGuide(null);
      setSyncInfo(null);
      return;
    }
    setIsFinalizingManualRevert(true);
    setError(null);
    try {
      const updated = await api<ProvisioningPlanResponse>(
        `/api/projects/${encodeURIComponent(projectId)}/provisioning/plan/node/reset/manual-complete`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nodeKey: manualRevertNodeKey }),
        },
      );
      onPlanChange(updated);
      await onRefresh();
      setRevertManualGuide(null);
      setManualRevertNodeKey(null);
      setSyncInfo(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsFinalizingManualRevert(false);
    }
  }


  const showRevert =
    currentStatus === 'completed' || currentStatus === 'skipped' || currentStatus === 'failed';
  const showRevalidate =
    currentNode?.type === 'step' &&
    currentStatus !== 'in-progress' &&
    currentStatus !== 'waiting-on-user' &&
    !isTeardown;
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
    <>
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

          {isUserAction && currentStatus !== 'completed' && (() => {
            const ua = currentNode as UserActionNode;
            const verifyMode = ua.verification.type === 'api-check';
            return (
              <button
                type="button"
                onClick={() => void submitUserAction()}
                disabled={isSubmitting || !userActionCanSubmit}
                className="inline-flex items-center gap-2 rounded-lg bg-primary text-primary-foreground px-3 py-2 text-xs font-bold disabled:opacity-50"
              >
                {isSubmitting ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : verifyMode ? (
                  <ScanSearch size={13} />
                ) : (
                  <Upload size={13} />
                )}
                {isSubmitting ? 'Submitting...' : verifyMode ? 'Verify installation' : 'Complete Step'}
              </button>
            );
          })()}

          {currentStatus === 'in-progress' && !isRunning && (
            <>
              <span className="inline-flex items-center gap-1.5 text-xs text-primary animate-pulse">
                <Loader2 size={13} className="animate-spin" />
                Running — please wait…
              </span>
              <button
                type="button"
                onClick={() => void cancelStep()}
                disabled={isCancelling}
                className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/35 bg-card px-3 py-2 text-xs font-semibold text-red-700 dark:text-red-400 hover:bg-red-500/10 disabled:opacity-50"
              >
                {isCancelling ? <Loader2 size={13} className="animate-spin" /> : <MinusCircle size={13} />}
                {isCancelling ? 'Cancelling…' : 'Cancel'}
              </button>
            </>
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
              title={planHasInProgress ? 'Finish in-progress steps first' : 'Check if this step\'s resource still exists in the provider'}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-xs font-semibold text-muted-foreground hover:bg-muted/60 hover:text-foreground disabled:opacity-50"
            >
              {isRevalidating ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
              {isRevalidating ? 'Syncing…' : 'Sync'}
            </button>
          ) : null}

          {onRecomputePlan ? (
            <button
              type="button"
              onClick={() => {
                void (async () => {
                  setIsRecomputing(true);
                  setError(null);
                  setSyncInfo(null);
                  try {
                    await onRecomputePlan();
                    setSyncInfo('Plan rebuilt from latest step definitions. New steps may now appear.');
                    setSidebarFocusIndex(null);
                  } catch (err) {
                    setError((err as Error).message);
                  } finally {
                    setIsRecomputing(false);
                  }
                })();
              }}
              disabled={isRecomputing || planHasInProgress}
              title="Rebuild the plan from the latest step definitions while preserving completed state"
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-xs font-semibold text-muted-foreground hover:bg-muted/60 hover:text-foreground disabled:opacity-50"
            >
              {isRecomputing ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
              {isRecomputing ? 'Rebuilding…' : 'Rebuild Plan'}
            </button>
          ) : null}
        </div>

        {error ? (
          <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-3 flex items-start gap-2">
            <AlertTriangle size={14} className="text-red-500 mt-0.5" />
            <p className="text-xs text-red-700 dark:text-red-300">{error}</p>
          </div>
        ) : null}

        {syncInfo ? (
          <div className="rounded-lg border border-border bg-muted/40 p-3 flex items-start gap-2">
            <Info size={14} className="text-muted-foreground mt-0.5 shrink-0" />
            <p className="text-xs text-muted-foreground">{syncInfo}</p>
          </div>
        ) : null}

        <div className={`rounded-xl border bg-card overflow-hidden ${isTeardown ? 'border-red-500/30' : 'border-border'}`}>
          {(() => {
            const moduleId = plan.moduleByNodeKey?.[currentNode.key];
            const moduleLabel = moduleId ? (plan.moduleLabelById?.[moduleId] ?? moduleId) : null;
            if (!moduleLabel || !moduleId) return null;
            const rawMeta = plan.pluginDisplayMeta?.[moduleId];
            const meta = rawMeta ? toModuleDisplayMeta(rawMeta) : DEFAULT_MODULE_DISPLAY;
            const ModuleIcon = meta.icon;
            return (
              <div className={`flex items-center gap-2 px-4 py-2 border-b ${meta.bgColor} ${meta.borderColor}`}>
                <ModuleIcon size={12} className={`shrink-0 ${meta.iconColor}`} />
                <span className={`text-[11px] font-semibold ${meta.textColor}`}>{moduleLabel}</span>
              </div>
            );
          })()}
          <div className="p-5 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">
                {phaseProgress.phase ? (plan?.journeyPhaseTitles?.[phaseProgress.phase] ?? JOURNEY_PHASE_TITLE[phaseProgress.phase] ?? phaseProgress.phase) : 'Setup'} — Step{' '}
                {displayIndex + 1} of {orderedNodes.length}
              </p>
              {phaseProgress.total > 0 ? (
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  {phaseProgress.done} of {phaseProgress.total} complete in this stage
                </p>
              ) : null}
              <h3 className="text-lg font-semibold mt-1">{currentNode.label}</h3>
              <p className="text-sm text-muted-foreground mt-1">
                {provisioningNodeDescription(currentNode, plan.environments)}
              </p>
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

          {currentInputFields && currentStatus !== 'completed' && currentStatus !== 'skipped' && (
            <div className="rounded-lg border border-border p-4 space-y-3">
              <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Configuration</p>
              {currentInputFields.map((field) => (
                <div key={field.key} className="space-y-1.5">
                  <label className="text-xs font-semibold text-foreground">
                    {field.label}
                    {field.required && <span className="text-red-500 ml-0.5">*</span>}
                  </label>
                  {field.description && (
                    <p className="text-[11px] text-muted-foreground leading-snug">{field.description}</p>
                  )}
                  {field.type === 'select' && field.options ? (
                    <select
                      value={stepInputs[field.key] ?? field.defaultValue ?? ''}
                      onChange={(e) => handleStepInputChange(field.key, e.target.value)}
                      className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none"
                    >
                      {field.options.map((opt) => (
                        <option key={opt} value={opt}>{opt}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text"
                      value={stepInputs[field.key] ?? ''}
                      onChange={(e) => handleStepInputChange(field.key, e.target.value)}
                      placeholder={field.placeholder}
                      className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none"
                    />
                  )}
                </div>
              ))}
              <button
                type="button"
                disabled={savingStepInputs || !stepInputsDirty}
                onClick={() => void handleSaveStepInputs()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-primary/10 border border-primary/30 px-3 py-2 text-xs font-bold text-primary hover:bg-primary/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {savingStepInputs ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
                {savingStepInputs ? 'Saving…' : stepInputsDirty ? 'Save Configuration' : 'Configuration Saved'}
              </button>
            </div>
          )}

          {currentInputFields && (currentStatus === 'completed' || currentStatus === 'skipped') && currentNodeState?.userInputs && (
            <div className="rounded-lg border border-border p-4 space-y-2">
              <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Configuration</p>
              <div className="flex flex-wrap gap-2">
                {currentInputFields.map((field) => {
                  const val = currentNodeState.userInputs?.[field.key] ?? field.defaultValue ?? '';
                  return (
                    <span key={field.key} className="inline-flex items-center gap-1.5 text-xs font-mono bg-muted border border-border px-2 py-1 rounded text-foreground" title={field.description}>
                      <span className="text-[10px] text-muted-foreground/70">{field.label}:</span>
                      <span>{val}</span>
                    </span>
                  );
                })}
              </div>
            </div>
          )}

          {currentStatus === 'failed' && (() => {
            const failedError =
              currentNode.type === 'step' && currentNode.environmentScope === 'per-environment'
                ? plan.environments
                    .map((env) => plan.nodeStates[`${currentNode.key}@${env}`]?.error)
                    .find(Boolean)
                : plan.nodeStates[currentNode.key]?.error;
            if (!failedError) return null;

            const urlRegex = /(https?:\/\/[^\s]+)/g;
            const parts = failedError.split(urlRegex);

            return (
              <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 space-y-3">
                <div className="flex items-start gap-2">
                  <AlertTriangle size={14} className="text-red-500 mt-0.5 shrink-0" />
                  <div className="text-sm text-red-800 dark:text-red-200 space-y-2 min-w-0">
                    {parts.map((part, i) =>
                      urlRegex.test(part) ? (
                        <a
                          key={i}
                          href={part}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-primary font-semibold hover:underline break-all"
                        >
                          <ExternalLink size={12} className="shrink-0" />
                          {part}
                        </a>
                      ) : (
                        <span key={i} className="whitespace-pre-wrap">{part}</span>
                      ),
                    )}
                  </div>
                </div>
              </div>
            );
          })()}

          {isTeardown && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-3 flex items-start gap-2">
              <ShieldAlert size={14} className="text-red-500 mt-0.5" />
              <p className="text-xs text-red-700 dark:text-red-300">
                This is a destructive teardown step. Confirm resource ownership before continuing.
              </p>
            </div>
          )}

          {/* OAuth step nodes: the RUN button triggers OAuth automatically when needed. */}

          {currentNode.type === 'step' && currentNode.produces.length > 0 && (
            <CompletedStepArtifactsPanel
              node={currentNode}
              plan={plan}
              stepStatus={currentStatus}
            />
          )}

          {(currentNode.type === 'user-action' || (currentNode.type === 'step' && currentNode.produces.length === 0)) &&
            (currentStatus === 'completed' || currentStatus === 'skipped') && (
            <CompletedStepArtifactsPanel
              node={currentNode}
              plan={plan}
              stepStatus={currentStatus}
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
                      <li>
                        {userNode.verification.type === 'api-check'
                          ? 'Return here and click Verify installation — Studio checks Expo before completing this step.'
                          : 'Return here and mark the step complete.'}
                      </li>
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
              <div className="space-y-1.5">
                {plan.environments.map((env) => {
                  const key = getStateKey(currentNode, env);
                  const status = plan.nodeStates[key]?.status ?? 'not-started';
                  const icon = status === 'completed'
                    ? <CheckCircle2 size={12} className="text-emerald-500 shrink-0" />
                    : status === 'in-progress'
                      ? <Loader2 size={12} className="text-primary animate-spin shrink-0" />
                      : status === 'failed'
                        ? <AlertTriangle size={12} className="text-red-500 shrink-0" />
                        : status === 'skipped'
                          ? <SkipForward size={12} className="text-muted-foreground shrink-0" />
                          : <span className="w-2 h-2 rounded-full bg-muted-foreground/30 block shrink-0" />;
                  const labelColor = status === 'completed' ? 'text-emerald-600 dark:text-emerald-400'
                    : status === 'in-progress' ? 'text-primary'
                    : status === 'failed' ? 'text-red-600 dark:text-red-400'
                    : 'text-muted-foreground';
                  return (
                    <div key={env} className="flex items-center gap-2 text-xs">
                      {icon}
                      <span className="font-mono flex-1">{env}</span>
                      <span className={`text-[10px] font-medium ${labelColor}`}>{humanizeStatus(status)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          </div>
        </div>
      </div>
    </div>

    {revertManualGuide && revertManualGuide.length > 0 ? (
      <div
        className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4"
        role="dialog"
        aria-modal="true"
        aria-labelledby="revert-manual-title"
      >
        <div className="w-full max-w-md rounded-xl border border-border bg-card shadow-lg">
          <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
            <div className="min-w-0">
              <h2 id="revert-manual-title" className="text-base font-semibold text-foreground">
                Manual step required
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Studio could not complete this cleanup with your current Expo token.
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                setRevertManualGuide(null);
                setManualRevertNodeKey(null);
                setSyncInfo(null);
              }}
              className="shrink-0 rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="Close"
            >
              <X size={18} />
            </button>
          </div>
          <div className="max-h-[min(60vh,420px)] overflow-y-auto px-5 py-4 space-y-5">
            {revertManualGuide.map((action) => (
              <div key={action.stepKey} className="space-y-2">
                <h3 className="text-sm font-semibold text-foreground">{action.title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{action.body}</p>
                <a
                  href={action.primaryUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary hover:underline"
                >
                  <ExternalLink size={14} />
                  {action.primaryLabel}
                </a>
              </div>
            ))}
          </div>
          <div className="border-t border-border px-5 py-3 flex justify-end gap-2">
            <button
              type="button"
              disabled={isFinalizingManualRevert}
              onClick={() => {
                setRevertManualGuide(null);
                setManualRevertNodeKey(null);
                setSyncInfo(null);
              }}
              className="rounded-lg border border-border bg-card px-4 py-2 text-xs font-semibold text-muted-foreground hover:bg-muted disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={isFinalizingManualRevert}
              onClick={() => { void finalizeManualRevert(); }}
              className="rounded-lg bg-primary px-4 py-2 text-xs font-bold text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {isFinalizingManualRevert ? 'Finalizing…' : 'Done'}
            </button>
          </div>
        </div>
      </div>
    ) : null}
    </>
  );
}

