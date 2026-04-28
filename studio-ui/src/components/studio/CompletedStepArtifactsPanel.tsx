import { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { CheckCircle2, Clock, Copy, ExternalLink, Lock, Loader2, SkipForward } from 'lucide-react';
import type { NodeState, NodeStatus, ProvisioningGraphNode, ProvisioningPlanResponse, ResourceDisplayConfig, ResourceOutput } from './types';
import {
  collectUpstreamResources,
  getPrimaryHref,
  getResolvedRelatedLinks,
  isVaultPlaceholder,
  mergeResourcePresentation,
} from './provisioning-display-registry';
import { easSyncLlmSecretsProduceDescription, llmEasEnvGroupsForUi } from './helpers';

function provisioningStateKey(node: ProvisioningGraphNode, environment?: string): string {
  if (node.type === 'step' && node.environmentScope === 'per-environment' && environment) {
    return `${node.key}@${environment}`;
  }
  return node.key;
}

type ResourceStatus = 'planned' | 'in_progress' | 'complete';

function deriveResourceStatus(value: string | undefined, stepStatus: NodeStatus): ResourceStatus {
  if (value !== undefined && value !== '') return 'complete';
  if (stepStatus === 'completed' || stepStatus === 'skipped') return 'complete';
  if (stepStatus === 'in-progress') return 'in_progress';
  return 'planned';
}

function LinkPill({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/[0.08] px-2 py-1 text-[11px] font-semibold text-emerald-900 dark:text-emerald-100 hover:bg-emerald-500/15 transition-colors"
    >
      <ExternalLink size={11} className="shrink-0 opacity-80" />
      {label}
    </a>
  );
}

function CopyValueButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  if (!text) return null;
  return (
    <button
      type="button"
      title="Copy value"
      className="inline-flex items-center justify-center rounded border border-border p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          window.setTimeout(() => setDone(false), 1600);
        });
      }}
    >
      <Copy size={12} />
      {done ? <span className="sr-only">Copied</span> : null}
    </button>
  );
}

function ResourceRow({
  resource,
  value,
  upstream,
  status,
  plannedName,
  resourceDisplayByKey,
  llmEasEnvGroups,
}: {
  resource: ResourceOutput;
  value: string | undefined;
  upstream: Record<string, string>;
  status: ResourceStatus;
  plannedName?: string;
  resourceDisplayByKey?: Record<string, ResourceDisplayConfig>;
  /** Full Expo env keys for planned LLM sync (styled list; no placeholders). */
  llmEasEnvGroups?: { label: string; keys: readonly string[] }[];
}) {
  const presentation = mergeResourcePresentation(resource, resourceDisplayByKey);
  const secured = presentation.sensitive || (value !== undefined && isVaultPlaceholder(value));
  const primary = value !== undefined && !secured ? getPrimaryHref(presentation, value, upstream) : null;
  const related = value !== undefined && !secured ? getResolvedRelatedLinks(presentation, value, upstream) : [];
  const hasValue = value !== undefined && value !== '';
  const normalizedPlanned = (plannedName ?? '').trim();
  const showPlannedName =
    (status === 'planned' || status === 'in_progress') &&
    normalizedPlanned.length > 0 &&
    normalizedPlanned !== resource.key &&
    normalizedPlanned !== resource.label &&
    normalizedPlanned !== 'Named when this step runs' &&
    normalizedPlanned !== 'Identifier assigned when this step completes' &&
    normalizedPlanned !== 'URL assigned when this step completes';

  const cardBorder =
    status === 'complete'
      ? 'border-emerald-500/25 bg-emerald-500/[0.04]'
      : status === 'in_progress'
        ? 'border-primary/25 bg-primary/[0.04]'
        : 'border-border/60 bg-background/40';

  return (
    <motion.div
      layout
      className={`rounded-lg border p-3 space-y-2 transition-colors duration-500 ${cardBorder}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-xs font-bold text-foreground">{resource.label}</p>
            {presentation.destinationType ? (
              <span className="shrink-0 inline-flex items-center text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full border border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300">
                {presentation.destinationType}
              </span>
            ) : null}
            {presentation.secretType ? (
              <span className="shrink-0 inline-flex items-center text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full border border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300">
                {presentation.secretType}
              </span>
            ) : null}
            {presentation.writeBehavior ? (
              <span className="shrink-0 inline-flex items-center text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full border border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300">
                {presentation.writeBehavior}
              </span>
            ) : null}
            <AnimatePresence mode="wait" initial={false}>
              <motion.span
                key={status}
                initial={{ opacity: 0, scale: 0.85 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.85 }}
                transition={{ duration: 0.15 }}
                className={`shrink-0 inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full border ${
                  status === 'complete'
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                    : status === 'in_progress'
                      ? 'border-primary/30 bg-primary/10 text-primary'
                      : 'border-border bg-muted/60 text-muted-foreground'
                }`}
              >
                {status === 'in_progress' && <Loader2 size={8} className="animate-spin" />}
                {status === 'complete' && <CheckCircle2 size={8} />}
                {status === 'planned' && <Clock size={8} />}
                {status === 'complete' ? 'complete' : status === 'in_progress' ? 'in progress' : 'planned'}
              </motion.span>
            </AnimatePresence>
          </div>
          <p className="text-[11px] text-muted-foreground mt-0.5">{resource.description}</p>
          {llmEasEnvGroups && llmEasEnvGroups.length > 0 ? (
            <div className="mt-2 space-y-2">
              <p className="text-[9px] font-bold uppercase tracking-wide text-muted-foreground">
                Expo variable names upsert or clear
              </p>
              {llmEasEnvGroups.map((g) => (
                <div key={g.label} className="space-y-1">
                  <p className="text-[10px] font-semibold text-foreground">{g.label}</p>
                  <ul className="rounded-md border border-border/70 bg-muted/30 px-2 py-1.5 space-y-1">
                    {g.keys.map((envName) => (
                      <li
                        key={envName}
                        className="font-mono text-[10px] text-foreground/95 leading-snug break-all border-l-2 border-sky-500/45 pl-2"
                      >
                        {envName}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          ) : null}
        </div>
        {hasValue && !secured && status === 'complete' ? <CopyValueButton text={value!} /> : null}
      </div>

      {showPlannedName ? (
        <div className="rounded-md border border-border/70 bg-muted/25 px-2.5 py-2">
          <p className="text-[9px] font-bold uppercase tracking-wide text-muted-foreground">Name it will create</p>
          <p className="text-xs text-foreground mt-1 leading-snug break-words">{normalizedPlanned}</p>
        </div>
      ) : null}

      <AnimatePresence initial={false}>
        {status === 'complete' && (
          <motion.div
            key="value"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.25, ease: 'easeOut' }}
            className="overflow-hidden"
          >
            {secured ? (
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <Lock size={12} className="shrink-0 text-amber-600/90 dark:text-amber-400/90" />
                <span className="font-medium text-amber-900/90 dark:text-amber-100/90">
                  Stored securely — not shown here
                </span>
              </div>
            ) : hasValue ? (
              <div className="space-y-2">
                {primary ? (
                  <a
                    href={primary}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 text-sm font-mono font-semibold text-primary hover:underline break-all"
                  >
                    {value}
                    <ExternalLink size={13} className="shrink-0" />
                  </a>
                ) : (
                  <p className="text-sm font-mono break-all text-foreground">{value}</p>
                )}
                {related.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5 pt-0.5">
                    {related.map((l) => (
                      <LinkPill key={`${l.label}-${l.href}`} href={l.href} label={l.label} />
                    ))}
                  </div>
                ) : null}
              </div>
            ) : (
              <p className="text-[11px] text-muted-foreground italic">No value recorded.</p>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function gatherProducesForState(
  node: ProvisioningGraphNode,
  state: NodeState | undefined,
): Record<string, string> {
  return { ...(state?.resourcesProduced ?? {}) };
}

export function CompletedStepArtifactsPanel({
  node,
  plan,
  stepStatus,
  selectedModulesOverride,
}: {
  node: ProvisioningGraphNode;
  plan: ProvisioningPlanResponse;
  stepStatus: NodeStatus;
  /** When set (e.g. pending Modules tab picks), overrides `plan.selectedModules` for display-only copy such as LLM EAS sync cards. */
  selectedModulesOverride?: string[];
}) {
  const upstream = useMemo(() => collectUpstreamResources(plan.nodeStates), [plan.nodeStates]);
  const previewsForNode = plan.plannedOutputPreviewByNodeKey?.[node.key];

  const producesForDisplay = useMemo(() => {
    const mods = selectedModulesOverride ?? plan.selectedModules;
    if (node.key !== 'eas:sync-llm-secrets') return node.produces;
    return node.produces.map((r) => {
      if (r.key !== 'eas_llm_env_sync_snapshot') return r;
      return {
        ...r,
        description: easSyncLlmSecretsProduceDescription(mods),
      };
    });
  }, [node.key, node.produces, plan.selectedModules, selectedModulesOverride]);

  const llmEasGroupsForCards = useMemo(() => {
    if (node.key !== 'eas:sync-llm-secrets') return undefined;
    const g = llmEasEnvGroupsForUi(selectedModulesOverride ?? plan.selectedModules);
    return g.length > 0 ? g : undefined;
  }, [node.key, selectedModulesOverride, plan.selectedModules]);

  const helpUrl = node.type === 'user-action' ? node.helpUrl : undefined;

  const perEnv =
    node.type === 'step' && node.environmentScope === 'per-environment'
      ? plan.environments.map((env) => {
          const sk = provisioningStateKey(node, env);
          const st = plan.nodeStates[sk];
          return { env, state: st, produced: gatherProducesForState(node, st) };
        })
      : null;

  const globalState =
    node.type === 'step' && node.environmentScope === 'per-environment'
      ? undefined
      : plan.nodeStates[provisioningStateKey(node)];

  const globalProduced = globalState ? gatherProducesForState(node, globalState) : {};

  // User-action nodes: only show when completed or skipped
  if (node.type === 'user-action' && stepStatus !== 'completed' && stepStatus !== 'skipped') {
    return null;
  }

  const isSkipped = stepStatus === 'skipped';
  const isCompleted = stepStatus === 'completed';
  const isInProgress = stepStatus === 'in-progress';

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        {isSkipped ? (
          <SkipForward size={13} className="shrink-0 text-muted-foreground" />
        ) : isCompleted ? (
          <CheckCircle2 size={13} className="shrink-0 text-emerald-600 dark:text-emerald-400" />
        ) : isInProgress ? (
          <Loader2 size={13} className="shrink-0 text-primary animate-spin" />
        ) : (
          <Clock size={13} className="shrink-0 text-muted-foreground/60" />
        )}
        <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
          {isSkipped
            ? 'Step skipped'
            : isCompleted
              ? 'Resources created'
              : isInProgress
                ? 'Creating resources'
                : 'Resources to be created'}
        </p>
      </div>

      {helpUrl ? (
        <a
          href={helpUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary hover:underline"
        >
          <ExternalLink size={12} />
          Original instructions
        </a>
      ) : null}

      {producesForDisplay.length === 0 ? (
        <p className="text-xs text-muted-foreground">This step does not declare output fields.</p>
      ) : perEnv ? (
        <div className="space-y-4">
          {perEnv.map(({ env, state, produced }) => {
            const envStatus = (state?.status ?? 'not-started') as NodeStatus;
            return (
              <div key={env} className="rounded-lg border border-border bg-card/40 p-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-bold font-mono text-foreground">{env}</span>
                  <span className="text-[10px] uppercase font-bold text-muted-foreground">
                    {envStatus.replace(/-/g, ' ')}
                  </span>
                </div>
                <div className="space-y-2">
                  {producesForDisplay.map((resource) => (
                    <ResourceRow
                      key={`${env}-${resource.key}`}
                      resource={resource}
                      value={produced[resource.key]}
                      upstream={upstream}
                      status={deriveResourceStatus(produced[resource.key], envStatus)}
                      plannedName={previewsForNode?.[resource.key]}
                      resourceDisplayByKey={plan.resourceDisplayByKey}
                      llmEasEnvGroups={resource.key === 'eas_llm_env_sync_snapshot' ? llmEasGroupsForCards : undefined}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="space-y-2">
          {producesForDisplay.map((resource) => (
            <ResourceRow
              key={resource.key}
              resource={resource}
              value={globalProduced[resource.key]}
              upstream={upstream}
              status={deriveResourceStatus(globalProduced[resource.key], stepStatus)}
              plannedName={previewsForNode?.[resource.key]}
              resourceDisplayByKey={plan.resourceDisplayByKey}
              llmEasEnvGroups={resource.key === 'eas_llm_env_sync_snapshot' ? llmEasGroupsForCards : undefined}
            />
          ))}
        </div>
      )}

      {isSkipped && producesForDisplay.length > 0 && Object.keys(globalProduced).length === 0 && !perEnv && (
        <p className="text-[11px] text-muted-foreground">No outputs were captured for this step.</p>
      )}
    </div>
  );
}
