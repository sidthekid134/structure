import { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Cloud,
  Github,
  Globe,
  Link2,
  Loader2,
  Settings2,
  ShieldCheck,
  Unlink,
  Zap,
} from 'lucide-react';
import { INTEGRATION_CONFIGS, PROJECT_SETUP_CONFIGS } from './constants';
import { usePluginCatalog } from './usePluginCatalog';
import { providerToBackendKey } from './helpers';
import { AppleIntegrationFlow } from './AppleIntegrationFlow';
import { IntegrationModal } from './IntegrationModal';
import { StepTimeline } from './StepTimeline';
import { mapGcpStepToSetupStatus } from './types';
import type {
  FirebaseConnectionDetails,
  GcpOAuthSessionStatus,
  GcpOAuthStepStatus,
  IntegrationDependencyProviderStatus,
  ProjectSetupStep,
  ProviderId,
  SetupPlanStepStatus,
} from './types';

export function ProjectProvidersTab({
  projectName,
  bundleId,
  connectedFirebase,
  firebaseConnectionDetails,
  githubOrgConnected,
  expoOrgConnected,
  appleOrgConnected,
  githubProjectInitialized,
  expoProjectInitialized,
  integrationDependencyStatus,
  onConnect,
  onOAuthStart,
  onTriggerSetup,
  onDisconnect,
  onRefresh,
}: {
  projectName: string;
  bundleId: string;
  connectedFirebase: boolean;
  firebaseConnectionDetails: FirebaseConnectionDetails | null;
  githubOrgConnected: boolean;
  expoOrgConnected: boolean;
  appleOrgConnected: boolean;
  githubProjectInitialized: boolean;
  expoProjectInitialized: boolean;
  integrationDependencyStatus: Record<string, IntegrationDependencyProviderStatus>;
  onConnect: (providerId: ProviderId, fields: Record<string, string>) => Promise<void>;
  onOAuthStart: (providerId: ProviderId, onProgress: (progress: GcpOAuthSessionStatus) => void) => Promise<void>;
  onTriggerSetup: (providerId: ProviderId) => Promise<void>;
  onDisconnect: (providerId: ProviderId) => Promise<void>;
  onRefresh: () => void | Promise<void>;
}) {
  const [activeProviderTab, setActiveProviderTab] = useState<ProviderId>('firebase');
  const [openModal, setOpenModal] = useState<'github' | 'expo' | 'apple' | null>(null);

  const [gcpPath, setGcpPath] = useState<'oauth' | 'manual'>('oauth');
  const [saJson, setSaJson] = useState('');
  const [gcpOauthStatus, setGcpOauthStatus] = useState<'idle' | 'waiting' | 'success' | 'error'>('idle');
  const [gcpOauthProgress, setGcpOauthProgress] = useState<GcpOAuthSessionStatus | null>(null);
  const [gcpBusy, setGcpBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [ghInitRunning, setGhInitRunning] = useState(false);
  const [ghInitSteps, setGhInitSteps] = useState<Record<string, SetupPlanStepStatus>>({});
  const [exInitRunning, setExInitRunning] = useState(false);
  const [exInitSteps, setExInitSteps] = useState<Record<string, SetupPlanStepStatus>>({});

  const { catalog: pluginCatalog } = usePluginCatalog();

  useEffect(() => {
    if (connectedFirebase) {
      setGcpOauthStatus('idle');
      setGcpOauthProgress(null);
      setError(null);
    }
  }, [connectedFirebase]);

  const gcpCfg = PROJECT_SETUP_CONFIGS.firebase;
  const ghCfg = PROJECT_SETUP_CONFIGS.github;
  const expoCfg = PROJECT_SETUP_CONFIGS.expo;
  const appleCfg = PROJECT_SETUP_CONFIGS.apple;

  const oauthStepById = useMemo(() => {
    return Object.fromEntries((gcpOauthProgress?.steps ?? []).map((s) => [s.id, s])) as Partial<
      Record<GcpOAuthStepStatus['id'], GcpOAuthStepStatus>
    >;
  }, [gcpOauthProgress]);

  const getOAuthTimelineStatus = useCallback(
    (key: GcpOAuthStepStatus['id']): SetupPlanStepStatus => mapGcpStepToSetupStatus(oauthStepById[key]?.status),
    [oauthStepById],
  );

  const oauthTimelineSteps: ProjectSetupStep[] = (gcpCfg.oauthSteps ?? []).map((s) => ({
    id: s.key,
    label: s.label,
    description: s.description,
  }));

  const oauthStepStatuses = useMemo(() => {
    const m: Record<string, SetupPlanStepStatus> = {};
    for (const s of gcpCfg.oauthSteps ?? []) {
      m[s.key] = getOAuthTimelineStatus(s.key);
    }
    return m;
  }, [gcpCfg.oauthSteps, getOAuthTimelineStatus]);

  const runGithubProjectInit = async () => {
    setGhInitRunning(true);
    setError(null);
    const initial = Object.fromEntries(ghCfg.steps.map((s) => [s.id, 'idle' as SetupPlanStepStatus]));
    setGhInitSteps(initial);
    try {
      const p = onTriggerSetup('github');
      for (const step of ghCfg.steps) {
        setGhInitSteps((prev) => ({ ...prev, [step.id]: 'in_progress' }));
        await new Promise((r) => setTimeout(r, 700));
        setGhInitSteps((prev) => ({ ...prev, [step.id]: 'completed' }));
      }
      await p;
      await onRefresh();
    } catch (err) {
      setError((err as Error).message);
      setGhInitSteps((prev) => {
        const next = { ...prev };
        const run = Object.entries(next).find(([, v]) => v === 'in_progress');
        if (run) next[run[0]] = 'failed';
        return next;
      });
    } finally {
      setGhInitRunning(false);
    }
  };

  const runExpoProjectInit = async () => {
    setExInitRunning(true);
    setError(null);
    const initial = Object.fromEntries(expoCfg.steps.map((s) => [s.id, 'idle' as SetupPlanStepStatus]));
    setExInitSteps(initial);
    try {
      const p = onTriggerSetup('expo');
      for (const step of expoCfg.steps) {
        setExInitSteps((prev) => ({ ...prev, [step.id]: 'in_progress' }));
        await new Promise((r) => setTimeout(r, 700));
        setExInitSteps((prev) => ({ ...prev, [step.id]: 'completed' }));
      }
      await p;
      await onRefresh();
    } catch (err) {
      setError((err as Error).message);
      setExInitSteps((prev) => {
        const next = { ...prev };
        const run = Object.entries(next).find(([, v]) => v === 'in_progress');
        if (run) next[run[0]] = 'failed';
        return next;
      });
    } finally {
      setExInitRunning(false);
    }
  };

  const startGcpOAuth = async () => {
    setGcpOauthStatus('waiting');
    setError(null);
    setGcpOauthProgress(null);
    try {
      await onOAuthStart('firebase', (progress) => setGcpOauthProgress(progress));
      setGcpOauthStatus('success');
      await onRefresh();
    } catch (err) {
      setGcpOauthStatus('error');
      setError((err as Error).message);
    }
  };

  const submitManualSa = async () => {
    if (!saJson.trim()) return;
    setGcpBusy(true);
    setError(null);
    try {
      await onConnect('firebase', { gcpServiceAccount: saJson });
      await onRefresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setGcpBusy(false);
    }
  };

  const pluginCards = (ids: string[]) =>
    (pluginCatalog?.plugins ?? [])
      .filter((p) => ids.includes(p.id))
      .map((p) => (
        <div key={p.id} className="rounded-lg border border-border/80 bg-background/80 px-3 py-2.5">
          <p className="text-sm font-semibold leading-snug">{p.name}</p>
          <p className="text-[11px] text-muted-foreground mt-1 leading-relaxed">{p.description}</p>
        </div>
      ));

  const PROVIDER_TABS: Array<{
    id: ProviderId;
    label: string;
    icon: React.ElementType;
    iconColor: string;
    statusLabel: string;
    statusColor: string;
  }> = [
    {
      id: 'firebase',
      label: 'GCP',
      icon: Cloud,
      iconColor: 'text-blue-500',
      statusLabel: connectedFirebase ? 'Connected' : 'Not connected',
      statusColor: connectedFirebase
        ? 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/20'
        : 'text-muted-foreground bg-muted border-border',
    },
    {
      id: 'github',
      label: 'GitHub',
      icon: Github,
      iconColor: 'text-foreground',
      statusLabel:
        githubOrgConnected && githubProjectInitialized ? 'Ready' : githubOrgConnected ? 'Partial' : 'Not connected',
      statusColor:
        githubOrgConnected && githubProjectInitialized
          ? 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/20'
          : githubOrgConnected
            ? 'text-amber-600 dark:text-amber-400 bg-amber-500/10 border-amber-500/20'
            : 'text-muted-foreground bg-muted border-border',
    },
    {
      id: 'expo',
      label: 'Expo / EAS',
      icon: Zap,
      iconColor: 'text-indigo-500',
      statusLabel:
        expoOrgConnected && expoProjectInitialized ? 'Ready' : expoOrgConnected ? 'Partial' : 'Not connected',
      statusColor:
        expoOrgConnected && expoProjectInitialized
          ? 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/20'
          : expoOrgConnected
            ? 'text-amber-600 dark:text-amber-400 bg-amber-500/10 border-amber-500/20'
            : 'text-muted-foreground bg-muted border-border',
    },
    {
      id: 'apple',
      label: 'Apple',
      icon: ShieldCheck,
      iconColor: 'text-zinc-700 dark:text-zinc-300',
      statusLabel: appleOrgConnected ? 'Connected' : 'Not connected',
      statusColor: appleOrgConnected
        ? 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/20'
        : 'text-muted-foreground bg-muted border-border',
    },
  ];

  const modalConfig = openModal ? (INTEGRATION_CONFIGS.find((c) => c.id === openModal) ?? null) : null;
  const modalIsConnected = openModal === 'github'
    ? githubOrgConnected
    : openModal === 'expo'
      ? expoOrgConnected
      : openModal === 'apple'
        ? appleOrgConnected
        : false;

  return (
    <div className="space-y-0 max-w-5xl">
      {/* Provider sub-tab bar */}
      <div className="flex items-center gap-1 border-b border-border mb-6">
        {PROVIDER_TABS.map((tab) => {
          const TabIcon = tab.icon;
          const isActive = activeProviderTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveProviderTab(tab.id)}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px ${
                isActive ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              <TabIcon size={15} className={isActive ? tab.iconColor : ''} />
              <span>{tab.label}</span>
              <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full border ${tab.statusColor}`}>
                {tab.statusLabel}
              </span>
            </button>
          );
        })}
      </div>

      {error && (
        <div className="mb-6 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300 flex items-start gap-2">
          <AlertCircle size={16} className="shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      <AnimatePresence mode="wait">
        {/* ── Firebase tab ── */}
        {activeProviderTab === 'firebase' && (
          <motion.div
            key="firebase"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.18 }}
            className="space-y-6"
          >
            <div className="rounded-2xl border border-border bg-card shadow-sm overflow-hidden">
              <div className="grid grid-cols-1 lg:grid-cols-5 gap-0 lg:divide-x divide-border">
                <div className="lg:col-span-2 p-5 md:p-6 bg-muted/20 border-b lg:border-b-0 border-border space-y-4">
                  <div className="flex items-center gap-2">
                    <div className="p-2 rounded-xl bg-blue-500/10">
                      <Cloud size={20} className="text-blue-500" />
                    </div>
                    <div>
                      <p className="font-semibold">Google Cloud Platform</p>
                      <p className="text-[11px] text-muted-foreground">Project-scoped — one GCP project per app</p>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground leading-relaxed">{gcpCfg.introDescription}</p>
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-2">Plugins unlocked</p>
                    <div className="grid gap-2">{pluginCards(gcpCfg.pluginIds)}</div>
                  </div>
                  {gcpCfg.introBadges && gcpCfg.introBadges.length > 0 && (
                    <div>
                      <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-2">Provisioner SA roles</p>
                      <div className="flex flex-wrap gap-1">
                        {gcpCfg.introBadges.map((b) => (
                          <span key={b} className="text-[10px] font-mono bg-background border border-border px-2 py-0.5 rounded text-muted-foreground">
                            {b}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                <div className="lg:col-span-3 p-5 md:p-6 space-y-5">
                  {!connectedFirebase ? (
                    <>
                      <div className="flex rounded-lg border border-border p-0.5 bg-muted/40">
                        <button
                          type="button"
                          onClick={() => setGcpPath('oauth')}
                          className={`flex-1 rounded-md py-2 text-xs font-bold transition-colors ${
                            gcpPath === 'oauth' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'
                          }`}
                        >
                          Sign in with Google
                        </button>
                        <button
                          type="button"
                          onClick={() => setGcpPath('manual')}
                          className={`flex-1 rounded-md py-2 text-xs font-bold transition-colors ${
                            gcpPath === 'manual' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'
                          }`}
                        >
                          Service account JSON
                        </button>
                      </div>

                      {gcpPath === 'oauth' && (
                        <div className="space-y-4">
                          <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 px-4 py-3 text-xs text-muted-foreground leading-relaxed">
                            <span className="font-semibold text-blue-700 dark:text-blue-300">OAuth flow.</span> Studio opens Google in a new tab, then polls{' '}
                            <span className="font-mono text-[10px]">GET …/oauth/:sessionId</span> until provisioning finishes. Your Google password is never stored.
                          </div>
                          <div className="rounded-lg border border-dashed border-border bg-muted/15 p-3">
                            <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1">Start</p>
                            <pre className="text-[10px] font-mono whitespace-pre-wrap">
                              POST /api/projects/&lt;id&gt;/oauth/gcp/start
                            </pre>
                          </div>
                          {gcpOauthStatus !== 'idle' && gcpOauthProgress && (
                            <StepTimeline steps={oauthTimelineSteps} stepStatuses={oauthStepStatuses} />
                          )}
                          <button
                            type="button"
                            onClick={() => void startGcpOAuth()}
                            disabled={gcpOauthStatus === 'waiting' || gcpOauthStatus === 'success'}
                            className="w-full flex items-center justify-center gap-2 rounded-lg bg-foreground py-3 text-sm font-bold text-background hover:opacity-90 disabled:opacity-40"
                          >
                            {gcpOauthStatus === 'waiting' ? (
                              <><Loader2 size={16} className="animate-spin" />Waiting for Google…</>
                            ) : gcpOauthStatus === 'success' ? (
                              <><CheckCircle2 size={16} />Connected</>
                            ) : (
                              <><Globe size={16} />Start Google sign-in</>
                            )}
                          </button>
                        </div>
                      )}

                      {gcpPath === 'manual' && (
                        <div className="space-y-3">
                          <div className="rounded-lg border border-amber-500/25 bg-amber-500/5 px-4 py-3 text-xs text-muted-foreground leading-relaxed">
                            <span className="font-semibold text-amber-800 dark:text-amber-200">Manual key.</span> Paste JSON for a service account that can enable Firebase in your GCP project.
                          </div>
                          <div className="rounded-lg border border-dashed border-border bg-muted/15 p-3">
                            <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1">Request</p>
                            <pre className="text-[10px] font-mono whitespace-pre-wrap leading-relaxed">
                              {`POST /api/projects/<id>/integrations/firebase/connect\n{\n  "serviceAccountJson": "{ ... }"\n}`}
                            </pre>
                          </div>
                          <textarea
                            rows={8}
                            value={saJson}
                            onChange={(e) => setSaJson(e.target.value)}
                            placeholder={'{\n  "type": "service_account",\n  ...\n}'}
                            className="w-full rounded-lg border border-border bg-background font-mono text-[11px] leading-relaxed p-3"
                          />
                          <button
                            type="button"
                            onClick={() => void submitManualSa()}
                            disabled={!saJson.trim() || gcpBusy}
                            className="w-full flex items-center justify-center gap-2 rounded-lg bg-primary py-3 text-sm font-bold text-primary-foreground hover:opacity-90 disabled:opacity-40"
                          >
                            {gcpBusy ? <Loader2 size={16} className="animate-spin" /> : <Link2 size={16} />}
                            Send service account JSON
                          </button>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="space-y-4">
                      <div className="flex items-center gap-2 text-sm font-semibold text-emerald-600 dark:text-emerald-400">
                        <CheckCircle2 size={18} />
                        Google Cloud linked for this project
                      </div>
                      <div className="grid gap-2 text-xs">
                        {firebaseConnectionDetails?.project_id && (
                          <div className="flex justify-between gap-4 rounded-lg border border-border px-3 py-2">
                            <span className="text-muted-foreground">GCP project</span>
                            <a
                              href={`https://console.cloud.google.com/home/dashboard?project=${encodeURIComponent(firebaseConnectionDetails.project_id)}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="font-mono text-foreground hover:text-primary truncate text-right"
                            >
                              {firebaseConnectionDetails.project_id}
                            </a>
                          </div>
                        )}
                        {firebaseConnectionDetails?.service_account_email && (
                          <div className="flex justify-between gap-4 rounded-lg border border-border px-3 py-2">
                            <span className="text-muted-foreground">Service account</span>
                            <span className="font-mono text-right truncate">{firebaseConnectionDetails.service_account_email}</span>
                          </div>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => void onDisconnect('firebase')}
                        className="text-xs font-bold text-red-600 dark:text-red-400 border border-red-500/30 rounded-lg px-3 py-2 hover:bg-red-500/10 inline-flex items-center gap-1.5"
                      >
                        <Unlink size={12} />
                        Disconnect GCP / Firebase for this project
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </motion.div>
        )}

        {/* ── GitHub tab ── */}
        {activeProviderTab === 'github' && (
          <motion.div
            key="github"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.18 }}
            className="space-y-6"
          >
            <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
              {/* Info + connect panel */}
              <div className="lg:col-span-2 rounded-2xl border border-border bg-muted/20 p-5 space-y-4">
                <div className="flex items-center gap-2">
                  <div className="p-2 rounded-xl bg-muted border border-border">
                    <Github size={20} />
                  </div>
                  <div>
                    <p className="font-semibold">GitHub</p>
                    <p className="text-[11px] text-muted-foreground">Organization-level token</p>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">{ghCfg.introDescription}</p>
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-2">Plugins unlocked</p>
                  <div className="grid gap-2">{pluginCards(ghCfg.pluginIds)}</div>
                </div>
                <div className="rounded-lg border border-dashed border-border bg-muted/20 p-3">
                  <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1.5">Org token request</p>
                  <pre className="text-[10px] font-mono text-foreground/90 whitespace-pre-wrap leading-relaxed">
                    {'POST /api/organization/integrations/github/connect\n{ "token": "<github_pat>" }'}
                  </pre>
                </div>
                <button
                  type="button"
                  onClick={() => setOpenModal('github')}
                  className={`w-full flex items-center justify-center gap-2 rounded-lg py-2.5 text-sm font-bold transition-colors ${
                    githubOrgConnected
                      ? 'border border-border hover:bg-accent text-foreground'
                      : 'bg-primary text-primary-foreground hover:opacity-90'
                  }`}
                >
                  {githubOrgConnected ? <><Settings2 size={14} />Manage connection</> : <><Link2 size={14} />Connect GitHub</>}
                </button>
              </div>

              {/* Project setup panel */}
              <div className="lg:col-span-3 rounded-2xl border border-border bg-card p-5 md:p-6 space-y-5 shadow-sm">
                <div>
                  <p className="font-semibold text-sm mb-1">Project repository setup</p>
                  <p className="text-xs text-muted-foreground leading-relaxed">{ghCfg.triggerDescription}</p>
                </div>
                {!githubOrgConnected && (
                  <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-800 dark:text-amber-200 flex gap-2">
                    <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                    <span>Connect the organization GitHub token first — Studio cannot create a repo or deploy keys without it.</span>
                  </div>
                )}
                <StepTimeline
                  steps={ghCfg.steps}
                  stepStatuses={
                    githubProjectInitialized
                      ? Object.fromEntries(ghCfg.steps.map((s) => [s.id, 'completed' as const]))
                      : ghInitSteps
                  }
                />
                {githubProjectInitialized ? (
                  <p className="text-xs text-emerald-600 dark:text-emerald-400 font-medium flex items-center gap-1.5">
                    <CheckCircle2 size={14} />
                    GitHub Actions module is available for this project.
                  </p>
                ) : (
                  <button
                    type="button"
                    disabled={!githubOrgConnected || ghInitRunning}
                    onClick={() => void runGithubProjectInit()}
                    className="inline-flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-bold text-primary-foreground hover:opacity-90 disabled:opacity-40"
                  >
                    {ghInitRunning ? <Loader2 size={14} className="animate-spin" /> : <Github size={14} />}
                    {ghInitRunning ? 'Working…' : 'Create GitHub repository'}
                  </button>
                )}
              </div>
            </div>
          </motion.div>
        )}

        {/* ── Expo tab ── */}
        {activeProviderTab === 'expo' && (
          <motion.div
            key="expo"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.18 }}
            className="space-y-6"
          >
            <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
              {/* Info + connect panel */}
              <div className="lg:col-span-2 rounded-2xl border border-border bg-muted/20 p-5 space-y-4">
                <div className="flex items-center gap-2">
                  <div className="p-2 rounded-xl bg-indigo-500/10">
                    <Zap size={20} className="text-indigo-500" />
                  </div>
                  <div>
                    <p className="font-semibold">Expo / EAS</p>
                    <p className="text-[11px] text-muted-foreground">Organization-level robot token</p>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">{expoCfg.introDescription}</p>
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-2">Plugins unlocked</p>
                  <div className="grid gap-2">{pluginCards(expoCfg.pluginIds)}</div>
                </div>
                <div className="rounded-lg border border-dashed border-border bg-muted/20 p-3">
                  <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1.5">Org token request</p>
                  <pre className="text-[10px] font-mono text-foreground/90 whitespace-pre-wrap leading-relaxed">
                    {'POST /api/organization/integrations/eas/connect\n{ "token": "<expo_robot_token>" }'}
                  </pre>
                </div>
                <button
                  type="button"
                  onClick={() => setOpenModal('expo')}
                  className={`w-full flex items-center justify-center gap-2 rounded-lg py-2.5 text-sm font-bold transition-colors ${
                    expoOrgConnected
                      ? 'border border-border hover:bg-accent text-foreground'
                      : 'bg-primary text-primary-foreground hover:opacity-90'
                  }`}
                >
                  {expoOrgConnected ? <><Settings2 size={14} />Manage connection</> : <><Link2 size={14} />Connect Expo</>}
                </button>
              </div>

              {/* Project setup panel */}
              <div className="lg:col-span-3 rounded-2xl border border-border bg-card p-5 md:p-6 space-y-5 shadow-sm">
                <div>
                  <p className="font-semibold text-sm mb-1">EAS application setup</p>
                  <p className="text-xs text-muted-foreground leading-relaxed">{expoCfg.triggerDescription}</p>
                </div>
                {!expoOrgConnected && (
                  <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-800 dark:text-amber-200 flex gap-2">
                    <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                    <span>Connect the Expo robot token first — EAS registration uses that account context.</span>
                  </div>
                )}
                <StepTimeline
                  steps={expoCfg.steps}
                  stepStatuses={
                    expoProjectInitialized
                      ? Object.fromEntries(expoCfg.steps.map((s) => [s.id, 'completed' as const]))
                      : exInitSteps
                  }
                />
                {expoProjectInitialized ? (
                  <p className="text-xs text-emerald-600 dark:text-emerald-400 font-medium flex items-center gap-1.5">
                    <CheckCircle2 size={14} />
                    EAS Build and EAS Submit modules are available for {bundleId}.
                  </p>
                ) : (
                  <button
                    type="button"
                    disabled={!expoOrgConnected || exInitRunning}
                    onClick={() => void runExpoProjectInit()}
                    className="inline-flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-bold text-primary-foreground hover:opacity-90 disabled:opacity-40"
                  >
                    {exInitRunning ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}
                    {exInitRunning ? 'Working…' : 'Register on EAS'}
                  </button>
                )}
              </div>
            </div>
          </motion.div>
        )}

        {/* ── Apple tab ── */}
        {activeProviderTab === 'apple' && (
          <motion.div
            key="apple"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.18 }}
            className="space-y-6"
          >
            <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
              <div className="lg:col-span-2 rounded-2xl border border-border bg-muted/20 p-5 space-y-4">
                <div className="flex items-center gap-2">
                  <div className="p-2 rounded-xl bg-zinc-500/10">
                    <ShieldCheck size={20} className="text-zinc-700 dark:text-zinc-300" />
                  </div>
                  <div>
                    <p className="font-semibold">Apple Developer</p>
                    <p className="text-[11px] text-muted-foreground">Organization-level defaults</p>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">{appleCfg.introDescription}</p>
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-2">Plugins unlocked</p>
                  <div className="grid gap-2">{pluginCards(appleCfg.pluginIds)}</div>
                </div>
                <div className="rounded-lg border border-dashed border-border bg-muted/20 p-3">
                  <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1.5">Org connect request</p>
                  <pre className="text-[10px] font-mono text-foreground/90 whitespace-pre-wrap leading-relaxed">
                    {'POST /api/organization/integrations/apple/connect\n{\n  "teamId":      "<APPLE_TEAM_ID>",\n  "ascIssuerId": "<ASC_ISSUER_UUID>",\n  "ascApiKeyId": "<ASC_KEY_ID>",\n  "ascApiKeyP8": "<.p8 file contents>"\n}'}
                  </pre>
                </div>
                <button
                  type="button"
                  onClick={() => setOpenModal('apple')}
                  className={`w-full flex items-center justify-center gap-2 rounded-lg py-2.5 text-sm font-bold transition-colors ${
                    appleOrgConnected
                      ? 'border border-border hover:bg-accent text-foreground'
                      : 'bg-primary text-primary-foreground hover:opacity-90'
                  }`}
                >
                  {appleOrgConnected ? <><Settings2 size={14} />Manage connection</> : <><Link2 size={14} />Connect Apple</>}
                </button>
              </div>

              <div className="lg:col-span-3 rounded-2xl border border-border bg-card p-5 md:p-6 space-y-5 shadow-sm">
                <div>
                  <p className="font-semibold text-sm mb-1">Project Apple setup steps</p>
                  <p className="text-xs text-muted-foreground leading-relaxed">{appleCfg.triggerDescription}</p>
                </div>
                {!appleOrgConnected && (
                  <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-800 dark:text-amber-200 flex gap-2">
                    <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                    <span>Connect Apple defaults first so project setup can resolve Apple team context automatically.</span>
                  </div>
                )}
                <StepTimeline
                  steps={appleCfg.steps}
                  stepStatuses={Object.fromEntries(
                    appleCfg.steps.map((s) => [s.id, appleOrgConnected ? 'completed' : 'idle' as SetupPlanStepStatus]),
                  )}
                />
                <p className="text-xs text-muted-foreground">
                  Continue in the project <span className="font-semibold">Setup</span> tab to run Apple provisioning steps
                  like <span className="font-mono">Register App ID</span> and <span className="font-mono">Create ASC App Listing</span>.
                </p>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* IntegrationModal overlay for org-level connections */}
      <AnimatePresence>
        {openModal === 'apple' && (
          <AppleIntegrationFlow
            key="apple-flow"
            isConnected={modalIsConnected}
            connectionDetails={null}
            onClose={() => setOpenModal(null)}
            onConnect={async (fields) => {
              await onConnect('apple', fields);
            }}
            onDisconnect={async () => {
              await onDisconnect('apple');
              setOpenModal(null);
              await onRefresh();
            }}
          />
        )}
        {openModal && openModal !== 'apple' && modalConfig && (
          <IntegrationModal
            key={openModal}
            config={modalConfig}
            isConnected={modalIsConnected}
            connectionDetails={null}
            dependencyStatus={integrationDependencyStatus[providerToBackendKey(openModal)]}
            onClose={() => setOpenModal(null)}
            onConnect={onConnect}
            onOAuthStart={onOAuthStart}
            onDisconnect={async (providerId) => {
              await onDisconnect(providerId);
              setOpenModal(null);
              await onRefresh();
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
