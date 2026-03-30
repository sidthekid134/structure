import { useCallback, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  ExternalLink,
  Globe,
  Loader2,
  MinusCircle,
  PauseCircle,
  Play,
  RefreshCw,
  ScanSearch,
  Shield,
  SkipForward,
  Upload,
  User,
  Zap,
} from 'lucide-react';
import type {
  NodeState,
  NodeStatus,
  ProvisioningGraphNode,
  ProvisioningPlanResponse,
  ResourceOutput,
  UserActionNode,
  ProvisioningStepNode,
} from './types';
import { OAuthFlowPanel } from './OAuthFlowPanel';
import { api } from './helpers';
import { useOAuthSession } from '../../hooks/useOAuthSession';
import { effectiveUserActionInteractiveAction } from './user-action-interactive';
import {
  collectUpstreamResources,
  getPrimaryHref,
  isVaultPlaceholder,
  mergeResourcePresentation,
} from './provisioning-display-registry';

// ---------------------------------------------------------------------------
// Provider metadata
// ---------------------------------------------------------------------------

const PROVIDER_META: Record<string, { label: string; color: string; bg: string; border: string }> = {
  firebase: { label: 'Firebase', color: 'text-orange-500', bg: 'bg-orange-500/10', border: 'border-orange-500/30' },
  github: { label: 'GitHub', color: 'text-slate-600 dark:text-slate-300', bg: 'bg-slate-500/10', border: 'border-slate-500/30' },
  eas: { label: 'EAS', color: 'text-indigo-500', bg: 'bg-indigo-500/10', border: 'border-indigo-500/30' },
  apple: { label: 'Apple', color: 'text-zinc-600 dark:text-zinc-300', bg: 'bg-zinc-500/10', border: 'border-zinc-500/30' },
  'google-play': { label: 'Google Play', color: 'text-green-600', bg: 'bg-green-500/10', border: 'border-green-500/30' },
  cloudflare: { label: 'Cloudflare', color: 'text-amber-600', bg: 'bg-amber-500/10', border: 'border-amber-500/30' },
  oauth: { label: 'OAuth', color: 'text-violet-500', bg: 'bg-violet-500/10', border: 'border-violet-500/30' },
  'user-action': { label: 'Required Action', color: 'text-amber-600 dark:text-amber-400', bg: 'bg-amber-500/10', border: 'border-amber-500/30' },
};

function getProviderMeta(node: ProvisioningGraphNode) {
  if (node.type === 'user-action') {
    return node.provider ? (PROVIDER_META[node.provider] ?? PROVIDER_META['user-action']) : PROVIDER_META['user-action'];
  }
  return PROVIDER_META[node.provider] ?? { label: node.provider, color: 'text-muted-foreground', bg: 'bg-muted', border: 'border-border' };
}

// ---------------------------------------------------------------------------
// Overall status computation
// ---------------------------------------------------------------------------

function computeOverallStatus(nodeStates: Record<string, NodeState>): {
  completed: number;
  total: number;
  hasFailure: boolean;
  hasWaiting: boolean;
  hasResolving: boolean;
  isRunning: boolean;
} {
  const states = Object.values(nodeStates);
  return {
    completed: states.filter((s) => s.status === 'completed' || s.status === 'skipped').length,
    total: states.length,
    hasFailure: states.some((s) => s.status === 'failed'),
    hasWaiting: states.some((s) => s.status === 'waiting-on-user'),
    hasResolving: states.some((s) => s.status === 'resolving'),
    isRunning: states.some((s) => s.status === 'in-progress'),
  };
}

// ---------------------------------------------------------------------------
// Topological execution phase computation
// ---------------------------------------------------------------------------

interface ExecutionPhase {
  phase: number;
  nodes: ProvisioningGraphNode[];
}

function computeExecutionPhases(nodes: ProvisioningGraphNode[]): ExecutionPhase[] {
  const nodeMap = new Map<string, ProvisioningGraphNode>(nodes.map((n) => [n.key, n]));

  const inDegree = new Map<string, number>();
  const reverseDeps = new Map<string, Set<string>>();

  for (const node of nodes) {
    inDegree.set(node.key, 0);
    reverseDeps.set(node.key, new Set());
  }

  for (const node of nodes) {
    for (const dep of node.dependencies) {
      if (nodeMap.has(dep.nodeKey)) {
        inDegree.set(node.key, (inDegree.get(node.key) ?? 0) + 1);
        reverseDeps.get(dep.nodeKey)!.add(node.key);
      }
    }
  }

  const depth = new Map<string, number>();
  const queue: string[] = [];

  for (const [key, deg] of inDegree) {
    if (deg === 0) {
      queue.push(key);
      depth.set(key, 0);
    }
  }

  let head = 0;
  while (head < queue.length) {
    const current = queue[head++]!;
    const currentDepth = depth.get(current) ?? 0;

    for (const dependent of reverseDeps.get(current) ?? new Set<string>()) {
      const newDegree = (inDegree.get(dependent) ?? 1) - 1;
      inDegree.set(dependent, newDegree);
      depth.set(dependent, Math.max(depth.get(dependent) ?? 0, currentDepth + 1));
      if (newDegree === 0) queue.push(dependent);
    }
  }

  const maxDepth = depth.size > 0 ? Math.max(...depth.values()) : 0;
  const phases: ExecutionPhase[] = [];

  for (let d = 0; d <= maxDepth; d++) {
    const phaseNodes = nodes.filter((n) => (depth.get(n.key) ?? 0) === d);
    if (phaseNodes.length > 0) phases.push({ phase: d, nodes: phaseNodes });
  }

  // Nodes with no computed depth (e.g. dependency cycles) go at the end
  const unplaced = nodes.filter((n) => !depth.has(n.key));
  if (unplaced.length > 0) {
    phases.push({ phase: maxDepth + 1, nodes: unplaced });
  }

  return phases;
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

function getEffectiveStatus(
  node: ProvisioningGraphNode,
  nodeStates: Record<string, NodeState>,
  environments: string[],
): NodeStatus {
  if (node.type === 'user-action') {
    const state = nodeStates[node.key];
    return state?.status ?? 'not-started';
  }
  if (node.environmentScope === 'per-environment') {
    const statuses = environments.map((env) => nodeStates[`${node.key}@${env}`]?.status ?? 'not-started');
    if (statuses.every((s) => s === 'completed')) return 'completed';
    if (statuses.some((s) => s === 'in-progress')) return 'in-progress';
    if (statuses.some((s) => s === 'failed')) return 'failed';
    if (statuses.some((s) => s === 'waiting-on-user')) return 'waiting-on-user';
    if (statuses.some((s) => s === 'resolving')) return 'resolving';
    if (statuses.some((s) => s === 'ready')) return 'ready';
    if (statuses.every((s) => s === 'blocked')) return 'blocked';
    return 'not-started';
  }
  return nodeStates[node.key]?.status ?? 'not-started';
}

function statusIcon(status: NodeStatus, size = 14) {
  switch (status) {
    case 'completed': return <CheckCircle2 size={size} className="text-emerald-500" />;
    case 'in-progress': return <Loader2 size={size} className="text-primary animate-spin" />;
    case 'resolving': return <Zap size={size} className="text-cyan-500 animate-pulse" />;
    case 'waiting-on-user': return <PauseCircle size={size} className="text-amber-500" />;
    case 'failed': return <AlertCircle size={size} className="text-red-500" />;
    case 'ready': return <Clock size={size} className="text-blue-500" />;
    case 'skipped': return <SkipForward size={size} className="text-muted-foreground" />;
    case 'blocked': return <MinusCircle size={size} className="text-muted-foreground/50" />;
    default: return <span className="w-2 h-2 rounded-full bg-muted-foreground/30 block" />;
  }
}

function statusBadge(status: NodeStatus) {
  const map: Record<NodeStatus, { label: string; className: string }> = {
    completed: { label: 'Done', className: 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/30' },
    'in-progress': { label: 'Running', className: 'text-primary bg-primary/10 border-primary/30' },
    resolving: { label: 'Auto-resolving', className: 'text-cyan-600 dark:text-cyan-400 bg-cyan-500/10 border-cyan-500/30 animate-pulse' },
    'waiting-on-user': { label: 'Action Needed', className: 'text-amber-600 dark:text-amber-400 bg-amber-500/10 border-amber-500/30' },
    failed: { label: 'Failed', className: 'text-red-600 dark:text-red-400 bg-red-500/10 border-red-500/30' },
    ready: { label: 'Ready', className: 'text-blue-600 dark:text-blue-400 bg-blue-500/10 border-blue-500/30' },
    blocked: { label: 'Blocked', className: 'text-muted-foreground bg-muted border-border' },
    skipped: { label: 'Skipped', className: 'text-muted-foreground bg-muted border-border' },
    'not-started': { label: 'Pending', className: 'text-muted-foreground bg-muted border-border' },
  };
  const { label, className } = map[status];
  return (
    <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${className}`}>
      {label.toUpperCase()}
    </span>
  );
}

function automationBadge(level: string) {
  if (level === 'full') return null;
  if (level === 'assisted') return (
    <span className="text-[9px] font-bold px-1.5 py-0.5 rounded border text-indigo-600 dark:text-indigo-400 bg-indigo-500/10 border-indigo-500/30">
      ASSISTED
    </span>
  );
  return (
    <span className="text-[9px] font-bold px-1.5 py-0.5 rounded border text-orange-600 dark:text-orange-400 bg-orange-500/10 border-orange-500/30">
      MANUAL
    </span>
  );
}

function categoryIcon(category: string) {
  switch (category) {
    case 'account-enrollment': return <User size={12} />;
    case 'credential-upload': return <Upload size={12} />;
    case 'external-configuration': return <Globe size={12} />;
    case 'approval': return <Shield size={12} />;
    default: return <User size={12} />;
  }
}

// ---------------------------------------------------------------------------
// Resource display helpers (registry-driven — see provisioning-display-registry.ts)
// ---------------------------------------------------------------------------

function ResourceValueChip({ resource, value, upstream }: { resource: ResourceOutput; value: string; upstream: Record<string, string> }) {
  const pres = mergeResourcePresentation(resource);
  const secured = pres.sensitive || isVaultPlaceholder(value);
  const link = !secured ? getPrimaryHref(pres, value, upstream) : null;

  if (secured) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-mono bg-muted border border-border px-1.5 py-0.5 rounded text-muted-foreground" title={resource.label}>
        <span className="text-[9px] text-muted-foreground/60">{resource.label}:</span>
        <span className="italic text-muted-foreground/50">secured</span>
      </span>
    );
  }

  if (link) {
    return (
      <a
        href={link}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="inline-flex items-center gap-1 text-[10px] font-mono bg-emerald-500/5 border border-emerald-500/20 px-1.5 py-0.5 rounded text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/10 hover:border-emerald-500/40 transition-colors"
        title={`${resource.label}: ${value}`}
      >
        <span className="text-[9px] text-emerald-600/70 dark:text-emerald-500/70">{resource.label}:</span>
        <span className="max-w-[140px] truncate">{value}</span>
        <ExternalLink size={9} className="shrink-0 opacity-70" />
      </a>
    );
  }

  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-mono bg-muted border border-border px-1.5 py-0.5 rounded text-foreground" title={`${resource.label}: ${value}`}>
      <span className="text-[9px] text-muted-foreground/70">{resource.label}:</span>
      <span className="max-w-[160px] truncate">{value}</span>
    </span>
  );
}

interface ResourcesSectionProps {
  node: ProvisioningGraphNode;
  nodeStates: Record<string, NodeState>;
  environments: string[];
  upstream: Record<string, string>;
}

function ResourcesSection({ node, nodeStates, environments, upstream }: ResourcesSectionProps) {
  if (node.produces.length === 0) return null;

  // Gather all actual produced values across all state keys for this node
  const allProduced: Record<string, string> = {};
  if (node.type === 'step' && node.environmentScope === 'per-environment') {
    for (const env of environments) {
      const state = nodeStates[`${node.key}@${env}`];
      if (state?.resourcesProduced) {
        Object.assign(allProduced, state.resourcesProduced);
      }
    }
  } else {
    const state = nodeStates[node.key];
    if (state?.resourcesProduced) {
      Object.assign(allProduced, state.resourcesProduced);
    }
  }

  const hasValues = Object.keys(allProduced).length > 0;

  return (
    <div className="space-y-1.5">
      <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
        {hasValues ? 'Resources Created' : 'Produces'}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {node.produces.map((r) => {
          const value = allProduced[r.key];
          if (hasValues && value) {
            return <ResourceValueChip key={r.key} resource={r} value={value} upstream={upstream} />;
          }
          return (
            <span key={r.key} className="text-[10px] font-mono bg-muted border border-border px-1.5 py-0.5 rounded text-muted-foreground" title={r.description}>
              {r.key}
            </span>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Node card
// ---------------------------------------------------------------------------

interface NodeCardProps {
  node: ProvisioningGraphNode;
  nodeStates: Record<string, NodeState>;
  environments: string[];
  projectId: string;
  onUserActionComplete: (nodeKey: string, resources?: Record<string, string>) => void;
  onRunNode: (nodeKey: string) => void;
  onSyncAndRefresh: () => Promise<void>;
  isGloballyRunning: boolean;
}

function NodeCard({ node, nodeStates, environments, projectId, onUserActionComplete, onRunNode, onSyncAndRefresh, isGloballyRunning }: NodeCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [credentialInput, setCredentialInput] = useState('');

  const upstream = useMemo(() => collectUpstreamResources(nodeStates), [nodeStates]);

  const effectiveStatus = getEffectiveStatus(node, nodeStates, environments);
  const meta = getProviderMeta(node);

  const perEnvInstances =
    node.type === 'step' && node.environmentScope === 'per-environment'
      ? environments.map((env) => ({
          env,
          status: nodeStates[`${node.key}@${env}`]?.status ?? 'not-started',
        }))
      : null;

  const isWaiting = effectiveStatus === 'waiting-on-user';
  const isUserAction = node.type === 'user-action';
  const userActionNode = isUserAction ? (node as UserActionNode) : null;
  const oauthInteractive = userActionNode ? effectiveUserActionInteractiveAction(userActionNode) : undefined;

  return (
    <div
      className={`rounded-xl border transition-all duration-300 ${
        isWaiting
          ? 'border-amber-500/40 bg-amber-500/5 shadow-sm shadow-amber-500/10'
          : effectiveStatus === 'resolving'
            ? 'border-cyan-500/40 bg-cyan-500/5 shadow-sm shadow-cyan-500/10'
            : effectiveStatus === 'in-progress'
              ? 'border-primary/30 bg-primary/5'
              : effectiveStatus === 'completed'
                ? 'border-emerald-500/20 bg-background'
                : effectiveStatus === 'failed'
                  ? 'border-red-500/30 bg-red-500/5'
                  : 'border-border bg-background'
      }`}
    >
      {/* Header row — div, not button, so inner Run button is valid HTML */}
      <div
        role="button"
        tabIndex={0}
        className="w-full flex items-start gap-3 px-3 py-2.5 cursor-pointer select-none"
        onClick={() => setExpanded((v) => !v)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setExpanded((v) => !v); }}
      >
        <div className="shrink-0 mt-[3px]">{statusIcon(effectiveStatus, 15)}</div>
        <div className="flex-grow min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap mb-0.5">
            {/* Provider badge */}
            <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${meta.color} ${meta.bg} ${meta.border}`}>
              {meta.label.toUpperCase()}
            </span>
            {isUserAction && (
              <span className="flex items-center gap-1 text-[9px] font-bold text-amber-600 dark:text-amber-400 bg-amber-500/10 border border-amber-500/30 px-1.5 py-0.5 rounded">
                {categoryIcon((node as UserActionNode).category)}
                USER GATE
              </span>
            )}
            {node.type === 'step' && automationBadge(node.automationLevel)}
            {node.type === 'step' && node.environmentScope === 'per-environment' && (
              <span className="text-[9px] font-bold px-1.5 py-0.5 rounded border text-sky-600 dark:text-sky-400 bg-sky-500/10 border-sky-500/30">
                PER-ENV
              </span>
            )}
          </div>
          <span className={`text-sm font-semibold ${effectiveStatus === 'blocked' || effectiveStatus === 'not-started' ? 'text-muted-foreground' : 'text-foreground'}`}>
            {node.label}
          </span>
          <p className="text-[11px] text-muted-foreground mt-0.5 leading-snug line-clamp-1">{node.description}</p>
          {/* Inline resource chips — shown for step nodes before completion */}
          {node.type === 'step' && node.produces.length > 0 && effectiveStatus !== 'completed' && effectiveStatus !== 'skipped' && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {node.produces.map((r) => (
                <span
                  key={r.key}
                  title={r.description}
                  className={`inline-flex items-center gap-1 text-[9px] font-mono px-1.5 py-0.5 rounded border ${
                    effectiveStatus === 'in-progress'
                      ? 'bg-primary/5 border-primary/20 text-primary/70'
                      : 'bg-muted border-border text-muted-foreground/60'
                  }`}
                >
                  {effectiveStatus === 'in-progress' && <Loader2 size={8} className="animate-spin shrink-0" />}
                  {r.key}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0 mt-[1px]">
          {/* Step nodes — RUN button */}
          {node.type === 'step' && effectiveStatus !== 'completed' && effectiveStatus !== 'in-progress' && effectiveStatus !== 'skipped' && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onRunNode(node.key); }}
              disabled={isGloballyRunning}
              title="Run this step"
              className="flex items-center gap-1 text-[9px] font-bold px-1.5 py-0.5 rounded border text-primary bg-primary/10 border-primary/30 hover:bg-primary/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Play size={9} />
              RUN
            </button>
          )}
          {/* User-action nodes — interactive action (e.g. OAuth) — expand to use */}
          {isUserAction && effectiveStatus !== 'completed' && effectiveStatus !== 'skipped' && oauthInteractive && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setExpanded(true); }}
              title={oauthInteractive.label}
              className="flex items-center gap-1 text-[9px] font-bold px-1.5 py-0.5 rounded border text-blue-600 dark:text-blue-400 bg-blue-500/10 border-blue-500/30 hover:bg-blue-500/20 transition-colors"
            >
              <Zap size={9} />
              {oauthInteractive.label.toUpperCase()}
            </button>
          )}
          {/* User-action nodes — inline action button */}
          {isUserAction && effectiveStatus !== 'completed' && effectiveStatus !== 'skipped' && (() => {
            const ua = node as UserActionNode;
            if (ua.verification.type === 'manual-confirm') {
              return (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onUserActionComplete(node.key); }}
                  title="Mark as completed"
                  className="flex items-center gap-1 text-[9px] font-bold px-1.5 py-0.5 rounded border text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/30 hover:bg-emerald-500/20 transition-colors"
                >
                  <CheckCircle2 size={9} />
                  DONE
                </button>
              );
            }
            if (ua.verification.type === 'credential-upload') {
              return (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setExpanded(true); }}
                  title="Upload credential"
                  className="flex items-center gap-1 text-[9px] font-bold px-1.5 py-0.5 rounded border text-amber-600 dark:text-amber-400 bg-amber-500/10 border-amber-500/30 hover:bg-amber-500/20 transition-colors"
                >
                  <Upload size={9} />
                  UPLOAD
                </button>
              );
            }
            return null;
          })()}
          {statusBadge(effectiveStatus)}
          {expanded ? <ChevronDown size={13} className="text-muted-foreground" /> : <ChevronRight size={13} className="text-muted-foreground" />}
        </div>
      </div>

      {/* Expanded body */}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeInOut' }}
            className="overflow-hidden"
          >
            <div className="border-t border-border px-3 pb-3 pt-2.5 space-y-3">
              <p className="text-[11px] text-muted-foreground leading-relaxed">{node.description}</p>

              {/* Per-env status breakdown */}
              {perEnvInstances && (
                <div className="flex flex-wrap gap-1.5">
                  {perEnvInstances.map(({ env, status }) => (
                    <div key={env} className="flex items-center gap-1.5 bg-muted rounded-lg px-2 py-1 border border-border">
                      <span className="shrink-0">{statusIcon(status, 11)}</span>
                      <span className="text-[10px] font-mono text-muted-foreground">{env}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Resources produced */}
              <ResourcesSection node={node} nodeStates={nodeStates} environments={environments} upstream={upstream} />

              {/* OAuth step nodes: the RUN button triggers the OAuth flow automatically
                  when no token is stored. No separate sign-in panel is needed here. */}

              {/* User action controls — always shown when expanded, not gated by waiting status */}
              {isUserAction && effectiveStatus !== 'completed' && effectiveStatus !== 'skipped' && (
                <div className="space-y-2 pt-1 border-t border-border">
                  {(node as UserActionNode).helpUrl && (
                    <a
                      href={(node as UserActionNode).helpUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-primary hover:underline"
                    >
                      <ExternalLink size={11} />
                      Open instructions
                    </a>
                  )}

                  {/* Interactive OAuth flow */}
                  {oauthInteractive?.type === 'oauth' && (
                    <OAuthFlowPanel
                      projectId={projectId}
                      label={oauthInteractive.label}
                      onCompleted={onSyncAndRefresh}
                    />
                  )}

                  {(node as UserActionNode).verification.type === 'credential-upload' && (
                    <div className="space-y-1.5">
                      <label className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                        Upload: {((node as UserActionNode).verification as { type: 'credential-upload'; secretKey: string }).secretKey}
                      </label>
                      <textarea
                        className="w-full text-xs font-mono bg-background border border-border rounded-lg px-2.5 py-2 focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none resize-none"
                        rows={4}
                        placeholder="Paste credential value here…"
                        value={credentialInput}
                        onChange={(e) => setCredentialInput(e.target.value)}
                      />
                      <button
                        type="button"
                        disabled={!credentialInput.trim()}
                        onClick={() => {
                          const ver = (node as UserActionNode).verification;
                          onUserActionComplete(node.key, {
                            [ver.type === 'credential-upload' ? ver.secretKey : 'value']: credentialInput.trim(),
                          });
                          setCredentialInput('');
                        }}
                        className="flex items-center gap-1.5 bg-primary text-primary-foreground text-xs font-bold px-3 py-1.5 rounded-lg hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        <Upload size={11} />
                        Submit
                      </button>
                    </div>
                  )}

                  {(node as UserActionNode).verification.type === 'manual-confirm' && (
                    <button
                      type="button"
                      onClick={() => onUserActionComplete(node.key)}
                      className="flex items-center gap-1.5 bg-amber-500 text-white text-xs font-bold px-3 py-1.5 rounded-lg hover:bg-amber-600 transition-colors"
                    >
                      <CheckCircle2 size={11} />
                      Mark as Completed
                    </button>
                  )}

                  {(node as UserActionNode).verification.type === 'api-check' && (
                    <p className="text-[11px] text-muted-foreground italic">
                      Verification: {((node as UserActionNode).verification as { type: 'api-check'; description: string }).description}
                    </p>
                  )}
                </div>
              )}

              {/* Error message */}
              {effectiveStatus === 'failed' && (() => {
                const state = node.type === 'step' && node.environmentScope === 'global'
                  ? nodeStates[node.key]
                  : perEnvInstances?.find((i) => i.status === 'failed')
                    ? nodeStates[`${node.key}@${perEnvInstances.find((i) => i.status === 'failed')!.env}`]
                    : null;
                return state?.error ? (
                  <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/30 rounded-lg p-2.5">
                    <AlertTriangle size={12} className="text-red-500 shrink-0 mt-0.5" />
                    <p className="text-[11px] text-red-600 dark:text-red-400 leading-relaxed">{state.error}</p>
                  </div>
                ) : null;
              })()}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Execution phase section
// ---------------------------------------------------------------------------

interface PhaseGroupProps {
  phase: ExecutionPhase;
  phaseNumber: number;
  nodeStates: Record<string, NodeState>;
  environments: string[];
  projectId: string;
  onUserActionComplete: (nodeKey: string, resources?: Record<string, string>) => void;
  onRunNodes: (nodeKeys: string[]) => void;
  onSyncAndRefresh: () => Promise<void>;
  isGloballyRunning: boolean;
}

function PhaseGroup({ phase, phaseNumber, nodeStates, environments, projectId, onUserActionComplete, onRunNodes, onSyncAndRefresh, isGloballyRunning }: PhaseGroupProps) {
  const [expanded, setExpanded] = useState(true);

  const statuses = phase.nodes.map((n) => getEffectiveStatus(n, nodeStates, environments));
  const completedCount = statuses.filter((s) => s === 'completed' || s === 'skipped').length;
  const hasWaiting = statuses.some((s) => s === 'waiting-on-user');
  const hasResolving = statuses.some((s) => s === 'resolving');
  const hasRunning = statuses.some((s) => s === 'in-progress');
  const hasFailure = statuses.some((s) => s === 'failed');
  const allDone = completedCount === phase.nodes.length;
  // Step nodes in this phase that can actually be executed
  const runnableStepKeys = phase.nodes
    .filter((n): n is ProvisioningStepNode => n.type === 'step')
    .filter((n) => {
      const s = getEffectiveStatus(n, nodeStates, environments);
      return s !== 'completed' && s !== 'skipped' && s !== 'in-progress';
    })
    .map((n) => n.key);

  return (
    <div className={`border rounded-2xl overflow-hidden ${
      allDone ? 'border-emerald-500/20' :
      hasFailure ? 'border-red-500/20' :
      hasWaiting ? 'border-amber-500/30' :
      hasResolving ? 'border-cyan-500/30' :
      hasRunning ? 'border-primary/20' :
      'border-border'
    }`}>
      <div
        role="button"
        tabIndex={0}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-muted/30 transition-colors cursor-pointer select-none"
        onClick={() => setExpanded((v) => !v)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setExpanded((v) => !v); }}
      >
        {/* Phase number badge */}
        <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 text-xs font-bold ${
          allDone ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' :
          hasFailure ? 'bg-red-500/10 text-red-600 dark:text-red-400' :
          hasRunning ? 'bg-primary/10 text-primary' :
          hasResolving ? 'bg-cyan-500/10 text-cyan-600 dark:text-cyan-400' :
          hasWaiting ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400' :
          'bg-muted text-muted-foreground'
        }`}>
          {phaseNumber}
        </div>

        <div className="flex-grow min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-bold text-sm">Phase {phaseNumber}</span>
            {hasResolving && (
              <span className="flex items-center gap-1 text-[9px] font-bold text-cyan-600 dark:text-cyan-400 bg-cyan-500/10 border border-cyan-500/30 px-1.5 py-0.5 rounded animate-pulse">
                <Zap size={9} />
                AUTO-RESOLVING
              </span>
            )}
            {hasWaiting && (
              <span className="flex items-center gap-1 text-[9px] font-bold text-amber-600 dark:text-amber-400 bg-amber-500/10 border border-amber-500/30 px-1.5 py-0.5 rounded">
                <PauseCircle size={9} />
                WAITING
              </span>
            )}
            {hasRunning && (
              <span className="flex items-center gap-1 text-[9px] font-bold text-primary bg-primary/10 border border-primary/30 px-1.5 py-0.5 rounded">
                <Loader2 size={9} className="animate-spin" />
                RUNNING
              </span>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            {completedCount}/{phase.nodes.length} complete
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {allDone && <CheckCircle2 size={16} className="text-emerald-500" />}
          {hasFailure && <AlertCircle size={16} className="text-red-500" />}
          {/* Run Phase button — shown when there are runnable steps and nothing is globally running */}
          {runnableStepKeys.length > 0 && !allDone && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onRunNodes(runnableStepKeys); }}
              disabled={isGloballyRunning}
              title="Run all pending steps in this phase"
              className="flex items-center gap-1 text-[10px] font-bold px-2 py-1 rounded-lg border text-primary bg-primary/10 border-primary/30 hover:bg-primary/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {hasRunning
                ? <Loader2 size={10} className="animate-spin" />
                : <Play size={10} />}
              {hasRunning ? 'Running…' : 'Run Phase'}
            </button>
          )}
          <ChevronDown
            size={15}
            className={`text-muted-foreground transition-transform duration-200 ${expanded ? '' : '-rotate-90'}`}
          />
        </div>
      </div>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeInOut' }}
            className="overflow-hidden"
          >
            <div className="border-t border-border p-3 space-y-2">
              {phase.nodes.map((node) => (
                <NodeCard
                  key={node.key}
                  node={node}
                  nodeStates={nodeStates}
                  environments={environments}
                  projectId={projectId}
                  onUserActionComplete={onUserActionComplete}
                  onRunNode={(key) => onRunNodes([key])}
                  onSyncAndRefresh={onSyncAndRefresh}
                  isGloballyRunning={isGloballyRunning}
                />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main ProvisioningGraphView
// ---------------------------------------------------------------------------

interface ProvisioningGraphViewProps {
  projectId: string;
  plan: ProvisioningPlanResponse | null;
  onPlanChange: (plan: ProvisioningPlanResponse) => void;
  onUserActionComplete: (nodeKey: string, resources?: Record<string, string>) => Promise<void>;
  onRefresh: () => Promise<void>;
}

export function ProvisioningGraphView({
  projectId,
  plan,
  onPlanChange,
  onUserActionComplete,
  onRefresh,
}: ProvisioningGraphViewProps) {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  const gcpOAuthSession = useOAuthSession({ projectId, providerId: 'gcp' });

  const handleSyncStatus = async () => {
    setIsSyncing(true);
    setRunError(null);
    try {
      const result = await api<{
        ok?: boolean;
        needsReauth?: boolean;
        sessionId?: string;
        authUrl?: string;
      }>(`/api/projects/${encodeURIComponent(projectId)}/provisioning/plan/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (result.needsReauth && result.authUrl && result.sessionId) {
        const reauthStatus = await gcpOAuthSession.pollExternal(result.sessionId, result.authUrl);
        if (reauthStatus?.phase === 'completed' && reauthStatus.connected) {
          await api(`/api/projects/${encodeURIComponent(projectId)}/provisioning/plan/sync`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          });
        } else {
          setRunError(gcpOAuthSession.error ?? 'Google re-authentication failed.');
          setIsSyncing(false);
          return;
        }
        await onRefresh();
        setIsSyncing(false);
        return;
      }
    } catch (err) {
      setRunError((err as Error).message);
    } finally {
      setIsSyncing(false);
    }
  };

  const handleSyncAndRefresh = useCallback(async () => {
    try {
      const result = await api<{
        ok?: boolean;
        needsReauth?: boolean;
        sessionId?: string;
        authUrl?: string;
      }>(`/api/projects/${encodeURIComponent(projectId)}/provisioning/plan/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (result.needsReauth && result.authUrl && result.sessionId) {
        const reauthStatus = await gcpOAuthSession.pollExternal(result.sessionId, result.authUrl);
        if (reauthStatus?.phase === 'completed' && reauthStatus.connected) {
          await api(`/api/projects/${encodeURIComponent(projectId)}/provisioning/plan/sync`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          });
        }
      }
    } catch { /* sync is best-effort here */ }
    await onRefresh();
  }, [projectId, onRefresh, gcpOAuthSession]);

  const handleRunProvisioning = async () => {
    setIsRunning(true);
    setRunError(null);
    try {
      await api(`/api/projects/${encodeURIComponent(projectId)}/provisioning/plan/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      await onRefresh();
    } catch (err) {
      setRunError((err as Error).message);
    } finally {
      setIsRunning(false);
    }
  };

  const handleRunNodes = async (nodeKeys: string[]) => {
    setRunError(null);
    try {
      const result = await api<{ started?: boolean; needsReauth?: boolean; sessionId?: string; authUrl?: string }>(
        `/api/projects/${encodeURIComponent(projectId)}/provisioning/plan/run/nodes`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nodeKeys }) },
      );

      if (result.needsReauth && result.sessionId && result.authUrl) {
        // OAuth required before this step can run — authenticate then automatically retry.
        const reauthStatus = await gcpOAuthSession.pollExternal(result.sessionId, result.authUrl);
        if (reauthStatus?.phase === 'completed' && reauthStatus.connected) {
          // Retry the run now that we have a token.
          await api(`/api/projects/${encodeURIComponent(projectId)}/provisioning/plan/run/nodes`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nodeKeys }),
          });
        } else {
          setRunError(gcpOAuthSession.error ?? 'Google sign-in required before running this step.');
          return;
        }
      }

      await onRefresh();
    } catch (err) {
      setRunError((err as Error).message);
    }
  };

  const phases = useMemo(() => {
    if (!plan) return [];
    return computeExecutionPhases(plan.nodes);
  }, [plan]);

  const overallStats = useMemo(() => {
    if (!plan) return null;
    return computeOverallStatus(plan.nodeStates);
  }, [plan]);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleUserActionComplete = async (nodeKey: string, resources?: Record<string, string>) => {
    await onUserActionComplete(nodeKey, resources);
    if (plan) {
      const updated = {
        ...plan,
        nodeStates: {
          ...plan.nodeStates,
          [nodeKey]: {
            ...plan.nodeStates[nodeKey],
            nodeKey,
            status: 'completed' as const,
            completedAt: Date.now(),
            resourcesProduced: resources ?? {},
          },
        },
      };
      onPlanChange(updated);
    }
  };

  if (!plan) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 size={20} className="animate-spin mr-2" />
        <span className="text-sm">Loading provisioning plan…</span>
      </div>
    );
  }

  const progress = overallStats
    ? Math.round((overallStats.completed / Math.max(overallStats.total, 1)) * 100)
    : 0;

  return (
    <div className="space-y-5">
      {/* Summary header */}
      <div className="bg-card border border-border rounded-2xl p-4 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-grow">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-sm font-bold">Provisioning Plan</span>
              {overallStats?.isRunning && (
                <span className="flex items-center gap-1 text-[9px] font-bold text-primary bg-primary/10 border border-primary/30 px-1.5 py-0.5 rounded animate-pulse">
                  <Loader2 size={9} className="animate-spin" />
                  RUNNING
                </span>
              )}
              {overallStats?.hasResolving && (
                <span className="flex items-center gap-1 text-[9px] font-bold text-cyan-600 dark:text-cyan-400 bg-cyan-500/10 border border-cyan-500/30 px-1.5 py-0.5 rounded animate-pulse">
                  <Zap size={9} />
                  AUTO-RESOLVING
                </span>
              )}
              {overallStats?.hasWaiting && (
                <span className="flex items-center gap-1 text-[9px] font-bold text-amber-600 dark:text-amber-400 bg-amber-500/10 border border-amber-500/30 px-1.5 py-0.5 rounded">
                  <PauseCircle size={9} />
                  ACTION NEEDED
                </span>
              )}
              {overallStats?.hasFailure && (
                <span className="flex items-center gap-1 text-[9px] font-bold text-red-600 dark:text-red-400 bg-red-500/10 border border-red-500/30 px-1.5 py-0.5 rounded">
                  <AlertCircle size={9} />
                  FAILED
                </span>
              )}
              {!!overallStats && !overallStats.isRunning && !overallStats.hasFailure && overallStats.completed === overallStats.total && overallStats.total > 0 && (
                <span className="flex items-center gap-1 text-[9px] font-bold text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 px-1.5 py-0.5 rounded">
                  <CheckCircle2 size={9} />
                  COMPLETE
                </span>
              )}
            </div>

            <div className="flex items-center gap-3">
              <div className="flex-grow bg-muted rounded-full h-1.5 overflow-hidden">
                <motion.div
                  className={`h-full rounded-full transition-colors duration-500 ${
                    overallStats?.hasFailure
                      ? 'bg-red-500'
                      : overallStats?.hasWaiting
                        ? 'bg-amber-500'
                        : overallStats?.hasResolving
                          ? 'bg-cyan-500'
                          : 'bg-emerald-500'
                  }`}
                  initial={{ width: 0 }}
                  animate={{ width: `${progress}%` }}
                  transition={{ duration: 0.5, ease: 'easeOut' }}
                />
              </div>
              <span className="text-xs font-bold tabular-nums text-muted-foreground shrink-0">
                {overallStats?.completed}/{overallStats?.total}
              </span>
            </div>

            <div className="flex items-center gap-3 mt-2 text-[11px] text-muted-foreground">
              <span>{plan.environments.join(', ')} environments</span>
              <span>·</span>
              <span>{plan.nodes.length} nodes</span>
              <span>·</span>
              <span>{phases.length} phases</span>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => void handleSyncStatus()}
              disabled={isSyncing || isRunning || overallStats?.isRunning}
              className="flex items-center gap-1.5 text-xs font-bold text-foreground border border-border hover:bg-accent px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSyncing
                ? <Loader2 size={12} className="animate-spin" />
                : <ScanSearch size={12} />}
              {isSyncing ? 'Syncing…' : 'Sync Status'}
            </button>
            <button
              type="button"
              onClick={() => void handleRunProvisioning()}
              disabled={isRunning || isSyncing || overallStats?.isRunning}
              className="flex items-center gap-1.5 text-xs font-bold bg-primary text-primary-foreground px-3 py-1.5 rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isRunning || overallStats?.isRunning
                ? <Loader2 size={12} className="animate-spin" />
                : <Play size={12} />}
              {isRunning || overallStats?.isRunning ? 'Running…' : 'Run Provisioning'}
            </button>
            <button
              type="button"
              onClick={() => void handleRefresh()}
              disabled={isRefreshing}
              className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground border border-border hover:bg-accent px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
            >
              <RefreshCw size={12} className={isRefreshing ? 'animate-spin' : ''} />
              Refresh
            </button>
          </div>
        </div>

        {runError && (
          <div className="mt-3 pt-3 border-t border-border flex items-start gap-2 text-xs text-red-600 dark:text-red-400">
            <AlertCircle size={13} className="shrink-0 mt-0.5" />
            <span>Failed to start: {runError}</span>
          </div>
        )}

        {!!overallStats && !overallStats.isRunning && !overallStats.hasFailure && overallStats.completed === overallStats.total && overallStats.total > 0 && (
          <div className="mt-3 pt-3 border-t border-border flex items-center gap-2 text-xs text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 size={14} />
            <span className="font-semibold">All infrastructure provisioned — Ready for first deployment</span>
          </div>
        )}
      </div>

      {/* Execution phases */}
      <div className="space-y-3">
        {phases.map((phase, idx) => (
          <PhaseGroup
            key={phase.phase}
            phase={phase}
            phaseNumber={idx + 1}
            nodeStates={plan.nodeStates}
            environments={plan.environments}
            projectId={projectId}
            onUserActionComplete={(nodeKey, resources) => void handleUserActionComplete(nodeKey, resources)}
            onRunNodes={(nodeKeys) => void handleRunNodes(nodeKeys)}
            onSyncAndRefresh={handleSyncAndRefresh}
            isGloballyRunning={!!(overallStats?.isRunning || isRunning)}
          />
        ))}
      </div>
    </div>
  );
}
