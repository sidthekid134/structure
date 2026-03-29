import { AnimatePresence, motion } from 'framer-motion';
import { AlertCircle, CheckCircle2, Clock, Loader2, MinusCircle, PauseCircle, SkipForward, Zap } from 'lucide-react';
import type { NodeStatus, ProjectSetupStep, SetupPlanStepStatus } from './types';

// ---------------------------------------------------------------------------
// Legacy StepTimeline (provider setup steps — unchanged)
// ---------------------------------------------------------------------------

export function StepTimeline({ steps, stepStatuses }: { steps: ProjectSetupStep[]; stepStatuses: Record<string, SetupPlanStepStatus> }) {
  return (
    <div className="space-y-1.5">
      {steps.map((step, idx) => {
        const status = stepStatuses[step.id] ?? 'idle';
        const isLast = idx === steps.length - 1;
        return (
          <div key={step.id} className="relative pl-7">
            {!isLast && <div className="absolute left-2 top-7 bottom-[-8px] w-px bg-border" />}
            <div
              className={`absolute -left-1 top-2 z-10 w-6 h-6 rounded-full border flex items-center justify-center shadow-sm transition-all ${
                status === 'completed'
                  ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                  : status === 'in_progress'
                    ? 'border-primary/40 bg-primary/10 text-primary'
                    : status === 'failed'
                      ? 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400'
                      : 'border-border bg-background text-muted-foreground'
              }`}
            >
              <AnimatePresence mode="wait" initial={false}>
                {status === 'completed' ? (
                  <motion.span key="c" initial={{ scale: 0.6 }} animate={{ scale: 1 }} exit={{ scale: 0.6 }} transition={{ duration: 0.15 }}>
                    <CheckCircle2 size={12} />
                  </motion.span>
                ) : status === 'in_progress' ? (
                  <motion.span key="p" initial={{ scale: 0.8 }} animate={{ scale: 1 }} exit={{ scale: 0.8 }} transition={{ duration: 0.15 }}>
                    <Loader2 size={12} className="animate-spin" />
                  </motion.span>
                ) : status === 'failed' ? (
                  <motion.span key="f" initial={{ scale: 0.7 }} animate={{ scale: 1 }} exit={{ scale: 0.7 }} transition={{ duration: 0.15 }}>
                    <AlertCircle size={12} />
                  </motion.span>
                ) : (
                  <motion.span key="i" className="text-[10px] font-bold leading-none">{idx + 1}</motion.span>
                )}
              </AnimatePresence>
            </div>
            <div className="rounded-lg border border-border bg-background px-3 py-2">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold">{step.label}</p>
                <span className={`text-[10px] font-semibold ${
                  status === 'completed' ? 'text-emerald-600 dark:text-emerald-400' :
                  status === 'in_progress' ? 'text-primary' :
                  status === 'failed' ? 'text-red-600 dark:text-red-400' :
                  'text-muted-foreground'
                }`}>
                  {status === 'completed' ? 'Done' : status === 'in_progress' ? 'Running…' : status === 'failed' ? 'Failed' : 'Pending'}
                </span>
              </div>
              <p className="text-[11px] text-muted-foreground mt-0.5">{step.description}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// NodeStatusTimeline — new step-level graph timeline
// ---------------------------------------------------------------------------

interface NodeTimelineStep {
  key: string;
  label: string;
  description: string;
  nodeType: 'step' | 'user-action';
  environment?: string;
  automationLevel?: 'full' | 'assisted' | 'manual';
}

interface NodeStatusTimelineProps {
  steps: NodeTimelineStep[];
  statuses: Record<string, NodeStatus>;
  onUserActionComplete?: (nodeKey: string) => void;
}

export function NodeStatusTimeline({ steps, statuses, onUserActionComplete }: NodeStatusTimelineProps) {
  return (
    <div className="space-y-1">
      {steps.map((step, idx) => {
        const stateKey = step.environment ? `${step.key}@${step.environment}` : step.key;
        const status: NodeStatus = statuses[stateKey] ?? statuses[step.key] ?? 'not-started';
        const isLast = idx === steps.length - 1;

        return (
          <div key={stateKey} className="relative pl-8">
            {!isLast && (
              <div
                className={`absolute left-3 top-7 bottom-[-4px] w-px transition-colors duration-500 ${
                  status === 'completed' || status === 'skipped' ? 'bg-emerald-500/40' : 'bg-border'
                }`}
              />
            )}

            {/* Status icon */}
            <div
              className={`absolute left-0 top-2 z-10 w-6 h-6 rounded-full border-2 flex items-center justify-center shadow-sm transition-all duration-300 ${nodeStatusStyle(status)}`}
            >
              <AnimatePresence mode="wait" initial={false}>
                <motion.span
                  key={status}
                  initial={{ scale: 0.6, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  exit={{ scale: 0.6, opacity: 0 }}
                  transition={{ duration: 0.15 }}
                >
                  {nodeStatusIcon(status)}
                </motion.span>
              </AnimatePresence>
            </div>

            {/* Card */}
            <div
              className={`rounded-lg border px-3 py-2 mb-1.5 transition-all duration-300 ${
                status === 'waiting-on-user'
                  ? 'border-amber-500/40 bg-amber-500/5'
                  : status === 'resolving'
                    ? 'border-cyan-500/40 bg-cyan-500/5'
                    : status === 'in-progress'
                      ? 'border-primary/30 bg-primary/5'
                      : status === 'completed'
                        ? 'border-emerald-500/30 bg-emerald-500/5'
                        : status === 'failed'
                          ? 'border-red-500/30 bg-red-500/5'
                          : 'border-border bg-background'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <p className={`text-xs font-semibold truncate ${status === 'blocked' || status === 'not-started' ? 'text-muted-foreground' : 'text-foreground'}`}>
                    {step.label}
                  </p>
                  {step.environment && (
                    <span className="shrink-0 text-[9px] font-mono bg-muted px-1.5 py-0.5 rounded border border-border text-muted-foreground">
                      {step.environment}
                    </span>
                  )}
                  {step.nodeType === 'user-action' && (
                    <span className="shrink-0 text-[9px] font-bold bg-amber-500/10 border border-amber-500/30 text-amber-600 dark:text-amber-400 px-1.5 py-0.5 rounded">
                      USER
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {nodeStatusBadge(status)}
                  {status === 'waiting-on-user' && onUserActionComplete && (
                    <button
                      type="button"
                      onClick={() => onUserActionComplete(step.key)}
                      className="text-[10px] font-bold bg-amber-500 text-white px-2 py-0.5 rounded hover:bg-amber-600 transition-colors"
                    >
                      Mark Done
                    </button>
                  )}
                </div>
              </div>
              <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">{step.description}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function nodeStatusStyle(status: NodeStatus): string {
  switch (status) {
    case 'completed':
      return 'border-emerald-500 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400';
    case 'in-progress':
      return 'border-primary bg-primary/10 text-primary';
    case 'resolving':
      return 'border-cyan-500 bg-cyan-500/10 text-cyan-600 dark:text-cyan-400';
    case 'waiting-on-user':
      return 'border-amber-500 bg-amber-500/10 text-amber-600 dark:text-amber-400';
    case 'failed':
      return 'border-red-500 bg-red-500/10 text-red-600 dark:text-red-400';
    case 'ready':
      return 'border-blue-500 bg-blue-500/10 text-blue-600 dark:text-blue-400';
    case 'skipped':
      return 'border-muted-foreground/40 bg-muted text-muted-foreground';
    case 'blocked':
    case 'not-started':
    default:
      return 'border-border bg-background text-muted-foreground';
  }
}

function nodeStatusIcon(status: NodeStatus): React.ReactNode {
  switch (status) {
    case 'completed':
      return <CheckCircle2 size={12} />;
    case 'in-progress':
      return <Loader2 size={12} className="animate-spin" />;
    case 'resolving':
      return <Zap size={12} className="animate-pulse" />;
    case 'waiting-on-user':
      return <PauseCircle size={12} />;
    case 'failed':
      return <AlertCircle size={12} />;
    case 'ready':
      return <Clock size={12} />;
    case 'skipped':
      return <SkipForward size={12} />;
    case 'blocked':
      return <MinusCircle size={11} />;
    default:
      return <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/30 block" />;
  }
}

function nodeStatusBadge(status: NodeStatus): React.ReactNode {
  const cfg: Record<NodeStatus, { label: string; className: string }> = {
    completed: { label: 'Done', className: 'text-emerald-600 dark:text-emerald-400' },
    'in-progress': { label: 'Running…', className: 'text-primary animate-pulse' },
    resolving: { label: 'Auto-resolving', className: 'text-cyan-600 dark:text-cyan-400 animate-pulse' },
    'waiting-on-user': { label: 'Action Required', className: 'text-amber-600 dark:text-amber-400' },
    failed: { label: 'Failed', className: 'text-red-600 dark:text-red-400' },
    ready: { label: 'Ready', className: 'text-blue-600 dark:text-blue-400' },
    blocked: { label: 'Blocked', className: 'text-muted-foreground' },
    skipped: { label: 'Skipped', className: 'text-muted-foreground' },
    'not-started': { label: 'Pending', className: 'text-muted-foreground' },
  };
  const { label, className } = cfg[status] ?? { label: status, className: 'text-muted-foreground' };
  return <span className={`text-[10px] font-semibold ${className}`}>{label}</span>;
}

// React import for JSX (needed for inline return types)
import type React from 'react';
