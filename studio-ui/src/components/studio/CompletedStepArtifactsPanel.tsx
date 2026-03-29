import { useMemo, useState } from 'react';
import { CheckCircle2, Copy, ExternalLink, Lock, SkipForward } from 'lucide-react';
import type { NodeState, ProvisioningGraphNode, ProvisioningPlanResponse, ResourceOutput } from './types';
import {
  collectUpstreamResources,
  getPrimaryHref,
  getResolvedRelatedLinks,
  isVaultPlaceholder,
  mergeResourcePresentation,
  resolvedNodePortalLinks,
} from './provisioning-display-registry';

function provisioningStateKey(node: ProvisioningGraphNode, environment?: string): string {
  if (node.type === 'step' && node.environmentScope === 'per-environment' && environment) {
    return `${node.key}@${environment}`;
  }
  return node.key;
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

function CopyValueButton({ text, disabled }: { text: string; disabled?: boolean }) {
  const [done, setDone] = useState(false);
  if (disabled || !text) return null;
  return (
    <button
      type="button"
      title="Copy value"
      className="inline-flex items-center justify-center rounded border border-border p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
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
}: {
  resource: ResourceOutput;
  value: string | undefined;
  upstream: Record<string, string>;
}) {
  const presentation = mergeResourcePresentation(resource);
  const secured = presentation.sensitive || (value !== undefined && isVaultPlaceholder(value));
  const primary =
    value !== undefined && !secured ? getPrimaryHref(presentation, value, upstream) : null;
  const related =
    value !== undefined && !secured ? getResolvedRelatedLinks(presentation, value, upstream) : [];
  const hasValue = value !== undefined && value !== '';

  return (
    <div className="rounded-lg border border-border/80 bg-background/60 p-3 space-y-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-bold text-foreground">{resource.label}</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">{resource.description}</p>
        </div>
        {hasValue && !secured ? <CopyValueButton text={value} /> : null}
      </div>

      {secured ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Lock size={13} className="shrink-0 text-amber-600/90 dark:text-amber-400/90" />
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
              <ExternalLink size={14} className="shrink-0" />
            </a>
          ) : (
            <p className="text-sm font-mono break-all text-foreground">{value}</p>
          )}
          {related.length > 0 ? (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {related.map((l) => (
                <LinkPill key={`${l.label}-${l.href}`} href={l.href} label={l.label} />
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground italic">No value recorded for this field.</p>
      )}
    </div>
  );
}

function PortalLinksSection({ node, upstream }: { node: ProvisioningGraphNode; upstream: Record<string, string> }) {
  const links = resolvedNodePortalLinks(node, upstream);
  if (links.length === 0) return null;
  return (
    <div className="space-y-2">
      <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Where to manage this</p>
      <div className="flex flex-wrap gap-1.5">
        {links.map((l) => (
          <LinkPill key={`${l.label}-${l.href}`} href={l.href} label={l.label} />
        ))}
      </div>
    </div>
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
  terminalStatus,
}: {
  node: ProvisioningGraphNode;
  plan: ProvisioningPlanResponse;
  terminalStatus: 'completed' | 'skipped';
}) {
  const upstream = useMemo(() => collectUpstreamResources(plan.nodeStates), [plan.nodeStates]);

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

  const hasAnyProduced =
    node.produces.length > 0 &&
    (perEnv
      ? perEnv.some((row) => Object.keys(row.produced).length > 0)
      : Object.keys(globalProduced).length > 0);

  return (
    <div className="rounded-xl border border-emerald-500/25 bg-gradient-to-b from-emerald-500/[0.06] to-transparent p-4 space-y-4">
      <div className="flex items-start gap-2">
        {terminalStatus === 'skipped' ? (
          <SkipForward size={18} className="shrink-0 text-muted-foreground mt-0.5" />
        ) : (
          <CheckCircle2 size={18} className="shrink-0 text-emerald-600 dark:text-emerald-400 mt-0.5" />
        )}
        <div>
          <h4 className="text-sm font-bold text-foreground">
            {terminalStatus === 'skipped' ? 'Step skipped' : 'Saved values & credentials'}
          </h4>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            {terminalStatus === 'skipped'
              ? 'Below is anything that was still recorded. Skipped steps usually have no outputs.'
              : 'What this step stored in your project plan. Secrets are never shown in plain text.'}
          </p>
        </div>
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

      <PortalLinksSection node={node} upstream={upstream} />

      {node.produces.length === 0 ? (
        <p className="text-xs text-muted-foreground">This step does not declare output fields.</p>
      ) : perEnv ? (
        <div className="space-y-4">
          {perEnv.map(({ env, state, produced }) => (
            <div key={env} className="rounded-lg border border-border bg-card/40 p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-bold font-mono text-foreground">{env}</span>
                <span className="text-[10px] uppercase font-bold text-muted-foreground">
                  {state?.status ?? 'not-started'}
                </span>
              </div>
              <div className="space-y-2">
                {node.produces.map((resource) => (
                  <ResourceRow
                    key={`${env}-${resource.key}`}
                    resource={resource}
                    value={produced[resource.key]}
                    upstream={upstream}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          {node.produces.map((resource) => (
            <ResourceRow
              key={resource.key}
              resource={resource}
              value={globalProduced[resource.key]}
              upstream={upstream}
            />
          ))}
        </div>
      )}

      {!hasAnyProduced && node.produces.length > 0 && terminalStatus === 'skipped' ? (
        <p className="text-[11px] text-muted-foreground">No outputs were captured for this step.</p>
      ) : null}
    </div>
  );
}
