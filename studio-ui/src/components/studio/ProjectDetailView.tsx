import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, AlertCircle, CheckCircle2, Settings } from 'lucide-react';
import { api } from './helpers';
import { inferTemplateIdFromModules, ModuleSelectionWizard } from './ModuleSelectionWizard';
import { ProjectQuickLinks } from './ProjectQuickLinks';
import { SetupWizard } from './SetupWizard';
import { TeardownWizard } from './TeardownWizard';
import { usePluginCatalog } from './usePluginCatalog';
import type {
  ConnectedProviders,
  ModuleDefinition,
  ModuleFunctionGroupId,
  ModuleId,
  ProjectDetail,
  ProjectTemplate,
  ProjectTemplateId,
  ProvisioningPlanResponse,
} from './types';

export type ProjectSubtab = 'modules' | 'setup' | 'dashboard' | 'settings';

export function ProjectDetailView({
  projectDetail,
  projectTab,
  onProjectTabChange,
  onDeleteProject,
  onRefreshProjectDetail,
  connectedProviders,
  onProjectProvidersRefresh,
}: {
  projectDetail: ProjectDetail;
  projectTab?: ProjectSubtab;
  onProjectTabChange?: (tab: ProjectSubtab) => void;
  connectedProviders?: ConnectedProviders;
  projectPlugins?: string[];
  firebaseConnectionDetails?: unknown;
  githubProjectInitialized?: boolean;
  expoProjectInitialized?: boolean;
  integrationDependencyStatus?: unknown;
  onProjectConnect?: unknown;
  onProjectOAuthStart?: unknown;
  onProjectTriggerSetup?: unknown;
  onProjectDisconnect?: unknown;
  onProjectProvidersRefresh?: () => Promise<void>;
  onDeleteProject: () => void;
  /** After applying or dismissing imported instance vault sync, refresh project detail from the parent. */
  onRefreshProjectDetail?: () => Promise<void>;
}) {
  const [tab, setTab] = useState<ProjectSubtab>('modules');
  const [plan, setPlan] = useState<ProvisioningPlanResponse | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isSavingModules, setIsSavingModules] = useState(false);
  const [isTeardownRunning, setIsTeardownRunning] = useState(false);
  const [isExportingMigration, setIsExportingMigration] = useState(false);
  const [instanceVaultBusy, setInstanceVaultBusy] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);
  const [exportPassphraseMode, setExportPassphraseMode] = useState<'custom' | 'none'>('none');
  const [exportPassphrase, setExportPassphrase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState<ProjectTemplateId>(
    'mobile-app' as ProjectTemplateId,
  );
  const [selectedModules, setSelectedModules] = useState<ModuleId[]>([]);

  const { catalog: pluginCatalog } = usePluginCatalog();
  // Wizard expects (moduleIds, templates, modules); both come from the live
  // catalog. Until the catalog has loaded the matcher returns 'custom' which
  // is harmless — the next render once the catalog arrives reclassifies.
  const catalogTemplates: ProjectTemplate[] = useMemo(() => {
    if (!pluginCatalog) return [];
    return Object.values(pluginCatalog.raw.templates).map((t) => ({
      id: t.id as ProjectTemplateId,
      label: t.label,
      description: t.description,
      modules: t.modules as ModuleId[],
    }));
  }, [pluginCatalog]);
  const catalogModules: ModuleDefinition[] = useMemo(() => {
    if (!pluginCatalog) return [];
    return Object.values(pluginCatalog.raw.modules).map((entry) => ({
      id: entry.id as ModuleId,
      label: entry.label,
      description: entry.description,
      provider: entry.provider,
      functionGroupId: (entry.functionGroupId ?? '') as ModuleFunctionGroupId,
      requiredModules: entry.requiredModules as ModuleId[],
      optionalModules: entry.optionalModules as ModuleId[],
      stepKeys: [],
      teardownStepKeys: [],
    }));
  }, [pluginCatalog]);

  // Refs let loadPlan read the latest templates/modules without changing
  // identity when the catalog resolves — otherwise loadPlan would recreate
  // and the useEffect would refetch the plan a second time.
  const catalogTemplatesRef = useRef(catalogTemplates);
  const catalogModulesRef = useRef(catalogModules);
  catalogTemplatesRef.current = catalogTemplates;
  catalogModulesRef.current = catalogModules;
  const hasAutoNavigatedRef = useRef(false);

  const projectId = projectDetail.project.id;
  const activeTab = projectTab ?? tab;
  const updateTab = useCallback(
    (nextTab: ProjectSubtab): void => {
      onProjectTabChange?.(nextTab);
      if (projectTab === undefined) {
        setTab(nextTab);
      }
    },
    [onProjectTabChange, projectTab],
  );

  const loadPlan = useCallback(async () => {
    setIsRefreshing(true);
    setError(null);
    try {
      const payload = await api<ProvisioningPlanResponse>(
        `/api/projects/${encodeURIComponent(projectId)}/provisioning/plan`,
      );
      setPlan(payload);
      const mods = (payload.selectedModules as ModuleId[]) ?? [];
      setSelectedModules(mods);
      setSelectedTemplateId(
        inferTemplateIdFromModules(mods, catalogTemplatesRef.current, catalogModulesRef.current),
      );
      const allDone = Object.values(payload.nodeStates).every(
        (state) => state.status === 'completed' || state.status === 'skipped',
      );
      if (allDone && !hasAutoNavigatedRef.current) {
        hasAutoNavigatedRef.current = true;
        updateTab('dashboard');
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsRefreshing(false);
    }
  }, [projectId, updateTab]);

  useEffect(() => {
    void loadPlan();
  }, [loadPlan]);

  // Re-classify the active template once the catalog arrives — `loadPlan`
  // may have raced ahead of `usePluginCatalog()` and stamped 'custom' due to
  // the templates list being empty at that point.
  useEffect(() => {
    if (catalogTemplates.length === 0) return;
    if (selectedModules.length === 0) return;
    setSelectedTemplateId((current) => {
      const next = inferTemplateIdFromModules(selectedModules, catalogTemplates, catalogModules);
      return next === current ? current : next;
    });
  }, [catalogTemplates, catalogModules, selectedModules]);

  const setupCompleted = useMemo(() => {
    if (!plan) return false;
    const values = Object.values(plan.nodeStates);
    if (values.length === 0) return false;
    return values.every((state) => state.status === 'completed' || state.status === 'skipped');
  }, [plan]);

  const modulesDirty = useMemo(() => {
    if (!plan) return false;
    const saved = new Set((plan.selectedModules as ModuleId[]) ?? []);
    const cur = new Set(selectedModules);
    if (saved.size !== cur.size) return true;
    for (const id of cur) {
      if (!saved.has(id)) return true;
    }
    return false;
  }, [plan, selectedModules]);

  /** Steps that describe module-scoped resources (e.g. LLM EAS sync) follow this list so copy matches the Modules tab even before Apply. */
  const selectedModulesForStepCopy = useMemo((): string[] => {
    if (!plan) return selectedModules as string[];
    return modulesDirty ? (selectedModules as string[]) : ((plan.selectedModules as string[]) ?? []);
  }, [plan, modulesDirty, selectedModules]);

  const runTeardown = useCallback(async () => {
    setIsTeardownRunning(true);
    setError(null);
    try {
      await api(`/api/projects/${encodeURIComponent(projectId)}/provisioning/teardown/run`, {
        method: 'POST',
      });
      await loadPlan();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsTeardownRunning(false);
    }
  }, [loadPlan, projectId]);

  const exportProjectMigration = useCallback(
    async (mode: 'custom' | 'none', customPassphrase?: string) => {
      setIsExportingMigration(true);
      try {
        const body =
          mode === 'custom' && customPassphrase
            ? { passphrase: customPassphrase }
            : {};
        const payload = await api<{
          fileName: string;
          bundle: {
            format: 'studio-project-migration';
            version: 1;
            projectId: string;
            encryptedPayload: string;
          };
        }>(`/api/projects/${encodeURIComponent(projectId)}/migration/export`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const blob = new Blob([JSON.stringify(payload.bundle, null, 2)], {
          type: 'application/json;charset=utf-8',
        });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = payload.fileName;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
      } finally {
        setIsExportingMigration(false);
      }
    },
    [projectId],
  );

  return (
    <div className="space-y-4">
      <ProjectQuickLinks plan={plan} onDeleteProject={onDeleteProject} />

      <div className="flex items-center gap-1 border-b border-border flex-wrap">
        {(['modules', 'setup', 'dashboard', 'settings'] as const).map((tabId) => (
          <button
            key={tabId}
            type="button"
            onClick={() => updateTab(tabId)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px ${
              activeTab === tabId
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {tabId === 'modules'
              ? 'Modules'
              : tabId === 'setup'
                ? 'Setup'
                : tabId === 'dashboard'
                  ? 'Dashboard'
                  : 'Settings'}
          </button>
        ))}
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-xs text-red-600 dark:text-red-400 flex items-start gap-2">
          <AlertCircle size={14} className="mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {projectDetail.instanceVaultSync?.vaultSealed ? (
        <div className="rounded-lg border border-amber-500/35 bg-amber-500/5 p-3 text-xs text-amber-900 dark:text-amber-200 flex items-start gap-2">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span>
            A pending migration included organization-level credentials (GitHub, Expo, or Apple). Unlock your vault to
            compare them with this Studio or apply them to this machine.
          </span>
        </div>
      ) : null}

      {projectDetail.instanceVaultSync?.pending && !projectDetail.instanceVaultSync.vaultSealed ? (
        <div className="rounded-lg border border-border bg-card p-4 space-y-2">
          <p className="text-sm font-semibold">Imported instance integrations</p>
          <p className="text-xs text-muted-foreground">
            Provisioning history came from another Studio, but this machine&apos;s organization vault does not match
            the exported GitHub, Expo, or Apple material. Apply the import to align this Studio with the source, or
            dismiss if you intentionally use different tokens here.
          </p>
          <ul className="text-xs space-y-1 list-disc list-inside text-muted-foreground">
            {projectDetail.instanceVaultSync.providers.map((p) => (
              <li key={p.providerId}>
                <span className="font-medium text-foreground">{p.label}</span>
                {p.localMissing ? ' — not configured on this Studio' : null}
                {p.conflicting ? ' — differs from credentials on this Studio' : null}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2 pt-1">
            <button
              type="button"
              disabled={instanceVaultBusy}
              onClick={() => {
                void (async () => {
                  setInstanceVaultBusy(true);
                  setError(null);
                  try {
                    const ids = projectDetail.instanceVaultSync!.providers.map((p) => p.providerId);
                    await api(`/api/projects/${encodeURIComponent(projectId)}/instance-vault-sync/apply`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ providerIds: ids }),
                    });
                    await onRefreshProjectDetail?.();
                  } catch (err) {
                    setError((err as Error).message);
                  } finally {
                    setInstanceVaultBusy(false);
                  }
                })();
              }}
              className="text-xs font-bold rounded-lg border border-primary/40 px-3 py-2 text-primary hover:bg-primary/10 disabled:opacity-50"
            >
              {instanceVaultBusy ? 'Applying…' : 'Apply imported integrations'}
            </button>
            <button
              type="button"
              disabled={instanceVaultBusy}
              onClick={() => {
                void (async () => {
                  setInstanceVaultBusy(true);
                  setError(null);
                  try {
                    await api(`/api/projects/${encodeURIComponent(projectId)}/instance-vault-sync/dismiss`, {
                      method: 'POST',
                    });
                    await onRefreshProjectDetail?.();
                  } catch (err) {
                    setError((err as Error).message);
                  } finally {
                    setInstanceVaultBusy(false);
                  }
                })();
              }}
              className="text-xs font-semibold rounded-lg border border-border px-3 py-2 hover:bg-accent disabled:opacity-50"
            >
              Dismiss
            </button>
          </div>
        </div>
      ) : null}

      {activeTab === 'modules' && (
        <ModuleSelectionWizard
          selectedTemplateId={selectedTemplateId}
          selectedModuleIds={selectedModules}
          savedModuleIds={(plan?.selectedModules as ModuleId[]) ?? []}
          onTemplateChange={(templateId, modules) => {
            setSelectedTemplateId(templateId);
            setSelectedModules(modules);
          }}
          onModulesChange={(modules) => {
            setSelectedModules(modules);
            setSelectedTemplateId(inferTemplateIdFromModules(modules, catalogTemplates, catalogModules));
          }}
          hasPendingChanges={modulesDirty}
          isApplying={isSavingModules}
          onApply={() => {
            void (async () => {
              setIsSavingModules(true);
              setError(null);
              try {
                await api(`/api/projects/${encodeURIComponent(projectId)}/provisioning/plan/modules`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ modules: selectedModules }),
                });
                await loadPlan();
                updateTab('setup');
              } catch (err) {
                setError((err as Error).message);
              } finally {
                setIsSavingModules(false);
              }
            })();
          }}
        />
      )}

      {activeTab === 'setup' && (
        <SetupWizard
          projectId={projectId}
          plan={plan}
          displaySelectedModules={selectedModulesForStepCopy}
          connectedProviders={connectedProviders}
          instanceVaultSync={projectDetail.instanceVaultSync}
          onRefreshProjectDetail={onRefreshProjectDetail}
          onProjectProvidersRefresh={onProjectProvidersRefresh}
          onPlanChange={setPlan}
          onUserActionComplete={async (nodeKey, resources) => {
            await api(
              `/api/projects/${encodeURIComponent(projectId)}/provisioning/plan/user-action/${encodeURIComponent(nodeKey)}/complete`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ resourcesProduced: resources }),
              },
            );
            await loadPlan();
          }}
          onRefresh={loadPlan}
          onRecomputePlan={async () => {
            const modules = (plan?.selectedModules as ModuleId[]) ?? selectedModules;
            await api(`/api/projects/${encodeURIComponent(projectId)}/provisioning/plan/modules`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ modules }),
            });
            await loadPlan();
          }}
        />
      )}

      {activeTab === 'dashboard' && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="rounded-xl border border-border bg-card p-4">
            <p className="text-xs uppercase font-bold tracking-wide text-muted-foreground">Setup</p>
            <p className="text-sm font-semibold mt-2 flex items-center gap-2">
              {setupCompleted ? <CheckCircle2 size={14} className="text-emerald-500" /> : <Activity size={14} />}
              {setupCompleted ? 'Complete' : 'In Progress'}
            </p>
          </div>
          <div className="rounded-xl border border-border bg-card p-4">
            <p className="text-xs uppercase font-bold tracking-wide text-muted-foreground">Provisioning Runs</p>
            <p className="text-xl font-bold mt-2">{projectDetail.provisioning.runs.length}</p>
          </div>
          <div className="rounded-xl border border-border bg-card p-4">
            <p className="text-xs uppercase font-bold tracking-wide text-muted-foreground">Last Run Status</p>
            <p className="text-sm font-semibold mt-2">
              {projectDetail.provisioning.runs[0]?.status ?? 'No runs'}
            </p>
          </div>
        </div>
      )}

      {activeTab === 'settings' && (
        <div className="space-y-4">
          <div className="rounded-xl border border-border bg-card p-4 space-y-3">
            <div>
              <p className="text-sm font-semibold">Project Migration</p>
              <p className="text-xs text-muted-foreground">
                Export an encrypted migration file. Optionally set a bundle passphrase for use on another machine;
                otherwise the bundle is sealed with your unlocked vault session keys only.
              </p>
            </div>
            <button
              type="button"
              disabled={isExportingMigration}
              onClick={() => setShowExportModal(true)}
              className="text-xs font-bold rounded-lg border border-primary/40 px-3 py-2 text-primary hover:bg-primary/10 disabled:opacity-50"
            >
              Export Encrypted Migration
            </button>
          </div>

          {showExportModal && (
            <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6">
              <div className="w-full max-w-md rounded-xl border border-border bg-card p-5 space-y-4 shadow-lg">
                <div>
                  <h2 className="text-lg font-semibold">Export Project Migration</h2>
                  <p className="text-xs text-muted-foreground mt-1">
                    Choose how to encrypt the bundle. Use a passphrase to make it importable on any machine.
                  </p>
                </div>

                <div className="space-y-2">
                  {(
                    [
                      { value: 'custom', label: 'Set a custom passphrase', hint: 'Import on another machine with this passphrase' },
                      {
                        value: 'none',
                        label: 'No bundle passphrase',
                        hint: 'Uses your unlocked vault keys — import only on this install with the vault unlocked',
                      },
                    ] as const
                  ).map(({ value, label, hint }) => (
                    <label key={value} className="flex items-start gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="exportMode"
                        value={value}
                        checked={exportPassphraseMode === value}
                        onChange={() => setExportPassphraseMode(value)}
                        className="mt-0.5"
                      />
                      <div>
                        <p className="text-xs font-semibold">{label}</p>
                        <p className="text-[11px] text-muted-foreground">{hint}</p>
                      </div>
                    </label>
                  ))}
                </div>

                {exportPassphraseMode === 'custom' && (
                  <label className="block text-xs font-semibold text-muted-foreground">
                    Passphrase <span className="font-normal">(min. 12 chars)</span>
                    <input
                      type="password"
                      className="mt-1 block w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                      placeholder="Enter bundle passphrase"
                      value={exportPassphrase}
                      onChange={(e) => setExportPassphrase(e.target.value)}
                    />
                  </label>
                )}

                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setShowExportModal(false);
                      setExportPassphrase('');
                      setExportPassphraseMode('none');
                    }}
                    className="rounded-md border border-border px-3 py-2 text-xs font-semibold hover:bg-accent"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={
                      isExportingMigration ||
                      (exportPassphraseMode === 'custom' && exportPassphrase.trim().length < 12)
                    }
                    onClick={() => {
                      const pass = exportPassphraseMode === 'custom' ? exportPassphrase.trim() : undefined;
                      void exportProjectMigration(exportPassphraseMode, pass)
                        .then(() => {
                          setShowExportModal(false);
                          setExportPassphrase('');
                          setExportPassphraseMode('none');
                        })
                        .catch((err: Error) => {
                          setError(err.message);
                          setShowExportModal(false);
                          setExportPassphrase('');
                          setExportPassphraseMode('none');
                        });
                    }}
                    className="rounded-md bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-50"
                  >
                    {isExportingMigration ? 'Exporting...' : 'Export'}
                  </button>
                </div>
              </div>
            </div>
          )}

          <div className="rounded-xl border border-border bg-card p-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Settings size={14} className="text-muted-foreground" />
              <div>
                <p className="text-sm font-semibold">Project Settings</p>
                <p className="text-xs text-muted-foreground">Manage teardown and destructive operations.</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                void (async () => {
                  await api(`/api/projects/${encodeURIComponent(projectId)}/provisioning/teardown`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ modules: selectedModules }),
                  });
                  await loadPlan();
                })();
              }}
              className="text-xs font-bold rounded-lg border border-border px-3 py-2 hover:bg-accent"
            >
              Build Teardown Plan
            </button>
          </div>
          <TeardownWizard plan={plan} isRunning={isTeardownRunning} onRun={runTeardown} />
        </div>
      )}
    </div>
  );
}

