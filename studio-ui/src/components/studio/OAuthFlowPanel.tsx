import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  ScanSearch,
  Undo2,
  UserCheck,
  X,
  Zap,
} from 'lucide-react';
import { api } from './helpers';
import { useOAuthSession } from '../../hooks/useOAuthSession';
import type {
  GcpOAuthProjectDiscoverResult,
  GcpOAuthStepStatus,
} from './types';

// ---------------------------------------------------------------------------
// Per-step metadata — must match server cascade order
// ---------------------------------------------------------------------------

type OAuthStepId = GcpOAuthStepStatus['id'];

interface StepMeta {
  title: string;
  description: string;
  validates: string;
  revertLabel: string;
  revertBullet: string;
  revertWarning?: string;
  canRevert: boolean;
  icon: typeof Zap;
}

const STEP_META: Record<OAuthStepId, StepMeta> = {
  oauth_consent: {
    title: 'Google Authentication',
    description: 'Sign in with your Google account and authorize cloud-platform access.',
    validates: 'OAuth refresh token with cloud-platform scope',
    revertLabel: 'Disconnect',
    revertBullet: 'Clear vault credentials and reset Firebase integration (after GCP cleanup steps).',
    canRevert: true,
    icon: UserCheck,
  },
};

const STEP_ORDER: OAuthStepId[] = ['oauth_consent'];

// ---------------------------------------------------------------------------
// Individual step card
// ---------------------------------------------------------------------------

interface StepCardProps {
  step: GcpOAuthStepStatus;
  index: number;
  isLast: boolean;
  projectId: string;
  flowComplete: boolean;
  syncBusy: boolean;
  onSyncPipeline: () => void;
  onRequestRevert: (stepId: OAuthStepId) => void;
}

function StepCard({ step, index, isLast, projectId, flowComplete, syncBusy, onSyncPipeline, onRequestRevert }: StepCardProps) {
  const meta = STEP_META[step.id];
  const Icon = meta.icon;

  const [validateLoading, setValidateLoading] = useState(false);
  const [validateResult, setValidateResult] = useState<{ valid: boolean; message: string } | null>(null);

  const runValidate = async () => {
    setValidateLoading(true);
    setValidateResult(null);
    try {
      const res = await api<{ valid: boolean; message: string }>(
        `/api/projects/${encodeURIComponent(projectId)}/oauth/gcp/validate`,
        { method: 'POST' },
      );
      setValidateResult(res);
    } catch (err) {
      setValidateResult({ valid: false, message: (err as Error).message });
    } finally {
      setValidateLoading(false);
    }
  };

  const statusColor =
    step.status === 'completed'
      ? 'border-emerald-500 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
      : step.status === 'in_progress'
        ? 'border-primary bg-primary/10 text-primary'
        : step.status === 'failed'
          ? 'border-red-500 bg-red-500/10 text-red-600 dark:text-red-400'
          : 'border-border bg-background text-muted-foreground';

  const cardBorder =
    step.status === 'completed'
      ? 'border-emerald-500/30 bg-emerald-500/5'
      : step.status === 'in_progress'
        ? 'border-primary/30 bg-primary/5'
        : step.status === 'failed'
          ? 'border-red-500/30 bg-red-500/5'
          : 'border-border bg-muted/20';

  const showActions = flowComplete && step.status === 'completed';

  return (
    <div className="relative pl-9">
      {!isLast && (
        <div
          className={`absolute left-[14px] top-8 bottom-[-4px] w-px transition-colors duration-500 ${
            step.status === 'completed' ? 'bg-emerald-500/40' : 'bg-border'
          }`}
        />
      )}

      <div
        className={`absolute left-0 top-2 z-10 w-[30px] h-[30px] rounded-full border-2 flex items-center justify-center shadow-sm transition-all duration-300 ${statusColor}`}
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={step.status}
            initial={{ scale: 0.5, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.5, opacity: 0 }}
            transition={{ duration: 0.15 }}
          >
            {step.status === 'completed' ? (
              <CheckCircle2 size={14} />
            ) : step.status === 'in_progress' ? (
              <Loader2 size={14} className="animate-spin" />
            ) : step.status === 'failed' ? (
              <AlertTriangle size={13} />
            ) : (
              <span className="text-[10px] font-bold leading-none">{index + 1}</span>
            )}
          </motion.span>
        </AnimatePresence>
      </div>

      <div className={`rounded-lg border px-3.5 py-3 mb-2 transition-all duration-300 ${cardBorder}`}>
        <div className="flex items-start gap-2.5">
          <Icon
            size={14}
            className={`shrink-0 mt-0.5 ${
              step.status === 'completed'
                ? 'text-emerald-500'
                : step.status === 'in_progress'
                  ? 'text-primary'
                  : step.status === 'failed'
                    ? 'text-red-500'
                    : 'text-muted-foreground/50'
            }`}
          />
          <div className="flex-grow min-w-0">
            <div className="flex items-center justify-between gap-2">
              <span
                className={`text-xs font-semibold ${
                  step.status === 'pending' ? 'text-muted-foreground' : 'text-foreground'
                }`}
              >
                {meta.title}
              </span>
              <span
                className={`text-[10px] font-bold shrink-0 ${
                  step.status === 'completed'
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : step.status === 'in_progress'
                      ? 'text-primary animate-pulse'
                      : step.status === 'failed'
                        ? 'text-red-600 dark:text-red-400'
                        : 'text-muted-foreground'
                }`}
              >
                {step.status === 'completed'
                  ? 'Done'
                  : step.status === 'in_progress'
                    ? 'Processing…'
                    : step.status === 'failed'
                      ? 'Failed'
                      : 'Pending'}
              </span>
            </div>

            <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">{meta.description}</p>

            {step.status === 'completed' && (
              <motion.div
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2, delay: 0.05 }}
                className="flex items-center gap-1.5 mt-1.5 text-[10px] text-muted-foreground"
              >
                <CheckCircle2 size={10} className="shrink-0 text-emerald-500/80" />
                <span className="font-medium text-emerald-700/90 dark:text-emerald-400/90">
                  {step.message || meta.validates}
                </span>
              </motion.div>
            )}

            {step.status === 'failed' && step.message && (
              <motion.div
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex items-start gap-1.5 mt-1.5 text-[10px] text-red-600 dark:text-red-400"
              >
                <AlertTriangle size={10} className="shrink-0 mt-0.5" />
                {step.message}
              </motion.div>
            )}

            {meta.revertWarning && (
              <p className="text-[10px] text-amber-700/90 dark:text-amber-400/90 mt-1.5">{meta.revertWarning}</p>
            )}

            <div className="flex flex-wrap items-center gap-2 mt-2.5 pt-2 border-t border-border/80">
              <button
                type="button"
                title="Run provisioning plan sync, then refresh Google sign-in validation"
                onClick={() => onSyncPipeline()}
                disabled={syncBusy}
                className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-1 rounded-md border border-sky-500/35 text-sky-800 dark:text-sky-300 bg-sky-500/10 hover:bg-sky-500/15 disabled:opacity-50"
              >
                {syncBusy ? <Loader2 size={10} className="animate-spin" /> : <ScanSearch size={10} />}
                Sync
              </button>
              {showActions && (
                <>
                  <button
                    type="button"
                    onClick={() => void runValidate()}
                    disabled={validateLoading || syncBusy}
                    className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-1 rounded-md border border-border bg-background hover:bg-muted/60 disabled:opacity-50"
                  >
                    {validateLoading ? <Loader2 size={10} className="animate-spin" /> : <RefreshCw size={10} />}
                    Validate
                  </button>
                  {meta.canRevert && (
                    <button
                      type="button"
                      onClick={() => onRequestRevert(step.id)}
                      disabled={syncBusy}
                      className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-1 rounded-md border border-red-500/35 text-red-700 dark:text-red-400 bg-red-500/5 hover:bg-red-500/10 disabled:opacity-50"
                    >
                      <Undo2 size={10} />
                      Revert
                    </button>
                  )}
                </>
              )}
            </div>

            {validateResult && (
              <div
                className={`mt-2 text-[10px] font-medium leading-relaxed rounded-md px-2 py-1.5 border ${
                  validateResult.valid
                    ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-800 dark:text-emerald-200'
                    : 'border-red-500/30 bg-red-500/5 text-red-800 dark:text-red-200'
                }`}
              >
                {validateResult.valid ? 'Check passed: ' : 'Check failed: '}
                {validateResult.message}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Revert confirmation
// ---------------------------------------------------------------------------

interface RevertDialogProps {
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

function RevertConfirmDialog({ busy, onCancel, onConfirm }: RevertDialogProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        className="bg-card border border-border rounded-xl shadow-lg max-w-md w-full p-4 space-y-3"
        role="dialog"
        aria-labelledby="revert-dialog-title"
      >
        <div className="flex items-start justify-between gap-2">
          <h3 id="revert-dialog-title" className="text-sm font-bold text-foreground">
            Disconnect Google?
          </h3>
          <button type="button" onClick={onCancel} disabled={busy} className="p-1 rounded hover:bg-muted text-muted-foreground">
            <X size={14} />
          </button>
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed">
          This runs the server-side teardown cascade for your GCP bootstrap: remove provisioner IAM bindings, delete the
          provisioner service account when possible, then clear OAuth tokens, service account keys, and connection
          metadata from the local vault.
        </p>
        <p className="text-[11px] text-amber-700 dark:text-amber-300 bg-amber-500/10 border border-amber-500/25 rounded-lg px-2 py-1.5">
          GCP project deletion is never automated — remove the project in Google Cloud Console if you no longer need it.
        </p>
        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-border hover:bg-muted disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="inline-flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-lg bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Undo2 size={12} />}
            Confirm revert
          </button>
        </div>
      </motion.div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// OAuthFlowPanel
// ---------------------------------------------------------------------------

export type OAuthFlowPanelVariant = 'standalone' | 'embedded';

interface OAuthFlowPanelProps {
  projectId: string;
  label: string;
  onCompleted: () => Promise<void>;
  /** `embedded`: flat UI for use inside a provisioning step card (no nested “Connected” shell). */
  variant?: OAuthFlowPanelVariant;
}

export function OAuthFlowPanel({ projectId, label, onCompleted, variant = 'standalone' }: OAuthFlowPanelProps) {
  const embedded = variant === 'embedded';
  const [steps, setSteps] = useState<GcpOAuthStepStatus[]>([]);
  const [localError, setLocalError] = useState<string | null>(null);
  const [embeddedHydrated, setEmbeddedHydrated] = useState(!embedded);

  const [revertTarget, setRevertTarget] = useState<OAuthStepId | null>(null);
  const [revertBusy, setRevertBusy] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [discoverHint, setDiscoverHint] = useState<string | null>(null);
  const [discoverOutcome, setDiscoverOutcome] = useState<GcpOAuthProjectDiscoverResult['outcome'] | null>(null);

  const oauthSession = useOAuthSession({
    projectId,
    providerId: 'gcp',
    pollIntervalMs: 1200,
    onComplete: async (status) => {
      const d = status.gcpProjectDiscover as GcpOAuthProjectDiscoverResult | undefined;
      if (d) {
        setDiscoverHint(d.message);
        setDiscoverOutcome(d.outcome);
        if (d.outcome === 'linked' || d.outcome === 'already_linked') {
          await api(`/api/projects/${encodeURIComponent(projectId)}/provisioning/plan/sync`, { method: 'POST' });
        }
      }
      setSteps([{ id: 'oauth_consent', label: STEP_META.oauth_consent.title, status: 'completed' }]);
      await onCompleted();
    },
    onError: (msg) => setLocalError(msg),
  });

  // Derive a simplified phase for rendering from the hook's phase
  const phase = oauthSession.phase === 'idle' ? 'idle'
    : oauthSession.phase === 'completed' ? 'completed'
    : oauthSession.phase === 'failed' || oauthSession.phase === 'expired' ? 'failed'
    : oauthSession.phase === 'starting' ? 'starting'
    : 'polling';

  const error = oauthSession.error ?? localError;

  useEffect(() => {
    if (!embedded) {
      setEmbeddedHydrated(true);
      return;
    }
    let cancelled = false;
    setEmbeddedHydrated(false);
    (async () => {
      try {
        const v = await api<{ valid: boolean; message: string }>(
          `/api/projects/${encodeURIComponent(projectId)}/oauth/gcp/validate`,
          { method: 'POST' },
        );
        if (cancelled) return;
        if (v.valid) {
          oauthSession.reset();
          setSteps([{ id: 'oauth_consent', label: STEP_META.oauth_consent.title, status: 'completed', message: v.message }]);
          // Force phase to 'completed' so embedded variant shows the signed-in state
          // (reset() puts us back to 'idle'; we handle this below via oauthComplete)
        } else {
          setSteps([]);
        }
      } catch {
        if (!cancelled) setSteps([]);
      } finally {
        if (!cancelled) setEmbeddedHydrated(true);
      }
    })();
    return () => { cancelled = true; };
  }, [embedded, projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  const startFlow = useCallback(async () => {
    setLocalError(null);
    setDiscoverHint(null);
    setDiscoverOutcome(null);
    setSteps(STEP_ORDER.map((id) => ({ id, label: STEP_META[id].title, status: 'pending' as const })));
    await oauthSession.start();
  }, [oauthSession]);

  const confirmRevert = useCallback(async () => {
    if (!revertTarget) return;
    setRevertBusy(true);
    setLocalError(null);
    try {
      await api(
        `/api/projects/${encodeURIComponent(projectId)}/oauth/gcp/connection`,
        { method: 'DELETE' },
      );
      setRevertTarget(null);
      oauthSession.reset();
      setSteps([]);
      await onCompleted();
    } catch (err) {
      setLocalError((err as Error).message);
    } finally {
      setRevertBusy(false);
    }
  }, [projectId, revertTarget, onCompleted, oauthSession]);

  const runSyncProvisioningPlan = useCallback(async () => {
    setSyncBusy(true);
    try {
      // Discover project first so the project ID is in vault before plan sync runs.
      const discover = await api<GcpOAuthProjectDiscoverResult>(
        `/api/projects/${encodeURIComponent(projectId)}/oauth/gcp/discover`,
        { method: 'POST' },
      );
      setDiscoverHint(discover.message);
      setDiscoverOutcome(discover.outcome);

      // If discover itself found the project was inaccessible (stale/wrong account),
      // skip plan sync and start a fresh OAuth flow immediately.
      if (discover.outcome === 'inaccessible' || discover.outcome === 'error') {
        setSyncBusy(false);
        void startFlow();
        return;
      }

      const syncResult = await api<{
        ok?: boolean;
        needsReauth?: boolean;
        sessionId?: string;
        authUrl?: string;
      }>(`/api/projects/${encodeURIComponent(projectId)}/provisioning/plan/sync`, { method: 'POST' });

      // If plan/sync detected stale credentials, poll that session then re-start sync.
      if (syncResult.needsReauth && syncResult.authUrl && syncResult.sessionId) {
        setSyncBusy(false);
        await oauthSession.pollExternal(syncResult.sessionId, syncResult.authUrl);
        return;
      }

      const v = await api<{ valid: boolean; message: string }>(
        `/api/projects/${encodeURIComponent(projectId)}/oauth/gcp/validate`,
        { method: 'POST' },
      );
      setSteps([{
        id: 'oauth_consent',
        label: STEP_META.oauth_consent.title,
        status: v.valid ? 'completed' : 'failed',
        message: v.message,
      }]);
      if (v.valid) {
        setLocalError(null);
        await onCompleted();
      } else {
        setLocalError(v.message);
      }
    } catch (err) {
      setLocalError((err as Error).message);
    } finally {
      setSyncBusy(false);
    }
  }, [projectId, onCompleted, startFlow, oauthSession]);

  const oauthStep = steps.find((s) => s.id === 'oauth_consent');
  const oauthSignedIn = oauthStep?.status === 'completed';
  const oauthComplete = phase === 'completed' || oauthSignedIn;
  const flowComplete = oauthComplete;

  if (embedded && !embeddedHydrated) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground py-1">
        <Loader2 size={14} className="animate-spin shrink-0" />
        Checking Google sign-in…
      </div>
    );
  }

  if (phase === 'idle') {
    if (embedded) {
      return (
        <div className="space-y-2 border-t border-border/80 pt-3 mt-1">
          <p className="text-xs text-muted-foreground leading-relaxed">
            Sign in with Google so this step can call GCP. If you use a service account key instead, add it in project
            providers — then use <span className="font-semibold text-foreground">Sync status</span> above.
          </p>
          <button
            type="button"
            onClick={() => void startFlow()}
            className="flex items-center gap-2 bg-blue-600 text-white text-xs font-bold px-3 py-2 rounded-lg hover:bg-blue-700 transition-colors shadow-sm"
          >
            <Zap size={13} />
            {label}
          </button>
        </div>
      );
    }

    return (
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void startFlow()}
          className="flex items-center gap-2 bg-blue-600 text-white text-sm font-bold px-4 py-2.5 rounded-lg hover:bg-blue-700 transition-colors shadow-sm"
        >
          <Zap size={15} />
          {label}
        </button>
        <button
          type="button"
          onClick={() => void runSyncProvisioningPlan()}
          disabled={syncBusy}
          title="Reconcile the provisioning plan with live GCP/vault, then refresh Google sign-in status"
          className="inline-flex items-center gap-2 text-sm font-bold px-4 py-2.5 rounded-lg border border-sky-500/40 text-sky-800 dark:text-sky-300 bg-sky-500/10 hover:bg-sky-500/15 disabled:opacity-50"
        >
          {syncBusy ? <Loader2 size={15} className="animate-spin" /> : <ScanSearch size={15} />}
          Sync provisioning plan
        </button>
      </div>
    );
  }

  if (embedded) {
    return (
      <div className="space-y-2 border-t border-border/80 pt-3 mt-1">
        {phase === 'failed' && (
          <div className="flex items-start gap-2 text-xs">
            <AlertTriangle size={14} className="text-red-500 shrink-0 mt-0.5" />
            <div className="space-y-2 min-w-0">
              <p className="text-red-600 dark:text-red-400 leading-relaxed">{error ?? 'Authentication failed.'}</p>
              <button
                type="button"
                onClick={() => void startFlow()}
                className="inline-flex items-center gap-1.5 font-semibold text-primary hover:underline"
              >
                <RefreshCw size={12} />
                Try again
              </button>
            </div>
          </div>
        )}

        {(phase === 'starting' || phase === 'polling') && (
          <div className="flex items-center gap-2 text-xs text-foreground">
            <Loader2 size={14} className="animate-spin text-primary shrink-0" />
            <span>{phase === 'starting' ? 'Starting Google sign-in…' : 'Complete sign-in in the browser tab…'}</span>
          </div>
        )}

        {oauthComplete && phase !== 'failed' && phase !== 'starting' && phase !== 'polling' && (
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-foreground">
              <CheckCircle2 size={16} className="text-emerald-500 shrink-0" />
              <span className="font-medium">Google sign-in is available for this step.</span>
            </div>
            {oauthStep?.message ? (
              <p className="text-xs text-muted-foreground pl-[22px]">{oauthStep.message}</p>
            ) : null}
            {discoverHint && discoverOutcome !== 'not_found' ? (
              <p
                className={`text-[11px] leading-relaxed pl-[22px] rounded-md border px-2 py-1.5 mt-1 ${
                  discoverOutcome === 'linked' || discoverOutcome === 'already_linked'
                    ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-900 dark:text-emerald-100'
                    : 'border-amber-500/30 bg-amber-500/5 text-amber-950 dark:text-amber-100'
                }`}
              >
                <span className="font-semibold">GCP project: </span>
                {discoverHint}
              </p>
            ) : null}
            <p className="text-[11px] text-muted-foreground pl-[22px]">
              Reconcile or reset this step using the same controls as other steps (sync, revalidate, revert) — not duplicate
              buttons here.
            </p>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {revertTarget && (
        <RevertConfirmDialog
          busy={revertBusy}
          onCancel={() => !revertBusy && setRevertTarget(null)}
          onConfirm={() => void confirmRevert()}
        />
      )}

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {oauthComplete ? (
            <CheckCircle2 size={16} className="text-emerald-500" />
          ) : phase === 'failed' ? (
            <AlertTriangle size={16} className="text-red-500" />
          ) : (
            <Loader2 size={16} className="text-primary animate-spin" />
          )}
          <span
            className={`text-sm font-semibold ${
              oauthComplete
                ? 'text-emerald-600 dark:text-emerald-400'
                : phase === 'failed'
                  ? 'text-red-600 dark:text-red-400'
                  : 'text-foreground'
            }`}
          >
            {oauthComplete
              ? 'Connected — your Google credentials are stored'
              : phase === 'failed'
                ? 'Authentication Failed'
                : phase === 'starting'
                  ? 'Starting…'
                  : 'Authenticating with Google'}
          </span>
        </div>

        <span className="text-[10px] font-mono text-muted-foreground">
          {steps.filter((s) => s.status === 'completed').length}/{steps.length} steps
        </span>
      </div>

      <div className="bg-muted rounded-full h-1 overflow-hidden">
        <motion.div
          className={`h-full rounded-full transition-colors duration-500 ${
            phase === 'failed' && !oauthComplete
              ? 'bg-red-500'
              : oauthComplete
                ? 'bg-emerald-500'
                : 'bg-primary'
          }`}
          initial={{ width: 0 }}
          animate={{ width: `${(steps.filter((s) => s.status === 'completed').length / Math.max(steps.length, 1)) * 100}%` }}
          transition={{ duration: 0.4, ease: 'easeOut' }}
        />
      </div>

      {discoverHint ? (
        <div
          className={`text-xs rounded-lg border px-3 py-2 leading-relaxed ${
            discoverOutcome === 'linked' || discoverOutcome === 'already_linked'
              ? 'border-emerald-500/35 bg-emerald-500/5 text-emerald-900 dark:text-emerald-100'
              : discoverOutcome === 'error' || discoverOutcome === 'ambiguous' || discoverOutcome === 'inaccessible'
                ? 'border-amber-500/35 bg-amber-500/5 text-amber-950 dark:text-amber-100'
                : 'border-border bg-muted/30 text-muted-foreground'
          }`}
        >
          <span className="font-semibold text-foreground">GCP project: </span>
          {discoverOutcome === 'not_found'
            ? 'No existing project found — the provisioning step will create one.'
            : discoverHint}
        </div>
      ) : null}

      <div className="pt-1">
        {steps.map((step, idx) => (
          <StepCard
            key={step.id}
            step={step}
            index={idx}
            isLast={idx === steps.length - 1}
            projectId={projectId}
            flowComplete={flowComplete}
            syncBusy={syncBusy}
            onSyncPipeline={() => void runSyncProvisioningPlan()}
            onRequestRevert={setRevertTarget}
          />
        ))}
      </div>

      {error && phase === 'failed' && (
        <div className="space-y-2 pt-1">
          <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/30 rounded-lg p-3">
            <AlertTriangle size={13} className="text-red-500 shrink-0 mt-0.5" />
            <p className="text-xs text-red-600 dark:text-red-400 leading-relaxed">{error}</p>
          </div>
          <button
            type="button"
            onClick={() => void startFlow()}
            className="flex items-center gap-1.5 text-xs font-semibold text-primary hover:underline"
          >
            <RefreshCw size={12} />
            Retry from start
          </button>
        </div>
      )}

      {error && phase === 'completed' && (
        <div className="flex items-start gap-2 bg-amber-500/10 border border-amber-500/30 rounded-lg p-3">
          <AlertTriangle size={13} className="text-amber-600 shrink-0 mt-0.5" />
          <p className="text-xs text-amber-900 dark:text-amber-100 leading-relaxed">{error}</p>
        </div>
      )}

      {steps.length > 0 && (
        <p className="text-[11px] text-muted-foreground">
          <strong>Sync provisioning plan</strong> reconciles Firebase graph steps with live GCP/vault (same as the setup wizard),
          then re-checks Google sign-in. Infrastructure steps (project, service account, IAM, keys) run as separate provisioning
          nodes after you are signed in.{' '}
          {flowComplete && (
            <>
              <strong>Validate</strong> checks stored OAuth only; <strong>Disconnect</strong> runs the server cascade to remove
              provisioner IAM/SA and clear local credentials.
            </>
          )}
        </p>
      )}
    </div>
  );
}
