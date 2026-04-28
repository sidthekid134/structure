import { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  CheckCheck,
  CheckCircle2,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  Globe,
  Info,
  Link2,
  Loader2,
  ShieldCheck,
  Unlink,
  X,
} from 'lucide-react';

interface CloudflareIntegrationFlowProps {
  isConnected: boolean;
  onClose: () => void;
  onConnect: (fields: Record<string, string>) => Promise<void>;
  onDisconnect: () => Promise<void>;
}

type CloudflareStepId = 'token-overview' | 'token-permissions' | 'paste-token' | 'review';

interface CloudflareStep {
  id: CloudflareStepId;
  title: string;
  subtitle: string;
}

const STEPS: CloudflareStep[] = [
  { id: 'token-overview', title: 'Open API Tokens', subtitle: 'Start in Cloudflare dashboard' },
  { id: 'token-permissions', title: 'Set permissions', subtitle: 'Use least-privilege zone access' },
  { id: 'paste-token', title: 'Paste token', subtitle: 'Connect in Studio organization scope' },
  { id: 'review', title: 'Review and connect', subtitle: 'Validate and store token' },
];

function validateStep(stepId: CloudflareStepId, token: string): string | null {
  if (stepId === 'paste-token') {
    if (!token.trim()) {
      return 'Cloudflare API token is required.';
    }
    if (token.trim().length < 20) {
      return 'Token looks too short. Paste the full Cloudflare API token value.';
    }
  }
  return null;
}

export function CloudflareIntegrationFlow({
  isConnected,
  onClose,
  onConnect,
  onDisconnect,
}: CloudflareIntegrationFlowProps) {
  const [stepIndex, setStepIndex] = useState(0);
  const [token, setToken] = useState('');
  const [revealToken, setRevealToken] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);

  const currentStep = STEPS[stepIndex];
  const fieldError = useMemo(() => validateStep(currentStep.id, token), [currentStep.id, token]);

  const handleBack = () => {
    setServerError(null);
    setStepIndex((idx) => Math.max(0, idx - 1));
  };

  const handleNext = () => {
    if (fieldError) return;
    setServerError(null);
    setStepIndex((idx) => Math.min(STEPS.length - 1, idx + 1));
  };

  const handleSubmit = async () => {
    setServerError(null);
    setSubmitting(true);
    try {
      await onConnect({ cloudflareApiToken: token.trim() });
      setSubmitted(true);
      setTimeout(() => onClose(), 900);
    } catch (err) {
      setServerError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      await onDisconnect();
      onClose();
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/55" onClick={onClose}>
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 12 }}
        transition={{ duration: 0.2, ease: 'easeOut' }}
        className="bg-background border border-border rounded-2xl shadow-2xl w-full max-w-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between p-6 border-b border-border">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-orange-500/10 flex items-center justify-center shrink-0">
              <Globe size={20} className="text-orange-500" />
            </div>
            <div>
              <h2 className="font-bold text-base tracking-tight">Cloudflare</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                {isConnected ? (
                  <span className="flex items-center gap-1 text-emerald-500 font-medium">
                    <CheckCircle2 size={11} />
                    <span>Connected</span>
                  </span>
                ) : (
                  <span>Four-step setup for org-level token</span>
                )}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-accent transition-colors text-muted-foreground"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        {isConnected && !submitted ? (
          <ConnectedSummary
            disconnecting={disconnecting}
            onDisconnect={() => void handleDisconnect()}
            onClose={onClose}
          />
        ) : (
          <>
            <Stepper steps={STEPS} currentIndex={stepIndex} />
            <div className="p-6 space-y-5 max-h-[55vh] overflow-y-auto">
              <AnimatePresence mode="wait">
                <motion.div
                  key={currentStep.id}
                  initial={{ opacity: 0, x: 12 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -12 }}
                  transition={{ duration: 0.18 }}
                  className="space-y-4"
                >
                  <StepBody
                    step={currentStep}
                    token={token}
                    revealToken={revealToken}
                    setRevealToken={setRevealToken}
                    onTokenChange={setToken}
                  />

                  {fieldError && currentStep.id !== 'review' && (
                    <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                      <AlertCircle size={13} className="shrink-0 mt-0.5" />
                      <span>{fieldError}</span>
                    </div>
                  )}

                  {serverError && (
                    <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400">
                      <AlertCircle size={13} className="shrink-0 mt-0.5" />
                      <span>{serverError}</span>
                    </div>
                  )}
                </motion.div>
              </AnimatePresence>
            </div>

            <div className="flex items-center justify-between gap-3 p-5 border-t border-border bg-muted/20">
              <button
                type="button"
                onClick={handleBack}
                disabled={stepIndex === 0 || submitting}
                className="inline-flex items-center gap-1.5 text-xs font-bold px-3 py-2 rounded-lg border border-border hover:bg-accent transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <ArrowLeft size={13} />
                <span>Back</span>
              </button>
              <span className="text-[11px] text-muted-foreground">
                Step {stepIndex + 1} of {STEPS.length}
              </span>
              {currentStep.id === 'review' ? (
                <button
                  type="button"
                  onClick={() => void handleSubmit()}
                  disabled={submitting || submitted || !token.trim()}
                  className="inline-flex items-center gap-2 bg-primary text-primary-foreground px-5 py-2.5 rounded-lg text-sm font-bold hover:opacity-90 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {submitted ? (
                    <>
                      <CheckCircle2 size={14} />
                      <span>Connected</span>
                    </>
                  ) : submitting ? (
                    <>
                      <Loader2 size={14} className="animate-spin" />
                      <span>Verifying token...</span>
                    </>
                  ) : (
                    <>
                      <Link2 size={14} />
                      <span>Connect Cloudflare</span>
                      <ArrowRight size={13} />
                    </>
                  )}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleNext}
                  disabled={Boolean(fieldError)}
                  className="inline-flex items-center gap-2 bg-foreground text-background px-5 py-2.5 rounded-lg text-sm font-bold hover:opacity-90 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <span>Continue</span>
                  <ArrowRight size={13} />
                </button>
              )}
            </div>
          </>
        )}
      </motion.div>
    </div>
  );
}

function Stepper({ steps, currentIndex }: { steps: CloudflareStep[]; currentIndex: number }) {
  return (
    <div className="px-6 pt-4 pb-3 border-b border-border bg-muted/20">
      <ol className="flex items-center gap-2">
        {steps.map((step, idx) => {
          const isCurrent = idx === currentIndex;
          const isComplete = idx < currentIndex;
          return (
            <li key={step.id} className="flex-1 flex items-center gap-2 min-w-0">
              <div
                className={`flex items-center justify-center w-6 h-6 rounded-full border text-[10px] font-bold transition-colors ${
                  isComplete
                    ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-600 dark:text-emerald-400'
                    : isCurrent
                      ? 'bg-primary/10 border-primary/40 text-primary'
                      : 'bg-background border-border text-muted-foreground'
                }`}
              >
                {isComplete ? <CheckCircle2 size={12} /> : idx + 1}
              </div>
              <div className="min-w-0 hidden md:block">
                <p
                  className={`text-[11px] font-semibold leading-tight truncate ${
                    isCurrent ? 'text-foreground' : 'text-muted-foreground'
                  }`}
                >
                  {step.title}
                </p>
              </div>
              {idx < steps.length - 1 && (
                <div className={`flex-1 h-px ${isComplete ? 'bg-emerald-500/40' : 'bg-border'}`} />
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function StepBody({
  step,
  token,
  revealToken,
  setRevealToken,
  onTokenChange,
}: {
  step: CloudflareStep;
  token: string;
  revealToken: boolean;
  setRevealToken: (value: boolean) => void;
  onTokenChange: (value: string) => void;
}) {
  switch (step.id) {
    case 'token-overview':
      return (
        <StepShell
          step={step}
          link={{
            label: 'Open Cloudflare API Tokens',
            href: 'https://dash.cloudflare.com/profile/api-tokens',
          }}
          instructions={[
            'Sign in to Cloudflare Dashboard using an account with permission to create API tokens.',
            'Open My Profile -> API Tokens.',
            'Click Create Token to start a new token for Studio organization provisioning.',
          ]}
          note="This token is the organization-level default in Studio. Individual projects can provide their own scoped Cloudflare token override in Setup when stricter zone isolation is needed."
        >
          <div className="grid gap-2">
            <CopyableValue
              label="Copyable token name"
              value="Studio Org Default Cloudflare Token"
            />
            <CopyableValue
              label="Copyable token verify command"
              value={'curl "https://api.cloudflare.com/client/v4/user/tokens/verify" --header "Authorization: Bearer <API_TOKEN>"'}
            />
          </div>
        </StepShell>
      );
    case 'token-permissions':
      return (
        <StepShell
          step={step}
          link={{
            label: 'Cloudflare token permission reference',
            href: 'https://developers.cloudflare.com/fundamentals/api/reference/permissions',
          }}
          instructions={[
            'Use either the Edit zone DNS template or Custom token.',
            'In each permission row, set the first dropdown to Zone (not Account).',
            'Add the exact Zone permission rows listed below.',
            'Restrict Zone Resources to apex zones Studio should manage.',
            'For subdomain apps (for example flow.example.com), include the root zone (example.com).',
            'Create token and copy the secret immediately (Cloudflare only shows it once).',
          ]}
          warning="Avoid all-zones scope unless required. Least-privilege tokens reduce blast radius."
        >
          <div className="grid gap-2">
            <CopyableValue
              label="Copyable permission rows (Group | Permission | Access)"
              value={
                'Zone | DNS | Edit\n' +
                'Zone | Zone | Read\n' +
                'Zone | Page Rules | Edit\n' +
                'Zone | Zone Settings | Edit'
              }
            />
            <CopyableValue
              label="Copyable zone resource guidance"
              value={
                'Organization default token: include only apex zones needed across projects.\n' +
                'Project override token: include exactly one apex zone for that project.'
              }
            />
            <CopyableValue
              label="If Zone Settings is unavailable in your UI"
              value="Use: Zone | SSL and Certificates | Edit"
            />
            <CopyableValue
              label="Per-project override naming convention"
              value="Studio Project Cloudflare Token - <project-slug>"
            />
          </div>
        </StepShell>
      );
    case 'paste-token':
      return (
        <StepShell
          step={step}
          instructions={[
            'Paste the Cloudflare API token generated in the previous step.',
            'Studio verifies token validity before persisting it.',
            'If verification fails, re-check permission groups and zone resource scope.',
            'If you later add a project-scoped token in Setup, that token overrides this org default for that project.',
          ]}
        >
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-foreground">Cloudflare API token</label>
            <div className="relative">
              <input
                type={revealToken ? 'text' : 'password'}
                value={token}
                onChange={(e) => onTokenChange(e.target.value)}
                placeholder="cf_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                className="w-full px-3 py-2.5 rounded-lg border border-border bg-background font-mono text-[12px] focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all pr-10"
              />
              <button
                type="button"
                onClick={() => setRevealToken(!revealToken)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
              >
                {revealToken ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </div>
        </StepShell>
      );
    case 'review':
      return (
        <div className="space-y-4">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Final check</p>
            <h3 className="text-base font-bold tracking-tight mt-0.5">Review and connect</h3>
            <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
              Studio stores the token in the encrypted local vault at organization scope so Cloudflare DNS and zone
              steps can run across projects.
            </p>
          </div>
          <div className="rounded-xl border border-border bg-muted/30 divide-y divide-border">
            <SummaryRow label="Token status" value={token.trim() ? 'Present' : 'Missing'} />
            <SummaryRow label="Storage scope" value="Organization vault" />
            <SummaryRow label="Expected permissions" value="Zone:Read, Zone:Edit, DNS:Edit" />
          </div>
          <div className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-[11px] text-emerald-700 dark:text-emerald-300">
            <ShieldCheck size={13} className="shrink-0 mt-0.5" />
            <span>
              After connect, project-level Cloudflare steps can verify zone ownership and configure DNS, SSL, and auth
              routes automatically.
            </span>
          </div>
        </div>
      );
  }
}

function StepShell({
  step,
  instructions,
  link,
  note,
  warning,
  children,
}: {
  step: CloudflareStep;
  instructions: string[];
  link?: { label: string; href: string };
  note?: string;
  warning?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="space-y-4">
      <div>
        <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{step.subtitle}</p>
        <h3 className="text-base font-bold tracking-tight mt-0.5">{step.title}</h3>
      </div>
      <ol className="space-y-1.5 list-decimal list-inside text-xs text-muted-foreground leading-relaxed">
        {instructions.map((instruction, idx) => (
          <li key={idx}>{instruction}</li>
        ))}
      </ol>
      {note && (
        <div className="flex items-start gap-2 rounded-lg border border-blue-500/30 bg-blue-500/5 px-3 py-2 text-[11px] text-blue-700 dark:text-blue-300">
          <Info size={12} className="shrink-0 mt-0.5" />
          <span>{note}</span>
        </div>
      )}
      {warning && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">
          <AlertCircle size={12} className="shrink-0 mt-0.5" />
          <span>{warning}</span>
        </div>
      )}
      {link && (
        <a
          href={link.href}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary hover:underline"
        >
          <ExternalLink size={12} />
          <span>{link.label}</span>
        </a>
      )}
      {children}
    </div>
  );
}

function ConnectedSummary({
  disconnecting,
  onDisconnect,
  onClose,
}: {
  disconnecting: boolean;
  onDisconnect: () => void;
  onClose: () => void;
}) {
  return (
    <div className="p-6 space-y-5">
      <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 flex items-center gap-3">
        <CheckCircle2 size={18} className="text-emerald-500 shrink-0" />
        <div>
          <p className="text-sm font-bold text-emerald-600 dark:text-emerald-400">Cloudflare integration active</p>
          <p className="text-[11px] text-emerald-600/80 dark:text-emerald-400/80 mt-0.5">
            Organization token is configured. Projects can reuse it for zone and DNS automation.
          </p>
        </div>
      </div>
      <div className="rounded-xl border border-border bg-muted/30 divide-y divide-border">
        <SummaryRow label="Token scope" value="Organization vault" />
        <SummaryRow label="Provider" value="Cloudflare API v4" />
        <SummaryRow label="Status" value="Configured" />
      </div>
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={onDisconnect}
          disabled={disconnecting}
          className="inline-flex items-center gap-1.5 text-xs font-bold text-red-500 hover:text-red-400 px-3 py-2 border border-red-500/30 rounded-lg hover:bg-red-500/10 transition-colors disabled:opacity-50"
        >
          {disconnecting ? <Loader2 size={13} className="animate-spin" /> : <Unlink size={13} />}
          <span>Disconnect Cloudflare</span>
        </button>
        <button
          type="button"
          onClick={onClose}
          className="text-xs font-bold px-4 py-2 border border-border rounded-lg hover:bg-accent transition-colors"
        >
          Done
        </button>
      </div>
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-xs font-mono text-foreground truncate text-right">{value}</span>
    </div>
  );
}

function CopyableValue({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-lg border border-border bg-muted/30 px-3 py-2">
      <div className="flex items-center justify-between gap-2 mb-1">
        <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{label}</span>
        <button
          type="button"
          onClick={async () => {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          }}
          className="inline-flex items-center gap-1 text-[10px] font-semibold text-muted-foreground hover:text-foreground transition-colors"
        >
          {copied ? <CheckCheck size={12} className="text-emerald-500" /> : <Copy size={12} />}
          <span>{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
      <pre className="text-[11px] font-mono text-foreground whitespace-pre-wrap break-all">{value}</pre>
    </div>
  );
}
