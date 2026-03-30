import { AnimatePresence, motion } from 'framer-motion';
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import type { ProjectSetupStep, SetupPlanStepStatus } from './types';

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

