import { AlertTriangle, CheckCircle2, ExternalLink, Loader2, Trash2 } from 'lucide-react';
import type { ProvisioningPlanResponse, ProvisioningStepNode } from './types';

function isTeardownStep(node: ProvisioningPlanResponse['nodes'][number]): node is ProvisioningStepNode {
  return node.type === 'step' && node.direction === 'teardown';
}

const PROVIDER_CONSOLE_LINKS: Record<string, string> = {
  firebase: 'https://console.firebase.google.com/',
  github: 'https://github.com/settings/installations',
  eas: 'https://expo.dev/',
  apple: 'https://appstoreconnect.apple.com/',
  'google-play': 'https://play.google.com/console/',
  cloudflare: 'https://dash.cloudflare.com/',
  oauth: 'https://console.cloud.google.com/apis/credentials',
};

export function TeardownWizard({
  plan,
  isRunning,
  onRun,
}: {
  plan: ProvisioningPlanResponse | null;
  isRunning: boolean;
  onRun: () => Promise<void>;
}) {
  const teardownSteps = (plan?.nodes ?? []).filter(isTeardownStep);
  const total = teardownSteps.length;
  const completed = teardownSteps.filter((step) => {
    const status = plan?.nodeStates[step.key]?.status ?? 'not-started';
    return status === 'completed' || status === 'skipped';
  }).length;

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-4">
        <div className="flex items-start gap-3">
          <AlertTriangle size={18} className="text-red-500 mt-0.5 shrink-0" />
          <div>
            <h3 className="text-sm font-semibold text-red-700 dark:text-red-400">
              Infrastructure Teardown
            </h3>
            <p className="text-xs text-red-700/80 dark:text-red-300/80 mt-1">
              This flow deletes external resources in reverse dependency order. Review each step
              carefully before running cleanup.
            </p>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-4">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h4 className="text-sm font-semibold">Teardown Plan</h4>
            <p className="text-xs text-muted-foreground mt-0.5">
              {completed}/{total} completed
            </p>
          </div>
          <button
            type="button"
            onClick={() => void onRun()}
            disabled={isRunning || total === 0}
            className="inline-flex items-center gap-2 rounded-lg bg-red-600 text-white px-3 py-2 text-xs font-bold hover:bg-red-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isRunning ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
            {isRunning ? 'Running...' : 'Run Teardown'}
          </button>
        </div>

        {total === 0 ? (
          <p className="text-xs text-muted-foreground">No teardown steps are currently available.</p>
        ) : (
          <div className="space-y-2">
            {teardownSteps.map((step, index) => {
              const status = plan?.nodeStates[step.key]?.status ?? 'not-started';
              const done = status === 'completed' || status === 'skipped';
              const link = PROVIDER_CONSOLE_LINKS[step.provider];
              return (
                <div
                  key={step.key}
                  className={`rounded-lg border px-3 py-2 ${
                    done ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-border'
                  }`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold">
                        {index + 1}. {step.label}
                      </p>
                      <p className="text-[11px] text-muted-foreground mt-0.5">{step.description}</p>
                    </div>
                    {done ? (
                      <CheckCircle2 size={14} className="text-emerald-500 shrink-0" />
                    ) : (
                      <span className="text-[10px] px-1.5 py-0.5 rounded border border-border text-muted-foreground uppercase font-bold shrink-0">
                        {status.replace('-', ' ')}
                      </span>
                    )}
                  </div>
                  {link && (
                    <a
                      href={link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-[11px] text-red-600 dark:text-red-400 mt-2 hover:underline"
                    >
                      <ExternalLink size={10} />
                      Open provider console
                    </a>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

