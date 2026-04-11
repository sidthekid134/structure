import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import {
  ALL_REGISTRY_PLUGINS,
  INTEGRATION_CONFIGS,
  PROVIDER_PLUGIN_MAP,
  REGISTRY_CATEGORIES,
} from './constants';
import { api, bundleIdFromAppDomain, formatDate, isValidAppHostname, providerToBackendKey, slugify } from './helpers';
import {
  CreateProjectModal,
  DEFAULT_ENVIRONMENTS,
  DEFAULT_MODULE_IDS,
  type CreateProjectForm,
} from './CreateProjectModal';
import { IntegrationModal } from './IntegrationModal';
import { MainHeader } from './MainHeader';
import { OrgOverview } from './OrgOverview';
import { ProjectDetailView } from './ProjectDetailView';
import { RegistryView } from './RegistryView';
import { Sidebar } from './Sidebar';
import { Toast } from './Toast';
import type {
  ConnectedProviders,
  FirebaseConnectionDetails,
  GcpOAuthStepStatus,
  GcpOAuthSessionStatus,
  IntegrationConfig,
  IntegrationDependencyProviderStatus,
  IntegrationStatusRecord,
  OrganizationProfile,
  ProjectDetail,
  ProjectSummary,
  ProviderId,
  RegistryPlugin,
  StudioView,
} from './types';

export default function PlatformStudio() {
  const [isDark, setIsDark] = useState(() => {
    const stored = localStorage.getItem('studio-theme');
    if (stored !== null) return stored === 'dark';
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  });
  const [view, setView] = useState<StudioView>('overview');
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);

  const [projectDetail, setProjectDetail] = useState<ProjectDetail | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [wsStatus, setWsStatus] = useState<'offline' | 'connecting' | 'live' | 'error'>('offline');
  const [toast, setToast] = useState<{ text: string; tone: 'ok' | 'error' } | null>(null);
  const [createForm, setCreateForm] = useState<CreateProjectForm>({
    name: '',
    slug: '',
    domain: '',
    description: '',
    environments: DEFAULT_ENVIRONMENTS,
    templateId: 'mobile-app',
    modules: DEFAULT_MODULE_IDS,
  });
  const [connections, setConnections] = useState<Map<string, WebSocket>>(new Map());
  const [connectedProviders, setConnectedProviders] = useState<ConnectedProviders>({
    firebase: false,
    expo: false,
    github: false,
  });
  const [activeIntegration, setActiveIntegration] = useState<ProviderId | null>(null);
  const [firebaseDetails, setFirebaseDetails] = useState<FirebaseConnectionDetails | null>(null);
  const [githubProjectInitialized, setGithubProjectInitialized] = useState(false);
  const [expoProjectInitialized, setExpoProjectInitialized] = useState(false);
  const [integrationDependencyStatus, setIntegrationDependencyStatus] = useState<
    Record<string, IntegrationDependencyProviderStatus>
  >({});

  const isConfiguredIntegration = (entry: unknown): boolean => {
    if (!entry || typeof entry !== 'object') return false;
    const status = (entry as IntegrationStatusRecord).status;
    return status === 'configured';
  };
  const hasConfiguredIntegration = (
    integrations: Record<string, unknown> | Record<string, IntegrationStatusRecord> | undefined,
    keys: string[],
  ): boolean => {
    if (!integrations) return false;
    return keys.some((key) => isConfiguredIntegration(integrations[key]));
  };
  const refreshConnectedProviders = async (): Promise<void> => {
    const organization = await api<OrganizationProfile>('/api/organization');
    const projectIntegrations =
      projectDetail?.integrations ??
      (activeProjectId
        ? (await api<ProjectDetail>(`/api/projects/${encodeURIComponent(activeProjectId)}`)).integrations
        : undefined);

    let firebaseConnected = false;

    if (activeProjectId) {
      try {
        const fbStatus = await api<{
          connected: boolean;
          details?: {
            projectId?: string;
            serviceAccountEmail?: string;
            userEmail?: string;
          };
          integration?: { config?: Record<string, string> };
        }>(`/api/projects/${encodeURIComponent(activeProjectId)}/integrations/firebase/connection`);
        if (fbStatus.connected) {
          firebaseConnected = true;
          setFirebaseDetails(
            fbStatus.details
              ? {
                  project_id: fbStatus.details.projectId,
                  service_account_email: fbStatus.details.serviceAccountEmail,
                  connected_by: fbStatus.details.userEmail,
                }
              : fbStatus.integration?.config
                ? {
                    project_id: fbStatus.integration.config['gcp_project_id'],
                    service_account_email: fbStatus.integration.config['service_account_email'],
                    connected_by: fbStatus.integration.config['connected_by'],
                  }
                : null,
          );
        } else {
          setFirebaseDetails(null);
        }
      } catch {
        setFirebaseDetails(null);
      }
    }

    setConnectedProviders({
      firebase: firebaseConnected,
      expo:
        hasConfiguredIntegration(organization.integrations, ['eas', 'expo']) ||
        hasConfiguredIntegration(projectIntegrations, ['eas', 'expo']),
      github:
        hasConfiguredIntegration(organization.integrations, ['github']) ||
        hasConfiguredIntegration(projectIntegrations, ['github']),
    });
  };
  const refreshIntegrationDependencyStatus = async (): Promise<void> => {
    if (!activeProjectId) {
      setIntegrationDependencyStatus({});
      return;
    }
    const payload = await api<{
      providers: IntegrationDependencyProviderStatus[];
    }>(`/api/projects/${encodeURIComponent(activeProjectId)}/integrations/dependencies`);
    const byProvider = Object.fromEntries(
      payload.providers.map((provider) => [provider.provider, provider]),
    );
    setIntegrationDependencyStatus(byProvider);
  };
  const handleConnect = async (providerId: ProviderId, fields: Record<string, string>): Promise<void> => {
    if (providerId === 'expo') {
      const token = fields['expoRobotToken']?.trim();
      if (!token) {
        throw new Error('Expo Robot Token is required.');
      }
      await api('/api/organization/integrations/eas/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      await refreshConnectedProviders();
      notify('Expo integration connected', 'ok');
      return;
    }
    if (providerId === 'github') {
      const token = fields['githubPat']?.trim();
      if (!token) {
        throw new Error('GitHub Personal Access Token is required.');
      }
      await api('/api/organization/integrations/github/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      await refreshConnectedProviders();
      notify('GitHub integration connected', 'ok');
      return;
    }
    if (providerId === 'firebase') {
      if (!activeProjectId) {
        throw new Error('Select a project first to configure Firebase.');
      }
      const saJson = fields['gcpServiceAccount']?.trim();
      if (!saJson) {
        throw new Error('Service Account JSON is required.');
      }
      await api(`/api/projects/${encodeURIComponent(activeProjectId)}/integrations/firebase/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serviceAccountJson: saJson }),
      });
      await refreshConnectedProviders();
      notify('Firebase integration connected via SA key', 'ok');
      return;
    }
    throw new Error(`${providerId} connect flow is not implemented yet.`);
  };

  const handleOAuthStart = async (
    providerId: ProviderId,
    onProgress: (progress: GcpOAuthSessionStatus) => void,
  ): Promise<void> => {
    if (providerId !== 'firebase') {
      throw new Error(`OAuth is not supported for ${providerId}.`);
    }
    if (!activeProjectId) {
      throw new Error('Select a project first to configure Firebase.');
    }

    const session = await api<{
      sessionId: string;
      authUrl: string;
      state: string;
      phase: 'awaiting_user';
    }>(
      `/api/projects/${encodeURIComponent(activeProjectId)}/oauth/gcp/start`,
      { method: 'POST' },
    );

    onProgress({ sessionId: session.sessionId, phase: session.phase, connected: false, steps: [] });
    window.open(session.authUrl, '_blank', 'noopener,noreferrer');

    const maxAttempts = 300;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const status = await api<GcpOAuthSessionStatus>(
        `/api/projects/${encodeURIComponent(activeProjectId)}/oauth/gcp/sessions/${encodeURIComponent(session.sessionId)}`,
      );
      onProgress(status);
      if (status.phase === 'completed' && status.connected) {
        await refreshConnectedProviders();
        notify('Firebase connected via Google OAuth', 'ok');
        return;
      }
      if (status.phase === 'failed' || status.phase === 'expired') {
        throw new Error(status.error ?? 'GCP OAuth session failed.');
      }
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }

    throw new Error('Timed out waiting for GCP OAuth provisioning to complete.');
  };
  const handleDisconnect = async (providerId: ProviderId): Promise<void> => {
    if (providerId === 'expo') {
      await api('/api/organization/integrations/eas/connection', {
        method: 'DELETE',
      });
      await refreshConnectedProviders();
      notify('Expo integration disconnected', 'ok');
      return;
    }
    if (providerId === 'github') {
      await api('/api/organization/integrations/github/connection', {
        method: 'DELETE',
      });
      await refreshConnectedProviders();
      notify('GitHub integration disconnected', 'ok');
      return;
    }
    if (providerId === 'firebase') {
      if (!activeProjectId) {
        throw new Error('Select a project first to disconnect Firebase.');
      }
      await api(`/api/projects/${encodeURIComponent(activeProjectId)}/integrations/firebase/connection`, {
        method: 'DELETE',
      });
      setFirebaseDetails(null);
      await refreshConnectedProviders();
      notify('Firebase/GCP integration disconnected', 'ok');
      return;
    }
    throw new Error(`${providerId} disconnect flow is not implemented yet.`);
  };
  const handleTriggerSetup = async (providerId: ProviderId): Promise<void> => {
    if (providerId === 'github') {
      // Backend endpoint: POST /api/projects/:id/integrations/github/init
      // When the endpoint exists, uncomment:
      // await api(`/api/projects/${encodeURIComponent(activeProjectId!)}/integrations/github/init`, { method: 'POST' });
      setGithubProjectInitialized(true);
      notify('GitHub repository initialized for project', 'ok');
      return;
    }
    if (providerId === 'expo') {
      // Backend endpoint: POST /api/projects/:id/integrations/expo/init
      // await api(`/api/projects/${encodeURIComponent(activeProjectId!)}/integrations/expo/init`, { method: 'POST' });
      setExpoProjectInitialized(true);
      notify('EAS application registered for project', 'ok');
      return;
    }
  };
  const isPluginConnected = (plugin: RegistryPlugin): boolean => {
    if (plugin.providerId === 'studio') return true;
    if (plugin.providerId === 'firebase') return connectedProviders.firebase;
    if (plugin.providerId === 'expo') return connectedProviders.expo;
    if (plugin.providerId === 'github') return connectedProviders.github;
    return false;
  };
  const getProviderConfig = (plugin: RegistryPlugin): IntegrationConfig | null => {
    if (plugin.providerId === 'firebase' || plugin.providerId === 'expo' || plugin.providerId === 'github') {
      return INTEGRATION_CONFIGS.find((c) => c.id === plugin.providerId) ?? null;
    }
    return null;
  };
  const activeIntegrationConfig = activeIntegration ? INTEGRATION_CONFIGS.find((c) => c.id === activeIntegration) ?? null : null;

  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark);
    localStorage.setItem('studio-theme', isDark ? 'dark' : 'light');
  }, [isDark]);

  useEffect(() => {
    const timer = setInterval(() => {
      api<{ websocket_connections: number }>('/api/health')
        .then((health) => {
          if (connections.size === 0) {
            setWsStatus(health.websocket_connections > 0 ? 'live' : 'offline');
          }
        })
        .catch(() => setWsStatus('error'));
    }, 20000);
    return () => clearInterval(timer);
  }, [connections.size]);

  useEffect(() => {
    void refreshProjects();
    // refreshProjects is intentionally invoked on initial mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void refreshConnectedProviders().catch((error: Error) => notify(error.message, 'error'));
    void refreshIntegrationDependencyStatus().catch((error: Error) => notify(error.message, 'error'));
    // refreshConnectedProviders should re-run only when selected project context changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId, projectDetail]);

  useEffect(() => {
    if (projectDetail) syncRunSockets(projectDetail);
  }, [projectDetail]);

  function notify(text: string, tone: 'ok' | 'error' = 'ok'): void {
    setToast({ text, tone });
    setTimeout(() => setToast(null), 2800);
  }

  async function refreshProjects(): Promise<void> {
    const payload = await api<{ projects: ProjectSummary[] }>('/api/projects');
    setProjects(payload.projects);
    if (!activeProjectId && payload.projects.length > 0) {
      setActiveProjectId(payload.projects[0].id);
      await refreshProjectDetail(payload.projects[0].id);
    }
    if (activeProjectId && !payload.projects.some((project) => project.id === activeProjectId)) {
      setActiveProjectId(null);
      setProjectDetail(null);
    }
  }

  async function refreshProjectDetail(projectId: string): Promise<void> {
    const detail = await api<ProjectDetail>(`/api/projects/${encodeURIComponent(projectId)}`);
    setProjectDetail(detail);
  }

  function syncRunSockets(detail: ProjectDetail): void {
    const runningIds = new Set(detail.provisioning.runs.filter((run) => run.status === 'running').map((run) => run.id));
    setConnections((prev) => {
      const next = new Map(prev);
      for (const [runId, ws] of next.entries()) {
        if (!runningIds.has(runId)) {
          ws.close();
          next.delete(runId);
        }
      }
      for (const runId of runningIds) {
        if (next.has(runId)) continue;
        const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
        const ws = new WebSocket(`${protocol}://${window.location.host}/ws/provisioning/${encodeURIComponent(runId)}`);
        setWsStatus('connecting');
        ws.onopen = () => setWsStatus('live');
        ws.onerror = () => setWsStatus('error');
        ws.onclose = () => {
          setConnections((old) => {
            const copy = new Map(old);
            copy.delete(runId);
            if (copy.size === 0) setWsStatus('offline');
            return copy;
          });
        };
        next.set(runId, ws);
      }
      return next;
    });
  }

  async function createProject(): Promise<void> {
    if (!createForm.name.trim()) throw new Error('Project name is required.');
    if (!createForm.slug.trim()) throw new Error('Project slug is required.');
    if (!isValidAppHostname(createForm.domain)) {
      throw new Error('Enter a valid app domain (e.g. app.example.com).');
    }
    const domain = createForm.domain.trim().toLowerCase();
    const bundleId = bundleIdFromAppDomain(domain);
    if (!bundleId) {
      throw new Error('Could not derive a bundle ID from that domain.');
    }
    const payload = await api<{ project: { id: string } }>('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: createForm.name.trim(),
        slug: createForm.slug.trim(),
        domain,
        bundleId,
        description: createForm.description.trim(),
        environments: createForm.environments,
        modules: createForm.modules,
      }),
    });
    setShowCreate(false);
    setCreateForm({
      name: '',
      slug: '',
      domain: '',
      description: '',
      environments: DEFAULT_ENVIRONMENTS,
      templateId: 'mobile-app',
      modules: DEFAULT_MODULE_IDS,
    });
    await refreshProjects();
    setActiveProjectId(payload.project.id);
    await refreshProjectDetail(payload.project.id);
    notify('Project created.');
  }

  async function deleteProject(): Promise<void> {
    if (!activeProjectId || !projectDetail) {
      throw new Error('Select a project first.');
    }
    const confirmed = window.confirm(
      `Delete project "${projectDetail.project.name}" (${projectDetail.project.id})?\n\nThis removes the Studio project record only. Infrastructure teardown is not included yet.`,
    );
    if (!confirmed) {
      return;
    }
    await api(`/api/projects/${encodeURIComponent(activeProjectId)}`, {
      method: 'DELETE',
    });
    setConnections((prev) => {
      const next = new Map(prev);
      for (const run of projectDetail.provisioning.runs) {
        const ws = next.get(run.id);
        if (ws) {
          ws.close();
          next.delete(run.id);
        }
      }
      if (next.size === 0) {
        setWsStatus('offline');
      }
      return next;
    });
    setActiveIntegration(null);
    setFirebaseDetails(null);
    setProjectDetail(null);
    setActiveProjectId(null);
    setView('overview');
    await refreshProjects();
    notify('Project deleted. Infrastructure teardown skipped.', 'ok');
  }

  const moduleCount = useMemo(() => Object.keys(projectDetail?.integrations || {}).length, [projectDetail]);
  const wsTone =
    wsStatus === 'live'
      ? 'bg-emerald-500'
      : wsStatus === 'connecting'
        ? 'bg-amber-400'
        : wsStatus === 'error'
          ? 'bg-red-500'
          : 'bg-slate-400';

  return (
    <div className={`flex h-screen w-screen overflow-hidden ${isDark ? 'dark' : ''}`}>
      <div className="flex h-full w-full bg-background text-foreground overflow-hidden">
        <Sidebar
          projects={projects}
          activeProjectId={activeProjectId}
          view={view}
          onShowCreate={() => setShowCreate(true)}
          onViewChange={setView}
          onSelectProject={(projectId) => {
            setActiveProjectId(projectId);
            setView('project');
            void refreshProjectDetail(projectId);
          }}
        />

        <main className="flex-1 overflow-y-auto bg-muted/20">
          <MainHeader
            title={view === 'registry' ? 'Plugin Registry' : view === 'overview' ? 'Organization' : projectDetail?.project.name || 'Studio Core'}
            subtitle={
              view === 'registry'
                ? `${ALL_REGISTRY_PLUGINS.length} plugins across ${REGISTRY_CATEGORIES.length} categories`
                : view === 'overview'
                  ? 'Manage projects and infrastructure across the organization'
                  : projectDetail
                    ? `${projectDetail.project.slug}${
                        projectDetail.project.domain ? ` · ${projectDetail.project.domain}` : ''
                      } · updated ${formatDate(projectDetail.project.updatedAt)}`
                    : 'Select a project to continue'
            }
            isDark={isDark}
            wsStatus={wsStatus}
            wsTone={wsTone}
            onToggleDark={() => setIsDark((value) => !value)}
          />

          <div className="p-6 space-y-4">
            {view === 'overview' && (
              <OrgOverview
                projects={projects}
                onSelectProject={(id) => {
                  setActiveProjectId(id);
                  setView('project');
                  void refreshProjectDetail(id);
                }}
                connectedProviders={connectedProviders}
                onOpenIntegration={setActiveIntegration}
                wsStatus={wsStatus}
                totalModulesConfigured={projects.reduce((acc, p) => acc + p.integration_progress.configured, 0)}
              />
            )}

            {(view === 'project' || view === 'project-providers' || view === 'infrastructure' || view === 'runs') && projectDetail && (
              <ProjectDetailView
                projectDetail={projectDetail}
                projectTab={
                  view === 'infrastructure'
                    ? 'infrastructure'
                    : view === 'runs'
                      ? 'deployments'
                      : view === 'project-providers'
                        ? 'providers'
                        : 'overview'
                }
                onProjectTabChange={(tab) => {
                  if (tab === 'overview') setView('project');
                  else if (tab === 'providers') setView('project-providers');
                  else if (tab === 'infrastructure') setView('infrastructure');
                  else setView('runs');
                }}
                connectedProviders={connectedProviders}
                firebaseConnectionDetails={firebaseDetails}
                githubProjectInitialized={githubProjectInitialized}
                expoProjectInitialized={expoProjectInitialized}
                onProjectConnect={handleConnect}
                onProjectOAuthStart={handleOAuthStart}
                onProjectTriggerSetup={handleTriggerSetup}
                onProjectDisconnect={handleDisconnect}
                integrationDependencyStatus={integrationDependencyStatus}
                onProjectProvidersRefresh={async () => {
                  await refreshConnectedProviders();
                  await refreshIntegrationDependencyStatus();
                }}
                onDeleteProject={() => {
                  void deleteProject().catch((error: Error) => notify(error.message, 'error'));
                }}
                projectPlugins={(() => {
                  const int = projectDetail.integrations || {};
                  const keys = Object.keys(int);
                  const pluginIds: string[] = [];
                  for (const k of keys) {
                    if (k === 'firebase') pluginIds.push(...PROVIDER_PLUGIN_MAP.firebase);
                    else if (k === 'expo') pluginIds.push(...PROVIDER_PLUGIN_MAP.expo);
                    else if (k === 'github') pluginIds.push(...PROVIDER_PLUGIN_MAP.github);
                    else pluginIds.push(k);
                  }
                  return pluginIds;
                })()}
              />
            )}

            {view === 'registry' && (
              <RegistryView
                connectedProviders={connectedProviders}
                activeProjectId={activeProjectId}
                onOpenIntegration={setActiveIntegration}
              />
            )}
          </div>
        </main>

        <CreateProjectModal
          show={showCreate}
          form={createForm}
          onClose={() => setShowCreate(false)}
          onChange={(next: CreateProjectForm) => {
            const nameChanged = next.name !== createForm.name;
            const slugChangedByUser = next.slug !== createForm.slug;
            const domainNorm = next.domain.trim().toLowerCase();

            const prevAutoSlug = slugify(createForm.name);
            const slugWasAuto = createForm.slug === prevAutoSlug || createForm.slug === '';

            let slug: string;
            if (slugChangedByUser) {
              slug = slugify(next.slug);
            } else if (nameChanged && slugWasAuto) {
              slug = slugify(next.name);
            } else {
              slug = next.slug;
            }

            setCreateForm({ ...next, slug, domain: domainNorm });
          }}
          onCreate={() => void createProject().catch((error: Error) => notify(error.message, 'error'))}
        />

        {toast && <Toast text={toast.text} tone={toast.tone} />}

        <AnimatePresence>
          {activeIntegration && activeIntegrationConfig && activeIntegration !== 'firebase' && (
            <IntegrationModal
              key={activeIntegration}
              config={activeIntegrationConfig}
              isConnected={connectedProviders[activeIntegration]}
              connectionDetails={null}
              dependencyStatus={integrationDependencyStatus[providerToBackendKey(activeIntegration)]}
              onClose={() => setActiveIntegration(null)}
              onConnect={async (providerId, fields) => {
                await handleConnect(providerId, fields);
              }}
              onOAuthStart={async (providerId, onProgress) => {
                await handleOAuthStart(providerId, onProgress);
              }}
              onDisconnect={async (providerId) => {
                await handleDisconnect(providerId);
              }}
            />
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
