import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { motion } from 'framer-motion';
import {
  AlertCircle,
  ArrowRight,
  CheckCheck,
  CheckCircle2,
  ChevronRight,
  Cloud,
  Code2,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  Github,
  Globe,
  Info,
  Link2,
  Loader2,
  Unlink,
  X,
  Zap,
} from 'lucide-react';
import { api } from './helpers';
import { ALL_REGISTRY_PLUGINS, PROVIDER_PLUGIN_MAP } from './constants';
import { mapGcpStepToSetupStatus } from './types';
import type {
  GcpOAuthSessionStatus,
  GcpOAuthStepStatus,
  IntegrationConfig,
  IntegrationDependencyProviderStatus,
  IntegrationPlannedResourceStatus,
  ProviderId,
  SetupPlanStepStatus,
} from './types';

interface FirebaseConnectionDetails {
  project_id?: string;
  service_account_email?: string;
  connected_by?: string;
}

export function IntegrationModal({
  config,
  isConnected,
  connectionDetails,
  dependencyStatus,
  onClose,
  onConnect,
  onOAuthStart,
  onDisconnect,
}: {
  config: IntegrationConfig;
  isConnected: boolean;
  connectionDetails?: FirebaseConnectionDetails | null;
  dependencyStatus?: IntegrationDependencyProviderStatus;
  onClose: () => void;
  onConnect: (providerId: ProviderId, fields: Record<string, string>) => Promise<void>;
  onOAuthStart?: (
    providerId: ProviderId,
    onProgress: (progress: GcpOAuthSessionStatus) => void,
  ) => Promise<void>;
  onDisconnect: (providerId: ProviderId) => Promise<void>;
}) {
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [revealedFields, setRevealedFields] = useState<Record<string, boolean>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [connectMode, setConnectMode] = useState<'oauth' | 'manual'>(config.supportsOAuth ? 'oauth' : 'manual');
  const [oauthStatus, setOauthStatus] = useState<'idle' | 'waiting' | 'success' | 'error'>('idle');
  const [oauthProgress, setOauthProgress] = useState<GcpOAuthSessionStatus | null>(null);
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [isDependenciesCollapsed, setIsDependenciesCollapsed] = useState(false);
  const [dependencySectionTouched, setDependencySectionTouched] = useState(false);
  const [setupPlanStepStates, setSetupPlanStepStates] = useState<Record<string, SetupPlanStepStatus>>({});
  const [isRunningSetupChecks, setIsRunningSetupChecks] = useState(false);
  const [setupChecksComplete, setSetupChecksComplete] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);
  const [copiedValueKey, setCopiedValueKey] = useState<string | null>(null);
  const LogoIcon = config.logo;
  const allFilled = config.fields.every((f) => (fieldValues[f.key] ?? '').trim().length > 0);
  const allDependenciesReady =
    (dependencyStatus?.dependencies.length ?? 0) > 0 &&
    (dependencyStatus?.dependencies.every((dependency) => dependency.status === 'ready') ?? false);
  const hasSetupPlan = (dependencyStatus?.plannedResources.length ?? 0) > 0;
  const requiresSetupChecksBeforeSave =
    config.id === 'firebase' && !isConnected && connectMode === 'manual' && hasSetupPlan;
  const firebaseConnectedProjectId = connectionDetails?.project_id?.trim() || '';
  const firebaseConnectedServiceAccountEmail = connectionDetails?.service_account_email?.trim() || '';
  const plannedFirebaseProjectId =
    dependencyStatus?.plannedResources.find((resource) => resource.key === 'gcp_project')?.standardized_name ?? '';
  const effectiveFirebaseProjectId = firebaseConnectedProjectId || plannedFirebaseProjectId;
  const oauthStepById = useMemo(() => {
    return Object.fromEntries((oauthProgress?.steps ?? []).map((step) => [step.id, step])) as Partial<
      Record<GcpOAuthStepStatus['id'], GcpOAuthStepStatus>
    >;
  }, [oauthProgress]);
  const shouldUseOauthPlanTimeline =
    config.id === 'firebase' &&
    connectMode === 'oauth' &&
    (oauthStatus === 'waiting' || oauthStatus === 'success' || oauthStatus === 'error') &&
    Boolean(oauthProgress);
  const getEffectiveSetupPlanStepStatus = (resourceKey: string): SetupPlanStepStatus => {
    if (config.id === 'firebase' && isConnected) {
      if (
        resourceKey === 'gcp_project' ||
        resourceKey === 'provisioner_service_account' ||
        resourceKey === 'provisioner_service_account_key'
      ) {
        return 'completed';
      }
    }

    if (!shouldUseOauthPlanTimeline) {
      return setupPlanStepStates[resourceKey] ?? 'idle';
    }

    if (resourceKey === 'gcp_project') {
      return mapGcpStepToSetupStatus(oauthStepById.oauth_consent?.status);
    }
    if (oauthStepById.oauth_consent?.status === 'completed') {
      return setupPlanStepStates[resourceKey] ?? 'idle';
    }
    if (resourceKey === 'provisioner_service_account' || resourceKey === 'provisioner_service_account_key') {
      return 'idle';
    }

    return setupPlanStepStates[resourceKey] ?? 'idle';
  };

  const getSetupPlanDisplayName = (resource: IntegrationPlannedResourceStatus): string => {
    if (config.id !== 'firebase') {
      return resource.standardized_name;
    }

    if (resource.key === 'gcp_project') {
      return effectiveFirebaseProjectId || resource.standardized_name;
    }
    if (resource.key === 'provisioner_service_account') {
      return firebaseConnectedServiceAccountEmail || resource.standardized_name;
    }
    if (resource.key === 'provisioner_service_account_key') {
      return resource.standardized_name.replace('::', '/');
    }

    return resource.standardized_name;
  };

  useEffect(() => {
    setDependencySectionTouched(false);
  }, [config.id, isConnected]);

  useEffect(() => {
    if (!dependencySectionTouched) {
      setIsDependenciesCollapsed(allDependenciesReady);
    }
  }, [allDependenciesReady, dependencySectionTouched]);

  useEffect(() => {
    const initialStepStates = Object.fromEntries(
      (dependencyStatus?.plannedResources ?? []).map((resource) => [resource.key, 'idle' as SetupPlanStepStatus]),
    );
    setSetupPlanStepStates(initialStepStates);
    setSetupChecksComplete(false);
    setIsRunningSetupChecks(false);
    setManualError(null);
  }, [config.id, isConnected, dependencyStatus?.plannedResources]);

  const getSetupPlanLinks = (
    resource: IntegrationPlannedResourceStatus,
    displayName: string,
  ): Array<{ label: string; url: string }> => {
    if (config.id === 'firebase') {
      if (resource.key === 'gcp_project') {
        return [
          {
            label: 'Open GCP project',
            url: `https://console.cloud.google.com/home/dashboard?project=${encodeURIComponent(displayName)}`,
          },
          {
            label: 'Project IAM',
            url: `https://console.cloud.google.com/iam-admin/iam?project=${encodeURIComponent(displayName)}`,
          },
        ];
      }
      if (resource.key === 'provisioner_service_account') {
        const projectId = displayName.split('@')[1]?.split('.iam.gserviceaccount.com')[0] ?? effectiveFirebaseProjectId;
        return [
          {
            label: 'Service accounts',
            url: `https://console.cloud.google.com/iam-admin/serviceaccounts?project=${encodeURIComponent(projectId)}`,
          },
          {
            label: 'Provisioner IAM details',
            url: `https://console.cloud.google.com/iam-admin/serviceaccounts/details/${encodeURIComponent(displayName)}?project=${encodeURIComponent(projectId)}`,
          },
        ];
      }
      if (resource.key === 'provisioner_service_account_key') {
        const projectId = effectiveFirebaseProjectId;
        return [
          {
            label: 'Service account keys',
            url: `https://console.cloud.google.com/iam-admin/serviceaccounts?project=${encodeURIComponent(projectId)}`,
          },
          {
            label: 'Secret storage guide',
            url: config.docsUrl,
          },
        ];
      }
    }

    if (resource.key === 'github_identity') {
      return [
        { label: 'GitHub token settings', url: 'https://github.com/settings/tokens' },
        { label: 'GitHub profile', url: 'https://github.com/settings/profile' },
      ];
    }

    if (resource.key === 'expo_identity') {
      return [
        { label: 'Expo account', url: 'https://expo.dev/accounts' },
        { label: 'Expo access tokens', url: 'https://expo.dev/settings/access-tokens' },
      ];
    }

    return [{ label: 'Setup guide', url: config.docsUrl }];
  };

  const handleCopyValue = async (key: string, value: string): Promise<void> => {
    if (!value.trim()) return;
    await navigator.clipboard.writeText(value);
    setCopiedValueKey(key);
    window.setTimeout(() => {
      setCopiedValueKey((current) => (current === key ? null : current));
    }, 1400);
  };

  const runSetupChecks = async (): Promise<void> => {
    if (!dependencyStatus) {
      throw new Error('Dependency status is unavailable. Re-open this modal and try again.');
    }

    const missingRequiredDependencies = dependencyStatus.dependencies.filter(
      (dependency) => dependency.required && dependency.status !== 'ready',
    );
    if (missingRequiredDependencies.length > 0) {
      setSetupPlanStepStates((previous) => {
        const next = { ...previous };
        dependencyStatus.plannedResources.forEach((resource) => {
          next[resource.key] = 'failed';
        });
        return next;
      });
      throw new Error(
        `Missing required dependencies: ${missingRequiredDependencies.map((dependency) => dependency.label).join(', ')}`,
      );
    }

    setIsRunningSetupChecks(true);
    setSetupChecksComplete(false);

    try {
      for (const resource of dependencyStatus.plannedResources) {
        setSetupPlanStepStates((previous) => ({ ...previous, [resource.key]: 'in_progress' }));
        await new Promise((resolve) => setTimeout(resolve, 650));
        setSetupPlanStepStates((previous) => ({ ...previous, [resource.key]: 'completed' }));
      }
      setSetupChecksComplete(true);
    } catch (error) {
      setSetupChecksComplete(false);
      throw error;
    } finally {
      setIsRunningSetupChecks(false);
    }
  };

  const handleManualConnect = async () => {
    if (!allFilled) return;
    setManualError(null);
    if (requiresSetupChecksBeforeSave && !setupChecksComplete) {
      try {
        await runSetupChecks();
      } catch (err) {
        setManualError((err as Error).message);
      }
      return;
    }
    setIsSubmitting(true);
    try {
      await onConnect(config.id, fieldValues);
      setIsSubmitting(false);
      setSubmitted(true);
      setTimeout(() => {
        onClose();
      }, 900);
    } catch (err) {
      setManualError((err as Error).message);
      setIsSubmitting(false);
    }
  };

  const handleOAuthConnect = async () => {
    if (!onOAuthStart) return;
    setOauthStatus('waiting');
    setOauthProgress(null);
    setOauthError(null);
    try {
      await onOAuthStart(config.id, (progress) => {
        setOauthProgress(progress);
      });
      setOauthStatus('success');
      setTimeout(() => {
        onClose();
      }, 900);
    } catch (err) {
      setOauthStatus('error');
      setOauthError((err as Error).message);
    }
  };

  const handleDisconnect = async () => {
    setIsSubmitting(true);
    try {
      await onDisconnect(config.id);
    } finally {
      setIsSubmitting(false);
    }
    onClose();
  };

  const affectedPluginIds = PROVIDER_PLUGIN_MAP[config.id] ?? [];
  const affectedPlugins = ALL_REGISTRY_PLUGINS.filter((p) => affectedPluginIds.includes(p.id));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/55" onClick={onClose}>
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 12 }}
        transition={{ duration: 0.2, ease: 'easeOut' }}
        className="bg-background border border-border rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between p-6 border-b border-border">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-muted flex items-center justify-center shrink-0">
              <LogoIcon size={20} className={config.logoColor} />
            </div>
            <div>
              <h2 className="font-bold text-base tracking-tight">{config.name}</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                {isConnected ? (
                  <span className="flex items-center gap-1 text-emerald-500 font-medium">
                    <CheckCircle2 size={11} />
                    <span>Connected</span>
                  </span>
                ) : (
                  <span>Not connected</span>
                )}
              </p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded-lg hover:bg-accent transition-colors text-muted-foreground">
            <X size={18} />
          </button>
        </div>

        <div className="p-6 space-y-5 max-h-[60vh] overflow-y-auto">
          <p className="text-sm text-muted-foreground leading-relaxed">{config.description}</p>

          <div className="bg-muted/50 rounded-xl p-4 space-y-2">
            <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-2">Unlocks {affectedPlugins.length} plugins</p>
            <div className="flex flex-wrap gap-2">
              {affectedPlugins.map((p) => (
                <span key={p.id} className="flex items-center gap-1.5 text-[11px] font-medium bg-background border border-border px-2 py-1 rounded-lg">
                  <Code2 size={11} className="text-muted-foreground" />
                  <span>{p.name}</span>
                </span>
              ))}
            </div>
          </div>

          {dependencyStatus && dependencyStatus.dependencies.length > 0 && (
            <div className="bg-muted/50 rounded-xl p-4 space-y-2.5">
              <button
                type="button"
                onClick={() => {
                  setDependencySectionTouched(true);
                  setIsDependenciesCollapsed((previous) => !previous);
                }}
                className="w-full flex items-center justify-between text-left"
              >
                <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                  Required Dependencies
                </span>
                <div className="flex items-center gap-2">
                  {allDependenciesReady && (
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded-full border border-emerald-500/30 text-emerald-600 dark:text-emerald-400 bg-emerald-500/10">
                      All satisfied
                    </span>
                  )}
                  <ChevronRight
                    size={14}
                    className={`text-muted-foreground transition-transform ${isDependenciesCollapsed ? '' : 'rotate-90'}`}
                  />
                </div>
              </button>
              {!isDependenciesCollapsed && (
                <div className="space-y-2">
                  {dependencyStatus.dependencies.map((dependency) => (
                    <div key={dependency.key} className="rounded-lg border border-border bg-background px-3 py-2">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-xs font-semibold text-foreground">{dependency.label}</div>
                        <span
                          className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${
                            dependency.status === 'ready'
                              ? 'border-emerald-500/30 text-emerald-600 dark:text-emerald-400 bg-emerald-500/10'
                              : 'border-amber-500/30 text-amber-600 dark:text-amber-400 bg-amber-500/10'
                          }`}
                        >
                          {dependency.status === 'ready' ? 'Ready' : 'Missing'}
                        </span>
                      </div>
                      <p className="mt-1 text-[11px] text-muted-foreground">{dependency.description}</p>
                      {dependency.value && (
                        <p className="mt-1 text-[11px] font-mono text-foreground">{dependency.value}</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {dependencyStatus && dependencyStatus.plannedResources.length > 0 && (
            <div className="bg-muted/50 rounded-xl p-4 space-y-2.5">
              <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                Standardized Setup Plan
              </p>
              <div className="space-y-2">
                {dependencyStatus.plannedResources.map((resource, stepIdx) => {
                  const stepStatus = getEffectiveSetupPlanStepStatus(resource.key);
                  const displayName = getSetupPlanDisplayName(resource);
                  const stepLinks = getSetupPlanLinks(resource, displayName);
                  const primaryStepLink = stepLinks[0];
                  const isLastStep = stepIdx === dependencyStatus.plannedResources.length - 1;
                  return (
                    <div key={resource.key} className="relative pl-7">
                      {!isLastStep && <div className="absolute left-2 top-8 bottom-[-10px] w-px bg-border" />}
                      <motion.div
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.2, ease: 'easeOut' }}
                        className="rounded-lg border border-border bg-background px-3 py-2"
                      >
                        <motion.div
                          layout
                          className={`absolute -left-1 top-2.5 z-10 w-6 h-6 rounded-full border flex items-center justify-center shadow-sm ${
                            stepStatus === 'completed'
                              ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                              : stepStatus === 'in_progress'
                                ? 'border-primary/40 bg-primary/10 text-primary'
                                : stepStatus === 'failed'
                                  ? 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400'
                                  : 'border-border bg-background text-muted-foreground'
                          }`}
                        >
                          <AnimatePresence mode="wait" initial={false}>
                            {stepStatus === 'completed' ? (
                              <motion.span
                                key="completed"
                                initial={{ scale: 0.6, opacity: 0 }}
                                animate={{ scale: 1, opacity: 1 }}
                                exit={{ scale: 0.6, opacity: 0 }}
                                transition={{ duration: 0.18 }}
                                className="flex items-center justify-center"
                              >
                                <CheckCircle2 size={12} />
                              </motion.span>
                            ) : stepStatus === 'in_progress' ? (
                              <motion.span
                                key="in_progress"
                                initial={{ scale: 0.85, opacity: 0 }}
                                animate={{ scale: 1, opacity: 1 }}
                                exit={{ scale: 0.85, opacity: 0 }}
                                transition={{ duration: 0.16 }}
                                className="flex items-center justify-center"
                              >
                                <Loader2 size={12} className="animate-spin" />
                              </motion.span>
                            ) : stepStatus === 'failed' ? (
                              <motion.span
                                key="failed"
                                initial={{ scale: 0.7, opacity: 0 }}
                                animate={{ scale: 1, opacity: 1 }}
                                exit={{ scale: 0.7, opacity: 0 }}
                                transition={{ duration: 0.16 }}
                                className="flex items-center justify-center"
                              >
                                <AlertCircle size={12} />
                              </motion.span>
                            ) : (
                              <motion.span
                                key="idle"
                                initial={{ y: 2, opacity: 0 }}
                                animate={{ y: 0, opacity: 1 }}
                                exit={{ y: -2, opacity: 0 }}
                                transition={{ duration: 0.16 }}
                                className="text-[10px] font-bold leading-none"
                              >
                                {stepIdx + 1}
                              </motion.span>
                            )}
                          </AnimatePresence>
                        </motion.div>
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-xs font-semibold text-foreground">{resource.label}</p>
                          <span className="text-[10px] font-semibold text-muted-foreground">
                            {stepStatus === 'completed'
                              ? 'Complete'
                              : stepStatus === 'in_progress'
                                ? 'Checking...'
                                : stepStatus === 'failed'
                                  ? 'Blocked'
                                  : 'Pending'}
                          </span>
                        </div>
                        <p className="mt-1 text-[11px] text-muted-foreground">{resource.description}</p>
                        <div className="mt-1 flex items-start justify-between gap-2">
                          {primaryStepLink ? (
                            <a
                              href={primaryStepLink.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-muted/60 px-2.5 py-1 text-[11px] font-mono text-foreground transition-colors hover:border-primary/40 hover:bg-primary/5"
                            >
                              <span className="break-all">{displayName}</span>
                              <ExternalLink size={11} className="shrink-0 text-muted-foreground" />
                            </a>
                          ) : (
                            <span className="inline-flex max-w-full items-center rounded-md border border-border bg-muted/60 px-2.5 py-1 text-[11px] font-mono text-foreground">
                              <span className="break-all">{displayName}</span>
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={() => void handleCopyValue(`plan-${resource.key}`, displayName)}
                            className="shrink-0 inline-flex items-center gap-1 text-[10px] font-medium text-muted-foreground hover:text-foreground transition-colors"
                            aria-label={`Copy ${resource.label} value`}
                          >
                            {copiedValueKey === `plan-${resource.key}` ? (
                              <>
                                <CheckCheck size={12} className="text-emerald-500" />
                                <span className="text-emerald-600 dark:text-emerald-400">Copied</span>
                              </>
                            ) : (
                              <>
                                <Copy size={12} />
                                <span>Copy</span>
                              </>
                            )}
                          </button>
                        </div>
                      </motion.div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {manualError && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 flex items-start gap-2">
              <AlertCircle size={14} className="text-red-500 shrink-0 mt-0.5" />
              <p className="text-xs text-red-600 dark:text-red-400">{manualError}</p>
            </div>
          )}

          {!isConnected && config.supportsOAuth && (
            <div className="space-y-4">
              <div className="flex rounded-lg border border-border overflow-hidden">
                <button
                  type="button"
                  onClick={() => setConnectMode('oauth')}
                  className={`flex-1 text-xs font-bold py-2.5 transition-colors ${connectMode === 'oauth' ? 'bg-primary text-primary-foreground' : 'bg-muted/50 text-muted-foreground hover:text-foreground'}`}
                >
                  Sign in with Google
                </button>
                <button
                  type="button"
                  onClick={() => setConnectMode('manual')}
                  className={`flex-1 text-xs font-bold py-2.5 transition-colors border-l border-border ${connectMode === 'manual' ? 'bg-primary text-primary-foreground' : 'bg-muted/50 text-muted-foreground hover:text-foreground'}`}
                >
                  Paste SA Key
                </button>
              </div>

              {connectMode === 'oauth' && (
                <div className="space-y-3">
                  <div className="bg-blue-500/8 border border-blue-500/20 rounded-xl p-4">
                    <p className="text-xs text-blue-600 dark:text-blue-400 leading-relaxed">
                      <span className="font-bold">Recommended.</span>{' '}
                      Sign in with your Google account to automatically create a provisioner service account.
                      The OAuth session is used once and discarded — only the SA key is stored.
                    </p>
                  </div>

                  {oauthStatus === 'error' && oauthError && (
                    <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 flex items-start gap-2">
                      <AlertCircle size={14} className="text-red-500 shrink-0 mt-0.5" />
                      <p className="text-xs text-red-600 dark:text-red-400">{oauthError}</p>
                    </div>
                  )}
                </div>
              )}

              {connectMode === 'manual' && (
                <div className="space-y-4">
                  <div className="bg-amber-500/8 border border-amber-500/20 rounded-xl p-4">
                    <p className="text-xs text-amber-600 dark:text-amber-400 leading-relaxed">
                      <span className="font-bold">Manual mode.</span>{' '}
                      Paste a service account JSON key that you've already created in the Google Cloud Console.
                    </p>
                  </div>
                  {config.fields.map((field) => (
                    <div key={field.key} className="space-y-1.5">
                      <label className="text-xs font-semibold text-foreground">{field.label}</label>
                      {field.type === 'textarea' ? (
                        <textarea
                          rows={5}
                          placeholder={field.placeholder}
                          value={fieldValues[field.key] ?? ''}
                          onChange={(e) => setFieldValues((v) => ({ ...v, [field.key]: e.target.value }))}
                          className="w-full px-3 py-2.5 rounded-lg border border-border bg-background font-mono text-[11px] leading-relaxed focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all resize-none"
                        />
                      ) : (
                        <div className="relative">
                          <input
                            type={field.type === 'password' && !revealedFields[field.key] ? 'password' : 'text'}
                            placeholder={field.placeholder}
                            value={fieldValues[field.key] ?? ''}
                            onChange={(e) => setFieldValues((v) => ({ ...v, [field.key]: e.target.value }))}
                            className="w-full px-3 py-2.5 rounded-lg border border-border bg-background font-mono text-[12px] focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all pr-10"
                          />
                          {field.type === 'password' && (
                            <button
                              type="button"
                              onClick={() => setRevealedFields((v) => ({ ...v, [field.key]: !v[field.key] }))}
                              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                            >
                              {revealedFields[field.key] ? <EyeOff size={14} /> : <Eye size={14} />}
                            </button>
                          )}
                        </div>
                      )}
                      <p className="text-[11px] text-muted-foreground flex gap-1.5 leading-relaxed">
                        <Info size={11} className="shrink-0 mt-0.5" />
                        <span>{field.hint}</span>
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {!isConnected && !config.supportsOAuth && (
            <div className="space-y-4">
              {config.fields.map((field) => (
                <div key={field.key} className="space-y-1.5">
                  <label className="text-xs font-semibold text-foreground">{field.label}</label>
                  {field.type === 'textarea' ? (
                    <textarea
                      rows={5}
                      placeholder={field.placeholder}
                      value={fieldValues[field.key] ?? ''}
                      onChange={(e) => setFieldValues((v) => ({ ...v, [field.key]: e.target.value }))}
                      className="w-full px-3 py-2.5 rounded-lg border border-border bg-background font-mono text-[11px] leading-relaxed focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all resize-none"
                    />
                  ) : (
                    <div className="relative">
                      <input
                        type={field.type === 'password' && !revealedFields[field.key] ? 'password' : 'text'}
                        placeholder={field.placeholder}
                        value={fieldValues[field.key] ?? ''}
                        onChange={(e) => setFieldValues((v) => ({ ...v, [field.key]: e.target.value }))}
                        className="w-full px-3 py-2.5 rounded-lg border border-border bg-background font-mono text-[12px] focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all pr-10"
                      />
                      {field.type === 'password' && (
                        <button
                          type="button"
                          onClick={() => setRevealedFields((v) => ({ ...v, [field.key]: !v[field.key] }))}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                        >
                          {revealedFields[field.key] ? <EyeOff size={14} /> : <Eye size={14} />}
                        </button>
                      )}
                    </div>
                  )}
                  <p className="text-[11px] text-muted-foreground flex gap-1.5 leading-relaxed">
                    <Info size={11} className="shrink-0 mt-0.5" />
                    <span>{field.hint}</span>
                  </p>
                </div>
              ))}
            </div>
          )}

          {isConnected && (
            <div className="space-y-3">
              <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-xl p-4 flex items-center gap-3">
                <CheckCircle2 size={18} className="text-emerald-500 shrink-0" />
                <div>
                  <p className="text-sm font-bold text-emerald-600 dark:text-emerald-400">Integration active</p>
                  <p className="text-xs text-emerald-600/80 dark:text-emerald-400/80 mt-0.5">
                    Credentials stored securely in the local vault. All {affectedPlugins.length} plugins are available.
                  </p>
                </div>
              </div>

            </div>
          )}

          <a href={config.docsUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-xs text-primary font-medium hover:underline">
            <ExternalLink size={12} />
            <span>View setup guide</span>
          </a>
        </div>

        <div className="flex items-center justify-between p-5 border-t border-border bg-muted/20">
          {isConnected ? (
            <button type="button" onClick={() => void handleDisconnect()} disabled={isSubmitting} className="flex items-center gap-2 text-xs font-bold text-red-500 hover:text-red-400 px-3 py-2 border border-red-500/30 rounded-lg hover:bg-red-500/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
              <Unlink size={13} />
              <span>Disconnect</span>
            </button>
          ) : (
            <div />
          )}
          {!isConnected && connectMode === 'oauth' && config.supportsOAuth && (
            <button
              type="button"
              onClick={() => void handleOAuthConnect()}
              disabled={oauthStatus === 'waiting' || oauthStatus === 'success'}
              className="flex items-center gap-2 bg-foreground text-background px-5 py-2.5 rounded-lg text-sm font-bold hover:opacity-90 transition-all disabled:opacity-40 disabled:cursor-not-allowed ml-auto"
            >
              {oauthStatus === 'waiting' ? (
                <span className="flex items-center gap-2">
                  <Loader2 size={14} className="animate-spin" />
                  <span>
                    {oauthProgress?.steps.find((step) => step.status === 'in_progress')?.label ??
                      'Waiting for Google sign-in...'}
                  </span>
                </span>
              ) : oauthStatus === 'success' ? (
                <span className="flex items-center gap-2">
                  <CheckCircle2 size={14} />
                  <span>Connected — continuing...</span>
                </span>
              ) : (
                <span className="flex items-center gap-2">
                  <Globe size={14} />
                  <span>Sign in with Google</span>
                  <ArrowRight size={13} />
                </span>
              )}
            </button>
          )}
          {!isConnected && (connectMode === 'manual' || !config.supportsOAuth) && (
            <button
              type="button"
              onClick={() => void handleManualConnect()}
              disabled={!allFilled || isSubmitting || isRunningSetupChecks}
              className="flex items-center gap-2 bg-primary text-primary-foreground px-5 py-2.5 rounded-lg text-sm font-bold hover:opacity-90 transition-all disabled:opacity-40 disabled:cursor-not-allowed ml-auto"
            >
              {isRunningSetupChecks ? (
                <span className="flex items-center gap-2">
                  <Loader2 size={14} className="animate-spin" />
                  <span>Running checks...</span>
                </span>
              ) : isSubmitting ? (
                <span className="flex items-center gap-2">
                  <Loader2 size={14} className="animate-spin" />
                  <span>Verifying...</span>
                </span>
              ) : submitted ? (
                <span className="flex items-center gap-2">
                  <CheckCircle2 size={14} />
                  <span>Connected!</span>
                </span>
              ) : (
                <span className="flex items-center gap-2">
                  <Link2 size={14} />
                  <span>
                    {requiresSetupChecksBeforeSave
                      ? setupChecksComplete
                        ? 'Save Integration'
                        : 'Submit'
                      : 'Connect Integration'}
                  </span>
                  <ArrowRight size={13} />
                </span>
              )}
            </button>
          )}
          {isConnected && (
            <button type="button" onClick={onClose} className="text-xs font-bold px-4 py-2 border border-border rounded-lg hover:bg-accent transition-colors">
              Done
            </button>
          )}
        </div>
      </motion.div>
    </div>
  );
}
