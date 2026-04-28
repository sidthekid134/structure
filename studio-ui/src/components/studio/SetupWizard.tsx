import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Bell,
  Info,
  CheckCircle2,
  Copy,
  ChevronDown,
  ChevronRight,
  Cloud,
  Database,
  Download,
  ExternalLink,
  GitBranch,
  Github,
  Globe,
  HardDrive,
  KeyRound,
  ListChecks,
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
import { StepSecretsPanel, stepHasVaultSecrets } from './StepSecretsPanel';
import { P8FileInput, extractKeyIdFromP8FileName } from './P8FileInput';
import {
  JOURNEY_PHASE_TITLE,
  type JourneyPhaseId,
  type ManualInstructions,
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

function getNodeInvalidation(
  node: ProvisioningGraphNode,
  nodeStates: Record<string, NodeState>,
  environments: string[],
): {
  isInvalidated: boolean;
  by?: string;
  reason?: string;
  environments?: string[];
} {
  if (node.type === 'step' && node.environmentScope === 'per-environment') {
    const invalidated = environments
      .map((env) => ({ env, state: nodeStates[`${node.key}@${env}`] }))
      .filter(({ state }) => Boolean(state?.invalidatedBy));
    if (invalidated.length === 0) return { isInvalidated: false };
    const first = invalidated[0]!.state!;
    return {
      isInvalidated: true,
      by: first.invalidatedBy,
      reason: first.error,
      environments: invalidated.map(({ env }) => env),
    };
  }
  const state = nodeStates[node.key];
  if (!state?.invalidatedBy) return { isInvalidated: false };
  return {
    isInvalidated: true,
    by: state.invalidatedBy,
    reason: state.error,
  };
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

const REFRESHABLE_STEP_FALLBACK_KEYS = new Set<string>([
  'apple:store-signing-in-eas',
  'oauth:register-oauth-client-ios',
  'oauth:register-oauth-client-android',
  'oauth:prepare-app-integration-kit',
]);

/**
 * Structured information about a single unmet dependency. Surfaced in the
 * "Not ready yet — complete these first" panel so the user can click through
 * to the upstream step instead of having to hunt for it in the sidebar.
 */
interface DependencyBlocker {
  /** Node key of the upstream dependency (used to navigate back to it). */
  nodeKey: string;
  /** Human-readable label of the upstream node. */
  label: string;
  /** Per-environment instance this blocker applies to, when relevant. */
  environment?: string;
  /** Humanised status of the upstream node (e.g. "not started", "failed"). */
  statusText: string;
}

/**
 * Required dependencies for one execution context (global node, or one per-env instance).
 */
function getBlockersForInstance(
  node: ProvisioningGraphNode,
  instanceEnv: string | undefined,
  plan: ProvisioningPlanResponse,
): DependencyBlocker[] {
  const nodeMap = new Map(plan.nodes.map((n) => [n.key, n]));
  const reasons: DependencyBlocker[] = [];

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
          reasons.push({
            nodeKey: dep.nodeKey,
            label: depNode.label,
            environment: instanceEnv,
            statusText: humanizeStatus(st),
          });
        }
      } else {
        for (const env of plan.environments) {
          const sk = `${dep.nodeKey}@${env}`;
          const st = plan.nodeStates[sk]?.status ?? 'not-started';
          if (!statusIsDone(st)) {
            reasons.push({
              nodeKey: dep.nodeKey,
              label: depNode.label,
              environment: env,
              statusText: humanizeStatus(st),
            });
          }
        }
      }
    } else {
      const st = plan.nodeStates[dep.nodeKey]?.status ?? 'not-started';
      if (!statusIsDone(st)) {
        reasons.push({
          nodeKey: dep.nodeKey,
          label: depNode.label,
          statusText: humanizeStatus(st),
        });
      }
    }
  }

  return reasons;
}

/**
 * Blockers for the next work on this node (first per-env instance that is not done and cannot run yet, or global).
 */
function getDependencyBlockers(node: ProvisioningGraphNode, plan: ProvisioningPlanResponse): DependencyBlocker[] {
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

/**
 * Collapsible "Manual steps required" panel.
 *
 * The instructions are still authored as if the user is about to perform them
 * (they double as a runbook for re-runs / audit), but once the step is
 * `completed` or `skipped` we don't want them eating vertical space above the
 * artifacts panel — the user has already finished the work. We default to
 * collapsed in that case while leaving an explicit chevron for re-opening.
 *
 * For any other status (in-progress, waiting-on-user, failed, blocked,
 * not-started) we default to expanded so the user sees the next action
 * without an extra click.
 *
 * Per-step open state is tracked via `nodeKey` so navigating between steps
 * doesn't sticky a stale toggle, and so re-opening the same step preserves
 * whatever the user manually toggled within this session.
 */
function ManualInstructionsPanel({
  nodeKey,
  manual,
  status,
}: {
  nodeKey: string;
  manual: ManualInstructions;
  status: NodeStatus;
}) {
  const isFinished = status === 'completed' || status === 'skipped';
  const [openOverride, setOpenOverride] = useState<boolean | null>(null);
  const [copyingDownloadKey, setCopyingDownloadKey] = useState<string | null>(null);
  const [copiedDownloadKey, setCopiedDownloadKey] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);

  // Reset the override whenever we navigate to a different step so each step
  // starts from its status-driven default again.
  useEffect(() => {
    setOpenOverride(null);
    setCopyingDownloadKey(null);
    setCopiedDownloadKey(null);
    setCopyError(null);
  }, [nodeKey]);

  const isOpen = openOverride ?? !isFinished;
  const isPromptDownload = (url: string): boolean => url.includes('/integration-kit/auth/prompt');

  const copyPromptDownload = async (downloadUrl: string, downloadKey: string) => {
    setCopyError(null);
    setCopyingDownloadKey(downloadKey);
    try {
      const response = await fetch(downloadUrl, { cache: 'no-store' });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        let message = response.statusText || 'Failed to fetch prompt text.';
        if (body) {
          try {
            const parsed = JSON.parse(body) as { error?: string };
            message = parsed.error || message;
          } catch {
            message = body;
          }
        }
        throw new Error(message);
      }
      const promptText = await response.text();
      await navigator.clipboard.writeText(promptText);
      setCopiedDownloadKey(downloadKey);
      window.setTimeout(() => {
        setCopiedDownloadKey((current) => (current === downloadKey ? null : current));
      }, 1600);
    } catch (err) {
      setCopyError((err as Error).message || 'Failed to copy prompt.');
    } finally {
      setCopyingDownloadKey(null);
    }
  };

  return (
    <div className="rounded-lg border border-blue-500/30 bg-blue-500/5">
      <button
        type="button"
        onClick={() => setOpenOverride(!isOpen)}
        className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-blue-500/10 rounded-lg transition-colors"
        aria-expanded={isOpen}
      >
        {isOpen ? (
          <ChevronDown size={14} className="text-blue-700 dark:text-blue-300 shrink-0" />
        ) : (
          <ChevronRight size={14} className="text-blue-700 dark:text-blue-300 shrink-0" />
        )}
        <ListChecks size={14} className="text-blue-700 dark:text-blue-300 shrink-0" />
        <span className="text-[11px] font-bold uppercase tracking-wide text-blue-700 dark:text-blue-300 flex-1">
          {isFinished ? 'Manual steps (completed)' : 'Manual steps required'}
        </span>
        <span className="text-[10px] font-medium text-blue-700/70 dark:text-blue-300/70">
          {manual.steps.length} step{manual.steps.length === 1 ? '' : 's'}
        </span>
      </button>
      {isOpen ? (
        <div className="px-4 pb-4 space-y-3">
          {manual.intro ? (
            <p className="text-xs text-blue-900/90 dark:text-blue-100/90 leading-relaxed pl-6">
              {manual.intro}
            </p>
          ) : null}
          <ol className="space-y-2 pl-1">
            {manual.steps.map((step, idx) => (
              <li key={`${nodeKey}-manual-${idx}`} className="flex items-start gap-2.5">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-500/15 text-[10px] font-bold text-blue-700 dark:text-blue-300">
                  {idx + 1}
                </span>
                <div className="space-y-1 min-w-0">
                  <p className="text-sm text-foreground leading-snug">{step.title}</p>
                  {step.detail ? (
                    step.detail.startsWith('http://') || step.detail.startsWith('https://') ? (
                      <a
                        href={step.detail}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs font-mono text-blue-700 dark:text-blue-300 hover:underline break-all"
                      >
                        <ExternalLink size={10} className="opacity-70 shrink-0" />
                        {step.detail}
                      </a>
                    ) : (
                      <p className="text-[11px] text-muted-foreground leading-snug">{step.detail}</p>
                    )
                  ) : null}
                  {step.downloads && step.downloads.length > 0 ? (
                    <div className="flex flex-col gap-1.5 pt-1">
                      {step.downloads.map((download, dIdx) => (
                        <div
                          key={`${nodeKey}-manual-${idx}-dl-${dIdx}`}
                          className="flex flex-col gap-0.5"
                        >
                          <div className="flex flex-wrap items-center gap-1.5">
                            <a
                              href={download.url}
                              download={download.filename}
                              className="inline-flex items-center gap-1.5 self-start rounded-md border border-blue-500/40 bg-blue-500/10 px-2.5 py-1.5 text-xs font-semibold font-mono text-blue-700 dark:text-blue-300 hover:bg-blue-500/20 transition-colors"
                            >
                              <Download size={11} className="shrink-0" />
                              {download.filename}
                            </a>
                            {isPromptDownload(download.url) ? (
                              <button
                                type="button"
                                onClick={() =>
                                  void copyPromptDownload(
                                    download.url,
                                    `${nodeKey}-manual-${idx}-dl-${dIdx}`,
                                  )
                                }
                                disabled={copyingDownloadKey === `${nodeKey}-manual-${idx}-dl-${dIdx}`}
                                className="inline-flex items-center gap-1 rounded-md border border-blue-500/40 bg-blue-500/10 px-2 py-1.5 text-[11px] font-semibold text-blue-700 dark:text-blue-300 hover:bg-blue-500/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                title="Copy prompt text to clipboard"
                              >
                                {copyingDownloadKey === `${nodeKey}-manual-${idx}-dl-${dIdx}` ? (
                                  <Loader2 size={11} className="animate-spin shrink-0" />
                                ) : (
                                  <Copy size={11} className="shrink-0" />
                                )}
                                {copiedDownloadKey === `${nodeKey}-manual-${idx}-dl-${dIdx}`
                                  ? 'Copied'
                                  : 'Copy'}
                              </button>
                            ) : null}
                          </div>
                          {download.description ? (
                            <p className="text-[11px] text-muted-foreground leading-snug">
                              {download.description}
                            </p>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
          {manual.note ? (
            <p className="text-[11px] italic text-blue-900/70 dark:text-blue-100/70 leading-snug border-t border-blue-500/20 pt-2">
              {manual.note}
            </p>
          ) : null}
          {copyError ? (
            <p className="text-[11px] text-red-600 dark:text-red-400 leading-snug border-t border-red-500/20 pt-2">
              {copyError}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
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
  const currentInvalidation = useMemo(() => {
    if (!currentNode || !plan) return { isInvalidated: false } as const;
    return getNodeInvalidation(currentNode, plan.nodeStates, plan.environments);
  }, [currentNode, plan]);

  const currentStepNode = currentNode?.type === 'step' ? (currentNode as ProvisioningStepNode) : null;
  const currentInputFields = currentStepNode?.inputFields?.length ? currentStepNode.inputFields : null;
  const currentNodeState = currentNode && plan ? plan.nodeStates[currentNode.key] : undefined;
  const [githubOwnerOptions, setGithubOwnerOptions] = useState<string[]>([]);
  const [refreshingGithubOwners, setRefreshingGithubOwners] = useState(false);

  useEffect(() => {
    if (!currentInputFields) {
      setStepInputs({});
      setStepInputsDirty(false);
      return;
    }
    const saved = currentNodeState?.userInputs ?? {};
    const defaults: Record<string, string> = {};
    const declaredFieldKeys = new Set(currentInputFields.map((field) => field.key));
    for (const field of currentInputFields) {
      defaults[field.key] = saved[field.key] ?? field.defaultValue ?? '';
    }
    // Preserve side-channel inputs not declared in inputFields (e.g.
    // apple_auth_key_id set by the reuse-key picker) so Save/Run does not
    // accidentally wipe them from nodeState.userInputs.
    for (const [key, value] of Object.entries(saved)) {
      if (!declaredFieldKeys.has(key)) defaults[key] = value;
    }
    setStepInputs(defaults);
    setStepInputsDirty(false);
  }, [currentNode?.key, currentNodeState?.userInputs]);

  const handleStepInputChange = (key: string, value: string) => {
    setStepInputs((prev) => ({ ...prev, [key]: value }));
    setStepInputsDirty(true);
  };

  /**
   * Persist the current `stepInputs` map for the active node. Returns true on
   * success so callers (e.g. runCurrentStep) can chain a follow-up action
   * without racing against the "dirty" flag.
   */
  const persistStepInputs = useCallback(async (): Promise<boolean> => {
    if (!currentNode) return false;
    try {
      await api(`/api/projects/${encodeURIComponent(projectId)}/provisioning/plan/node/${encodeURIComponent(currentNode.key)}/inputs`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputs: stepInputs }),
      });
      setStepInputsDirty(false);
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    }
  }, [currentNode, projectId, stepInputs]);

  const handleSaveStepInputs = async () => {
    setSavingStepInputs(true);
    setError(null);
    try {
      const ok = await persistStepInputs();
      if (ok) await onRefresh();
    } finally {
      setSavingStepInputs(false);
    }
  };

  const refreshGithubOwnerOptions = useCallback(async () => {
    setRefreshingGithubOwners(true);
    try {
      const result = await api<{
        connected?: boolean;
        details?: { username?: string; orgNames?: string[] };
      }>('/api/integrations/github/connection');
      const username = result.details?.username?.trim() ?? '';
      const orgNames = (result.details?.orgNames ?? [])
        .map((name) => name.trim())
        .filter(Boolean);
      const options = Array.from(new Set([username, ...orgNames].filter(Boolean)));
      setGithubOwnerOptions(options);
      if (options.length > 0) {
        setStepInputs((prev) => {
          const current = prev['github_owner']?.trim();
          if (current) return prev;
          return { ...prev, github_owner: options[0] };
        });
        setStepInputsDirty(true);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRefreshingGithubOwners(false);
    }
  }, []);

  useEffect(() => {
    if (!currentInputFields?.some((field) => field.key === 'github_owner')) {
      setGithubOwnerOptions([]);
      return;
    }
    void refreshGithubOwnerOptions();
  }, [currentNode?.key, currentInputFields, refreshGithubOwnerOptions]);

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
    if (!plan || !currentNode) return [] as DependencyBlocker[];
    return getDependencyBlockers(currentNode, plan);
  }, [plan, currentNode]);

  /**
   * Navigate the wizard to the upstream dependency the user clicked on so they
   * can resolve it without scanning the sidebar. We resolve by node key
   * against the canonically-ordered list (environment scope is intentionally
   * ignored — the wizard renders a single panel per node and surfaces
   * per-environment progress inside that panel).
   */
  const focusNodeByKey = useCallback(
    (nodeKey: string) => {
      const idx = orderedNodes.findIndex((n) => n.key === nodeKey);
      if (idx >= 0) setSidebarFocusIndex(idx);
    },
    [orderedNodes],
  );

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
  const stepSupportsRefresh =
    currentNode?.type === 'step' &&
    currentNode.automationLevel !== 'manual' &&
    (Boolean(currentNode.refreshTriggers?.length) ||
      REFRESHABLE_STEP_FALLBACK_KEYS.has(currentNode.key));
  const showCompletedRefreshAction =
    Boolean(stepSupportsRefresh) &&
    currentStatus === 'completed' &&
    !planHasInProgress &&
    !isTeardown;
  const canRunCurrent = Boolean(stepRunnable);
  const isUserAction = currentNode?.type === 'user-action';
  const userActionCanSubmit =
    isUserAction &&
    currentStatus !== 'completed' &&
    userActionDepsSatisfied(currentNode, plan!);

  const runIntentForNodeKey = useCallback((nodeKey: string): 'create' | 'refresh' => {
    if (!plan) return 'create';
    const direct = plan.nodeStates[nodeKey];
    if (direct?.invalidatedBy) return 'refresh';
    const hasPerEnvInvalidation = Object.entries(plan.nodeStates).some(
      ([stateKey, state]) =>
        stateKey.startsWith(`${nodeKey}@`) && Boolean(state.invalidatedBy),
    );
    return hasPerEnvInvalidation ? 'refresh' : 'create';
  }, [plan]);

  async function runCurrentStep(forcedIntent?: 'create' | 'refresh') {
    if (!currentNode || currentNode.type !== 'step') return;
    setError(null);
    setSyncInfo(null);
    setIsRunning(true);
    try {
      // Auto-persist any unsaved input edits before kicking off the run.
      // The backend executor reads from the persisted userInputs (not the
      // wizard's in-memory state), so without this the run can silently
      // no-op when the user uploads a file and immediately clicks Run.
      // For Apple Auth Key steps in particular the executor IS just a
      // "verify file + write to vault + mark complete" path, so the saved
      // inputs are the only signal that drives the work.
      if (stepInputsDirty) {
        const ok = await persistStepInputs();
        if (!ok) return;
      }

      const intent = forcedIntent ?? runIntentForNodeKey(currentNode.key);
      const result = await api<{ started?: boolean; needsReauth?: boolean; sessionId?: string; authUrl?: string }>(
        `/api/projects/${encodeURIComponent(projectId)}/provisioning/plan/run/nodes`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nodeKeys: [currentNode.key], intent }),
        },
      );

      if (result.needsReauth && result.sessionId && result.authUrl) {
        // OAuth required — authenticate first, then retry the step automatically.
        const reauthStatus = await gcpOAuthSession.pollExternal(result.sessionId, result.authUrl);
        if (reauthStatus?.phase === 'completed' && reauthStatus.connected) {
          await api(`/api/projects/${encodeURIComponent(projectId)}/provisioning/plan/run/nodes`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nodeKeys: [currentNode.key], intent }),
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
    if (!currentNode) return;
    if (currentNode.type === 'user-action') {
      setError(null);
      setSyncInfo(null);
      setIsRevalidating(true);
      try {
        const res = await api<{ ok: boolean; needsReauth?: boolean; sessionId?: string; authUrl?: string }>(
          `/api/projects/${encodeURIComponent(projectId)}/provisioning/plan/sync`,
          { method: 'POST' },
        );
        if (res.needsReauth && res.authUrl && res.sessionId) {
          const reauthStatus = await gcpOAuthSession.pollExternal(res.sessionId, res.authUrl);
          if (reauthStatus?.phase === 'completed' && reauthStatus.connected) {
            await api(`/api/projects/${encodeURIComponent(projectId)}/provisioning/plan/sync`, { method: 'POST' });
          } else {
            setError(gcpOAuthSession.error ?? 'Google re-authentication failed. Please try again.');
            return;
          }
        }
        await onRefresh();
        setSyncInfo('Sync complete.');
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setIsRevalidating(false);
      }
      return;
    }
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
        needsReauth?: boolean;
        sessionId?: string;
        authUrl?: string;
      }>(`/api/projects/${encodeURIComponent(projectId)}/provisioning/plan/node/revalidate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodeKey: currentNode.key }),
      });
      if (res.needsReauth && res.authUrl && res.sessionId) {
        const reauthStatus = await gcpOAuthSession.pollExternal(res.sessionId, res.authUrl);
        if (reauthStatus?.phase === 'completed' && reauthStatus.connected) {
          const retried = await api<{
            supported: boolean;
            message?: string;
            plan: ProvisioningPlanResponse;
            results?: Array<{ environment?: string; stillValid: boolean }>;
          }>(`/api/projects/${encodeURIComponent(projectId)}/provisioning/plan/node/revalidate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nodeKey: currentNode.key }),
          });
          onPlanChange(retried.plan);
          await onRefresh();
          if (!retried.supported) {
            setSyncInfo(retried.message ?? 'Sync is not available for this step.');
          } else if (retried.results?.length) {
            const failed = retried.results.filter((r) => !r.stillValid);
            if (failed.length > 0) {
              if (priorStatus === 'completed') {
                setError(
                  failed.length === retried.results.length
                    ? 'Resource no longer exists in the provider — step has been reset.'
                    : `${failed.length} environment(s) no longer exist and were reset.`,
                );
              } else {
                setSyncInfo('Not created yet — run this step to provision the resource.');
              }
            }
          }
        } else {
          setError(gcpOAuthSession.error ?? 'Google re-authentication failed. Please try again.');
        }
        return;
      }
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
    (
      (currentNode?.type === 'step' && !isTeardown) ||
      (currentNode?.type === 'user-action' &&
        currentNode.verification.type === 'api-check')
    ) &&
    currentStatus !== 'in-progress' &&
    currentStatus !== 'waiting-on-user';
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
                const stale = getNodeInvalidation(node, plan.nodeStates, plan.environments).isInvalidated;
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
                          {stale && (
                            <span className="shrink-0 text-[9px] font-bold uppercase tracking-wide text-orange-700 dark:text-orange-300 bg-orange-500/15 border border-orange-500/30 px-1 py-px rounded">
                              Stale
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
              title={currentInvalidation.isInvalidated ? 'Re-run this step in refresh mode' : undefined}
              className="inline-flex items-center gap-2 rounded-lg bg-primary text-primary-foreground px-3 py-2 text-xs font-bold disabled:opacity-50"
            >
              {isRunning ? (
                <Loader2 size={13} className="animate-spin" />
              ) : currentInvalidation.isInvalidated ? (
                <RefreshCw size={13} />
              ) : (
                <Play size={13} />
              )}
              {isRunning
                ? 'Running...'
                : isTeardown
                  ? 'Confirm Deletion'
                  : currentInvalidation.isInvalidated
                    ? 'Refresh Step'
                    : 'Run Step'}
            </button>
          )}
          {showCompletedRefreshAction && (
            <button
              type="button"
              onClick={() => void runCurrentStep('refresh')}
              disabled={isRunning}
              title="Rotate and rebind this step using refresh mode"
              className="inline-flex items-center gap-2 rounded-lg border border-primary/35 bg-primary/10 text-primary px-3 py-2 text-xs font-bold hover:bg-primary/15 disabled:opacity-50"
            >
              {isRunning ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <RefreshCw size={13} />
              )}
              {isRunning ? 'Refreshing...' : 'Refresh'}
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
              {currentInvalidation.isInvalidated ? (
                <div className="mt-3 rounded-lg border border-orange-500/35 bg-orange-500/5 p-3">
                  <p className="text-xs font-semibold text-orange-800 dark:text-orange-200 flex items-center gap-1.5">
                    <RefreshCw size={12} className="shrink-0" />
                    Refresh required
                  </p>
                  <p className="text-xs text-orange-900/80 dark:text-orange-100/80 mt-1 leading-snug">
                    {currentInvalidation.reason || 'This step was marked stale and must be re-run.'}
                    {currentInvalidation.by ? ` Triggered by: ${currentInvalidation.by}.` : ''}
                    {currentInvalidation.environments?.length
                      ? ` Affected envs: ${currentInvalidation.environments.join(', ')}.`
                      : ''}
                  </p>
                </div>
              ) : null}
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
                  <ul className="mt-2 space-y-1">
                    {currentBlockers.map((blocker, idx) => {
                      const targetIndex = orderedNodes.findIndex((n) => n.key === blocker.nodeKey);
                      const canNavigate = targetIndex >= 0;
                      const key = `${blocker.nodeKey}-${blocker.environment ?? 'global'}-${idx}`;
                      return (
                        <li key={key}>
                          <button
                            type="button"
                            disabled={!canNavigate}
                            onClick={() => {
                              if (canNavigate) focusNodeByKey(blocker.nodeKey);
                            }}
                            title={canNavigate ? 'Open this step' : undefined}
                            className="group w-full flex items-center gap-2 rounded-md border border-transparent px-2 py-1 text-left text-xs text-amber-900/90 dark:text-amber-100/90 transition-colors hover:border-amber-500/40 hover:bg-amber-500/10 focus:outline-none focus-visible:border-amber-500/60 focus-visible:bg-amber-500/15 disabled:cursor-not-allowed disabled:opacity-70 disabled:hover:border-transparent disabled:hover:bg-transparent"
                          >
                            <span className="flex-1 leading-snug">
                              <span className="font-semibold underline decoration-amber-500/30 decoration-dotted underline-offset-2 group-hover:decoration-amber-500/70 group-disabled:no-underline">
                                {blocker.label}
                              </span>
                              {blocker.environment ? (
                                <span className="opacity-80"> ({blocker.environment})</span>
                              ) : null}
                              <span className="opacity-70">: {blocker.statusText}</span>
                            </span>
                            {canNavigate ? (
                              <ChevronRight
                                size={12}
                                className="shrink-0 opacity-60 transition-opacity group-hover:opacity-100"
                                aria-hidden
                              />
                            ) : null}
                          </button>
                        </li>
                      );
                    })}
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
              {currentInvalidation.isInvalidated
                ? 'stale'
                : currentStatus === 'resolving'
                  ? 'auto-resolving'
                  : currentStatus.replace('-', ' ')}
            </span>
          </div>

          {(() => {
            const manual = plan.manualInstructionsByNodeKey?.[currentNode.key];
            if (!manual || manual.steps.length === 0) return null;
            return (
              <ManualInstructionsPanel
                nodeKey={currentNode.key}
                manual={manual}
                status={currentStatus}
              />
            );
          })()}

          {(() => {
            const portalLinks = (currentNode.completionPortalLinks ?? []).filter((link) => link.href);
            if (portalLinks.length === 0) return null;
            const headingLabel =
              currentStatus === 'completed' ? 'Verify in portal' : 'Where this will appear';
            const headingHint =
              currentStatus === 'completed'
                ? 'Open these to confirm the resource exists in the provider portal.'
                : 'Open these in a new tab so you can watch the resource appear after you run this step.';
            return (
              <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-2">
                <div className="flex items-start gap-1.5">
                  <ExternalLink size={11} className="text-muted-foreground mt-1 shrink-0" />
                  <div className="space-y-0.5">
                    <p className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                      {headingLabel}
                    </p>
                    <p className="text-[11px] text-muted-foreground leading-snug">{headingHint}</p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2 pl-5">
                  {portalLinks.map((link) => (
                    <a
                      key={`${currentNode.key}-portal-${link.label}-${link.href}`}
                      href={link.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-muted/60"
                    >
                      <ExternalLink size={11} className="opacity-70" />
                      {link.label}
                    </a>
                  ))}
                </div>
              </div>
            );
          })()}

          {currentInputFields && currentStatus !== 'completed' && currentStatus !== 'skipped' && (() => {
            // Apple Auth Key picker:
            //   The APNs and Sign In with Apple steps share a single .p8 per
            //   project — Apple keys can carry multiple capabilities. The
            //   apple_auth_key_id is no longer typed by the user; it is
            //   derived from the AuthKey_<KEYID>.p8 filename Apple sets at
            //   download time. For projects that already have a vaulted key,
            //   the picker below lets the user reuse it (no .p8 upload at
            //   all — the backend just records the new capability annotation
            //   against the existing key in the unified Apple Auth Key
            //   registry).
            const isAppleAuthKeyStep =
              currentStepNode?.key === 'apple:generate-apns-key' ||
              currentStepNode?.key === 'apple:create-sign-in-key';

            const stepCapabilityInfo: Record<string, { producedKey: string; capLabel: string }> = {
              'apple:generate-apns-key': {
                producedKey: 'apple_auth_key_id_apns',
                capLabel: 'APNs',
              },
              'apple:create-sign-in-key': {
                producedKey: 'apple_auth_key_id_sign_in_with_apple',
                capLabel: 'Sign in with Apple',
              },
            };

            // Capabilities-by-key summary from OTHER Apple key steps (don't
            // self-list the current step's own typed value — that would
            // suggest reusing what the user is currently uploading).
            const appleAuthKeysSummary: Array<{ keyId: string; capabilities: string[] }> = [];
            if (isAppleAuthKeyStep && plan?.nodeStates && currentStepNode) {
              const map = new Map<string, Set<string>>();
              for (const state of Object.values(plan.nodeStates)) {
                if (state.nodeKey === currentStepNode.key) continue;
                const info = stepCapabilityInfo[state.nodeKey];
                if (!info) continue;
                const id = (
                  state.resourcesProduced?.[info.producedKey]?.trim() ||
                  state.userInputs?.['apple_auth_key_id']?.trim() ||
                  ''
                ).toUpperCase();
                if (!id) continue;
                const set = map.get(id) ?? new Set<string>();
                set.add(info.capLabel);
                map.set(id, set);
              }
              for (const [keyId, caps] of map) {
                appleAuthKeysSummary.push({ keyId, capabilities: Array.from(caps) });
              }
              appleAuthKeysSummary.sort((a, b) => a.keyId.localeCompare(b.keyId));
            }

            const selectedAuthKeyId = stepInputs['apple_auth_key_id']?.trim().toUpperCase() ?? '';
            const hasUploadedPem = Boolean(stepInputs['apple_auth_key_p8']?.trim());
            const isReusingExistingAuthKey =
              isAppleAuthKeyStep &&
              !hasUploadedPem &&
              appleAuthKeysSummary.some((k) => k.keyId === selectedAuthKeyId);

            const handleReuseAppleAuthKey = (keyId: string) => {
              setStepInputs((prev) => ({
                ...prev,
                apple_auth_key_id: keyId,
                apple_auth_key_p8: '',
              }));
              setStepInputsDirty(true);
            };

            const handleApplePemUpload = (pem: string, fileName?: string) => {
              if (!pem) {
                setStepInputs((prev) => ({
                  ...prev,
                  apple_auth_key_id: '',
                  apple_auth_key_p8: '',
                }));
                setStepInputsDirty(true);
                return;
              }
              const keyIdFromFile = extractKeyIdFromP8FileName(fileName);
              setStepInputs((prev) => ({
                ...prev,
                apple_auth_key_p8: pem,
                ...(keyIdFromFile ? { apple_auth_key_id: keyIdFromFile } : {}),
              }));
              setStepInputsDirty(true);
            };

            return (
            <div className="rounded-lg border border-border p-4 space-y-3">
              <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Configuration</p>
              {currentInputFields.map((field) => {
                const isAppleAuthP8Field = field.key === 'apple_auth_key_p8';
                if (isAppleAuthP8Field && isAppleAuthKeyStep) {
                  // Custom picker: existing-key chips + upload dropzone +
                  // "currently reusing" banner. The Key ID is wired into
                  // stepInputs.apple_auth_key_id either from the chip click
                  // or from the AuthKey_<KEYID>.p8 filename on upload.
                  const synthesizedFileName =
                    selectedAuthKeyId && hasUploadedPem
                      ? `AuthKey_${selectedAuthKeyId}.p8`
                      : undefined;
                  return (
                    <div key={field.key} className="space-y-3">
                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-foreground">
                          {field.label}
                          {field.required && <span className="text-red-500 ml-0.5">*</span>}
                        </label>
                        {field.description && (
                          <p className="text-[11px] text-muted-foreground leading-snug">{field.description}</p>
                        )}
                      </div>

                      {appleAuthKeysSummary.length > 0 && (
                        <div className="space-y-1.5">
                          <p className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                            Reuse an existing key
                          </p>
                          <div className="flex flex-wrap gap-2">
                            {appleAuthKeysSummary.map((k) => {
                              const isSelected = isReusingExistingAuthKey && k.keyId === selectedAuthKeyId;
                              return (
                                <button
                                  key={k.keyId}
                                  type="button"
                                  onClick={() => handleReuseAppleAuthKey(k.keyId)}
                                  className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-xs transition-colors ${
                                    isSelected
                                      ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                                      : 'border-border bg-card hover:bg-muted/60 text-foreground'
                                  }`}
                                >
                                  {isSelected ? (
                                    <CheckCircle2 size={12} className="shrink-0" />
                                  ) : (
                                    <KeyRound size={12} className="opacity-70 shrink-0" />
                                  )}
                                  <span className="font-mono font-semibold">{k.keyId}</span>
                                  <span className="text-[10px] text-muted-foreground/80">
                                    bears: {k.capabilities.join(', ')}
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      {isReusingExistingAuthKey ? (
                        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 flex items-start gap-2">
                          <CheckCircle2 size={14} className="text-emerald-600 dark:text-emerald-400 mt-0.5 shrink-0" />
                          <div className="space-y-1 min-w-0 flex-1">
                            <p className="text-xs font-bold text-emerald-700 dark:text-emerald-300">
                              Reusing key <span className="font-mono">{selectedAuthKeyId}</span>
                            </p>
                            <p className="text-xs text-emerald-900 dark:text-emerald-100 leading-relaxed">
                              No .p8 re-upload needed — saving will record this capability against the existing key.
                            </p>
                            <button
                              type="button"
                              onClick={() => handleReuseAppleAuthKey('')}
                              className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-300 hover:underline"
                            >
                              Pick a different key
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {appleAuthKeysSummary.length > 0 && (
                            <p className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                              — or upload a new key —
                            </p>
                          )}
                          <P8FileInput
                            value={stepInputs[field.key] ?? ''}
                            onChange={handleApplePemUpload}
                            fileName={synthesizedFileName}
                            ariaLabel={field.label}
                            requireAppleAuthKeyFileName
                          />
                        </div>
                      )}
                    </div>
                  );
                }
                return (
                <div key={field.key} className="space-y-1.5">
                  <label className="text-xs font-semibold text-foreground">
                    {field.label}
                    {field.required && <span className="text-red-500 ml-0.5">*</span>}
                  </label>
                  {field.description && (
                    <p className="text-[11px] text-muted-foreground leading-snug">{field.description}</p>
                  )}
                  {(() => {
                    if (field.type === 'p8') {
                      return (
                        <P8FileInput
                          value={stepInputs[field.key] ?? ''}
                          onChange={(pem) => handleStepInputChange(field.key, pem)}
                          ariaLabel={field.label}
                        />
                      );
                    }
                    const isGithubOwnerField = field.key === 'github_owner';
                    const selectOptions = isGithubOwnerField
                      ? githubOwnerOptions
                      : (field.options ?? []);
                    const renderSelect = (field.type === 'select' && selectOptions.length > 0) ||
                      (isGithubOwnerField && selectOptions.length > 0);
                    const value = stepInputs[field.key] ?? field.defaultValue ?? '';
                    if (renderSelect) {
                      return (
                        <div className="flex items-center gap-2">
                          <select
                            value={value}
                            onChange={(e) => handleStepInputChange(field.key, e.target.value)}
                            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none"
                          >
                            {selectOptions.map((opt) => (
                              <option key={opt} value={opt}>{opt}</option>
                            ))}
                          </select>
                          {isGithubOwnerField && (
                            <button
                              type="button"
                              onClick={() => void refreshGithubOwnerOptions()}
                              disabled={refreshingGithubOwners}
                              title="Refresh GitHub org memberships from PAT"
                              className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-2 text-xs font-semibold text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                              {refreshingGithubOwners ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                              Refresh
                            </button>
                          )}
                        </div>
                      );
                    }
                    return (
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          value={stepInputs[field.key] ?? ''}
                          onChange={(e) => handleStepInputChange(field.key, e.target.value)}
                          placeholder={field.placeholder}
                          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none"
                        />
                        {isGithubOwnerField && (
                          <button
                            type="button"
                            onClick={() => void refreshGithubOwnerOptions()}
                            disabled={refreshingGithubOwners}
                            title="Refresh GitHub org memberships from PAT"
                            className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-2 text-xs font-semibold text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            {refreshingGithubOwners ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                            Refresh
                          </button>
                        )}
                      </div>
                    );
                  })()}
                </div>
                );
              })}
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
            );
          })()}

          {currentInputFields && (currentStatus === 'completed' || currentStatus === 'skipped') && currentNodeState?.userInputs && (
            <div className="rounded-lg border border-border p-4 space-y-2">
              <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Configuration</p>
              <div className="flex flex-wrap gap-2">
                {currentInputFields.map((field) => {
                  const val = currentNodeState.userInputs?.[field.key] ?? field.defaultValue ?? '';
                  const isSecret = field.type === 'p8';
                  const reusedAppleKeyId = field.key === 'apple_auth_key_p8'
                    ? currentNodeState.userInputs?.['apple_auth_key_id']?.trim().toUpperCase()
                    : '';
                  const display = isSecret
                    ? val
                      ? `\u2713 vaulted (${val.length.toLocaleString()} chars)`
                      : reusedAppleKeyId
                        ? `\u2713 reusing ${reusedAppleKeyId}`
                        : '\u2014'
                    : val;
                  return (
                    <span key={field.key} className="inline-flex items-center gap-1.5 text-xs font-mono bg-muted border border-border px-2 py-1 rounded text-foreground" title={field.description}>
                      <span className="text-[10px] text-muted-foreground/70">{field.label}:</span>
                      <span>{display}</span>
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

          {currentNode.type === 'step' && stepHasVaultSecrets(currentNode.key) && (
            <StepSecretsPanel projectId={projectId} stepKey={currentNode.key} />
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

