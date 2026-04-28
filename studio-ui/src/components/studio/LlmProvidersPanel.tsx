/**
 * LlmProvidersPanel — read-only summary of the project's LLM provider
 * configuration. The actual configuration flow lives in the Setup tab; this
 * panel is a focused dashboard that surfaces:
 *
 *   - which LLM kind modules (`llm-openai`, `llm-anthropic`, `llm-gemini`,
 *     `llm-custom`) are part of this project's plan
 *   - per-kind status derived from the plan's user-action state
 *   - per-kind default model + available models populated by credential upload
 *
 * Configuration actions (provide API key) jump the user to the Setup tab so
 * we don't duplicate that wizard's logic here.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  ExternalLink,
  RefreshCw,
  Sparkles,
  XCircle,
} from 'lucide-react';
import { api } from './helpers';
import type { ModuleId, NodeState, ProvisioningPlanResponse } from './types';

type LlmKindId = 'openai' | 'anthropic' | 'gemini' | 'custom';

interface LlmKindMeta {
  id: LlmKindId;
  moduleId: string;
  label: string;
  description: string;
  userActionKey: string;
  docs?: string;
}

const LLM_KINDS: LlmKindMeta[] = [
  {
    id: 'openai',
    moduleId: 'llm-openai',
    label: 'OpenAI',
    description: 'GPT-4o and other OpenAI models.',
    userActionKey: 'user:provide-openai-api-key',
    docs: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'anthropic',
    moduleId: 'llm-anthropic',
    label: 'Anthropic Claude',
    description: 'Claude Sonnet, Opus, and Haiku.',
    userActionKey: 'user:provide-anthropic-api-key',
    docs: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'gemini',
    moduleId: 'llm-gemini',
    label: 'Google Gemini',
    description: 'Gemini 1.5 Pro and Flash.',
    userActionKey: 'user:provide-gemini-api-key',
    docs: 'https://aistudio.google.com/app/apikey',
  },
  {
    id: 'custom',
    moduleId: 'llm-custom',
    label: 'Custom OpenAI-compatible',
    description: 'Any OpenAI-compatible inference endpoint (vLLM, LM Studio, …).',
    userActionKey: 'user:provide-custom-llm-credentials',
  },
];

type KindStatus =
  | 'configured'
  | 'pending-verification'
  | 'failed'
  | 'not-started'
  | 'not-included';

interface KindSummary {
  meta: LlmKindMeta;
  status: KindStatus;
  included: boolean;
  userActionState?: NodeState;
  defaultModel?: string;
  availableModels?: string;
}

function classifyKindStatus(
  included: boolean,
  userActionState: NodeState | undefined,
): KindStatus {
  if (!included) return 'not-included';
  if (userActionState?.status === 'failed') return 'failed';
  if (userActionState?.status === 'completed') return 'configured';
  if (
    userActionState?.status === 'in-progress' ||
    userActionState?.status === 'waiting-on-user'
  ) {
    return 'pending-verification';
  }
  return 'not-started';
}

function statusBadge(status: KindStatus): { label: string; className: string; Icon: typeof CheckCircle2 } {
  switch (status) {
    case 'configured':
      return {
        label: 'Configured',
        className:
          'text-emerald-700 dark:text-emerald-300 bg-emerald-500/10 border-emerald-500/30',
        Icon: CheckCircle2,
      };
    case 'pending-verification':
      return {
        label: 'In progress',
        className: 'text-amber-700 dark:text-amber-300 bg-amber-500/10 border-amber-500/30',
        Icon: RefreshCw,
      };
    case 'failed':
      return {
        label: 'Failed',
        className: 'text-red-700 dark:text-red-300 bg-red-500/10 border-red-500/30',
        Icon: XCircle,
      };
    case 'not-included':
      return {
        label: 'Not in plan',
        className: 'text-muted-foreground bg-muted/40 border-border',
        Icon: AlertCircle,
      };
    default:
      return {
        label: 'Not configured',
        className: 'text-muted-foreground bg-muted/40 border-border',
        Icon: AlertCircle,
      };
  }
}

export function LlmProvidersPanel({
  projectId,
  onJumpToSetup,
  onJumpToModules,
  effectiveSelectedModules,
}: {
  projectId: string;
  /** Optional — when provided, action buttons jump to the project's Setup tab. */
  onJumpToSetup?: () => void;
  /** Optional — when provided, the "add module" CTA jumps to the Modules tab. */
  onJumpToModules?: () => void;
  /**
   * When set (e.g. pending picks from Modules that are not saved yet), which LLM kinds count as included.
   * Otherwise inclusion follows the loaded plan (`plan.selectedModules`).
   */
  effectiveSelectedModules?: ModuleId[];
}) {
  const [plan, setPlan] = useState<ProvisioningPlanResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadPlan = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = await api<ProvisioningPlanResponse>(
        `/api/projects/${encodeURIComponent(projectId)}/provisioning/plan`,
      );
      setPlan(payload);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void loadPlan();
  }, [loadPlan]);

  const selectedModules = useMemo(() => {
    const ids =
      effectiveSelectedModules !== undefined
        ? effectiveSelectedModules
        : ((plan?.selectedModules as ModuleId[] | undefined) ?? []);
    return new Set(ids);
  }, [plan?.selectedModules, effectiveSelectedModules]);
  const anyKindIncluded = useMemo(
    () => LLM_KINDS.some((k) => selectedModules.has(k.moduleId)),
    [selectedModules],
  );

  const kindSummaries: KindSummary[] = useMemo(() => {
    const states = plan?.nodeStates ?? {};
    return LLM_KINDS.map((meta) => {
      const included = selectedModules.has(meta.moduleId);
      const userActionState = states[meta.userActionKey];
      return {
        meta,
        included,
        status: classifyKindStatus(included, userActionState),
        userActionState,
        defaultModel: userActionState?.resourcesProduced?.[`llm_${meta.id}_default_model`],
        availableModels: userActionState?.resourcesProduced?.[`llm_${meta.id}_models_available`],
      };
    });
  }, [plan, selectedModules]);

  if (loading && !plan) {
    return (
      <div className="rounded-2xl border border-border bg-card p-6 text-sm text-muted-foreground">
        Loading project plan…
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-2xl border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-700 dark:text-red-300 flex items-start gap-2">
        <AlertCircle size={16} className="mt-0.5 shrink-0" />
        <div className="space-y-2">
          <p>{error}</p>
          <button
            type="button"
            onClick={() => void loadPlan()}
            className="px-3 py-1.5 text-xs font-bold border border-border rounded-lg hover:bg-accent transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-border bg-gradient-to-br from-emerald-500/[0.06] via-card to-card p-5 sm:p-6 shadow-sm">
        <div className="flex items-start gap-3">
          <div className="shrink-0 flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-600 ring-1 ring-emerald-500/20">
            <Sparkles size={22} strokeWidth={2} />
          </div>
          <div className="min-w-0">
            <h2 className="text-lg font-bold tracking-tight text-foreground">
              AI / LLM Providers
            </h2>
            <p className="text-sm text-muted-foreground mt-1.5 max-w-2xl leading-relaxed">
              Each LLM kind is its own selectable module — pick OpenAI, Anthropic Claude,
              Google Gemini, and/or a custom OpenAI-compatible endpoint from the Modules
              tab. Credentials are stored encrypted at rest and verified by listing models
              against each provider's API.
            </p>
          </div>
        </div>
      </div>

      {/* ── No-kinds-included banner ───────────────────────────────────── */}
      {!anyKindIncluded && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/[0.06] p-4 flex items-start gap-3">
          <AlertCircle size={18} className="text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-foreground">
              No LLM provider modules are part of this project's plan yet.
            </p>
            <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
              Open the <span className="font-semibold">Modules</span> tab and pick one or
              more of the AI &amp; LLMs modules to add the corresponding credential and
              default-model selection steps to the plan.
            </p>
            {onJumpToModules && (
              <button
                type="button"
                onClick={onJumpToModules}
                className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300 hover:bg-amber-500/15 transition-colors"
              >
                Open Modules
                <ArrowRight size={12} />
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── Per-kind grid ──────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {kindSummaries.map((kind) => {
          const badge = statusBadge(kind.status);
          const BadgeIcon = badge.Icon;
          const errMsg = kind.userActionState?.error;
          return (
            <div
              key={kind.meta.id}
              className={`rounded-xl border p-4 flex flex-col gap-3 ${
                kind.included
                  ? 'border-border bg-card'
                  : 'border-dashed border-border/60 bg-muted/20'
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-bold text-foreground">{kind.meta.label}</p>
                  <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                    {kind.meta.description}
                  </p>
                </div>
                <span
                  className={`inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide px-2 py-1 rounded-full border whitespace-nowrap ${badge.className}`}
                >
                  <BadgeIcon size={10} />
                  {badge.label}
                </span>
              </div>

              {kind.included && (kind.defaultModel || kind.availableModels) && (
                <div className="text-[11px] text-muted-foreground border border-border/60 rounded-md px-2.5 py-2 bg-muted/20 space-y-1">
                  {kind.defaultModel && (
                    <p>
                      <span className="font-semibold text-foreground">Default:</span>{' '}
                      <code className="font-mono text-[11px]">{kind.defaultModel}</code>
                    </p>
                  )}
                  {kind.availableModels && (
                    <p className="break-words">
                      <span className="font-semibold text-foreground">Available:</span>{' '}
                      {kind.availableModels}
                    </p>
                  )}
                </div>
              )}

              {errMsg && (
                <div className="text-[11px] text-red-700 dark:text-red-300 bg-red-500/5 border border-red-500/20 rounded-md px-2 py-1.5 leading-snug">
                  {errMsg}
                </div>
              )}

              <div className="flex items-center gap-2 flex-wrap">
                {kind.included && onJumpToSetup && (
                  <button
                    type="button"
                    onClick={onJumpToSetup}
                    className="inline-flex items-center gap-1 text-[11px] font-bold rounded-md border border-border px-2.5 py-1.5 hover:bg-accent transition-colors"
                  >
                    Configure
                    <ArrowRight size={10} />
                  </button>
                )}
                {!kind.included && onJumpToModules && (
                  <button
                    type="button"
                    onClick={onJumpToModules}
                    className="inline-flex items-center gap-1 text-[11px] font-bold rounded-md border border-border px-2.5 py-1.5 hover:bg-accent transition-colors"
                  >
                    Add to plan
                    <ArrowRight size={10} />
                  </button>
                )}
                {kind.meta.docs && (
                  <a
                    href={kind.meta.docs}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Get an API key
                    <ExternalLink size={10} />
                  </a>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <p className="text-[11px] text-muted-foreground/70 leading-relaxed">
        Each LLM kind is registered as its own plugin (
        <code className="font-mono text-[10px] bg-muted/50 px-1 py-0.5 rounded">llm-openai</code>,{' '}
        <code className="font-mono text-[10px] bg-muted/50 px-1 py-0.5 rounded">llm-anthropic</code>,{' '}
        <code className="font-mono text-[10px] bg-muted/50 px-1 py-0.5 rounded">llm-gemini</code>,{' '}
        <code className="font-mono text-[10px] bg-muted/50 px-1 py-0.5 rounded">llm-custom</code>) and
        contributes its own per-kind credential gate to the project plan when
        included (default model is chosen when credentials are validated). Status
        reflects the latest gate completion state.
      </p>
    </div>
  );
}
