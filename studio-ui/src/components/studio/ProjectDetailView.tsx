import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, AlertCircle, CheckCircle2, Settings } from 'lucide-react';
import { api } from './helpers';
import { inferTemplateIdFromModules, ModuleSelectionWizard } from './ModuleSelectionWizard';
import { LlmProvidersPanel } from './LlmProvidersPanel';
import { ProjectQuickLinks } from './ProjectQuickLinks';
import { SetupWizard } from './SetupWizard';
import { TeardownWizard } from './TeardownWizard';
import { usePluginCatalog } from './usePluginCatalog';
import type {
  ModuleDefinition,
  ModuleFunctionGroupId,
  ModuleId,
  ProjectDetail,
  ProjectTemplate,
  ProjectTemplateId,
  ProvisioningPlanResponse,
} from './types';

export type ProjectSubtab = 'modules' | 'setup' | 'dashboard' | 'llm' | 'settings';

export function ProjectDetailView({
  projectDetail,
  projectTab,
  onProjectTabChange,
  onDeleteProject,
}: {
  projectDetail: ProjectDetail;
  projectTab?: ProjectSubtab;
  onProjectTabChange?: (tab: ProjectSubtab) => void;
  connectedProviders?: unknown;
  projectPlugins?: string[];
  firebaseConnectionDetails?: unknown;
  githubProjectInitialized?: boolean;
  expoProjectInitialized?: boolean;
  integrationDependencyStatus?: unknown;
  onProjectConnect?: unknown;
  onProjectOAuthStart?: unknown;
  onProjectTriggerSetup?: unknown;
  onProjectDisconnect?: unknown;
  onProjectProvidersRefresh?: unknown;
  onDeleteProject: () => void;
}) {
  const [tab, setTab] = useState<ProjectSubtab>('modules');
  const [plan, setPlan] = useState<ProvisioningPlanResponse | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isSavingModules, setIsSavingModules] = useState(false);
  const [isTeardownRunning, setIsTeardownRunning] = useState(false);
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
      if (allDone) {
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

  return (
    <div className="space-y-4">
      <ProjectQuickLinks plan={plan} onDeleteProject={onDeleteProject} />

      <div className="flex items-center gap-1 border-b border-border flex-wrap">
        {(['modules', 'setup', 'dashboard', 'llm', 'settings'] as const).map((tabId) => (
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
                  : tabId === 'llm'
                    ? 'AI / LLM'
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

      {activeTab === 'modules' && (
        <ModuleSelectionWizard
          selectedTemplateId={selectedTemplateId}
          selectedModuleIds={selectedModules}
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
          setupStepCount={plan?.nodes.length ?? null}
          savedModuleCount={plan?.selectedModules.length ?? null}
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

      {activeTab === 'llm' && (
        <LlmProvidersPanel
          projectId={projectId}
          effectiveSelectedModules={selectedModulesForStepCopy as ModuleId[]}
          onJumpToSetup={() => updateTab('setup')}
          onJumpToModules={() => updateTab('modules')}
        />
      )}

      {activeTab === 'settings' && (
        <div className="space-y-4">
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

