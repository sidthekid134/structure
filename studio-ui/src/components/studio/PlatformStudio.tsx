import { AlertTriangle } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { AnimatePresence } from 'framer-motion';
import { useIntegrationCatalog } from './useIntegrationCatalog';
import { usePluginCatalog } from './usePluginCatalog';
import { api, authedWebSocket, bundleIdFromAppDomain, formatDate, isValidAppHostname, providerToBackendKey, slugify } from './helpers';
import {
  CreateProjectModal,
  DEFAULT_ENVIRONMENTS,
  DEFAULT_MODULE_IDS,
  DEFAULT_PLATFORMS,
  type CreateProjectForm,
} from './CreateProjectModal';
import { AppleIntegrationFlow } from './AppleIntegrationFlow';
import { CloudflareIntegrationFlow } from './CloudflareIntegrationFlow';
import { IntegrationModal } from './IntegrationModal';
import { MainHeader } from './MainHeader';
import { OrgOverview } from './OrgOverview';
import { ProjectDetailView, type ProjectSubtab } from './ProjectDetailView';
import { ProjectMigrationImportModal } from './ProjectMigrationImportModal';
import { PasskeyAuthGate } from './PasskeyAuthGate';
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
  InstanceVaultSyncStatus,
  OrganizationProfile,
  ProjectDetail,
  ProjectSummary,
  ProjectMigrationBundle,
  ProviderId,
  RegistryPlugin,
  StudioView,
} from './types';

const DEFAULT_PROJECT_SUBTAB: ProjectSubtab = 'modules';
const PROJECT_SUBTABS: readonly ProjectSubtab[] = ['modules', 'setup', 'dashboard', 'settings'];
const PROJECT_SCOPED_VIEWS: readonly StudioView[] = [
  'project',
  'project-setup',
  'project-modules',
  'project-dashboard',
  'project-settings',
  'project-providers',
  'runs',
  'infrastructure',
];

const isProjectSubtab = (value: string | null | undefined): value is ProjectSubtab =>
  typeof value === 'string' && PROJECT_SUBTABS.includes(value as ProjectSubtab);

const parseStudioHashRoute = (
  hash: string,
): { view: StudioView; activeProjectId: string | null; projectSubtab: ProjectSubtab } => {
  const cleaned = hash.startsWith('#') ? hash.slice(1) : hash;
  const [section, projectIdRaw, projectSubtabRaw] = cleaned
    .split('/')
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));

  if (section === 'registry') {
    return { view: 'registry', activeProjectId: null, projectSubtab: DEFAULT_PROJECT_SUBTAB };
  }

  if (section === 'project' && projectIdRaw) {
    return {
      view: 'project',
      activeProjectId: projectIdRaw,
      projectSubtab: isProjectSubtab(projectSubtabRaw) ? projectSubtabRaw : DEFAULT_PROJECT_SUBTAB,
    };
  }

  return { view: 'overview', activeProjectId: null, projectSubtab: DEFAULT_PROJECT_SUBTAB };
};

const buildStudioHashRoute = (view: StudioView, activeProjectId: string | null, projectSubtab: ProjectSubtab): string => {
  if (view === 'registry') {
    return '#/registry';
  }
  if (PROJECT_SCOPED_VIEWS.includes(view) && activeProjectId) {
    return `#/project/${encodeURIComponent(activeProjectId)}/${projectSubtab}`;
  }
  return '#/overview';
};

const PASSKEY_TEST_STORAGE_KEY = 'studio:test-passkey';

/**
 * The daemon mints an HttpOnly session via CLI handoff (`#handoff=…`) or,
 * on loopback only, `POST /api/auth/dev-session` so reloading the tab does
 * not require passkey sign-in. Use `?passkey=1` to exercise real WebAuthn instead.
 */
function syncPasskeyTestPreferenceFromUrl(): {
  exercisePasskey: boolean;
  /** True only when `?passkey=1` was just applied — caller should drop dev session cookie once. */
  logoutDevSessionOnce: boolean;
} {
  try {
    const url = new URL(window.location.href);
    const p = url.searchParams.get('passkey');
    if (p === '1') {
      sessionStorage.setItem(PASSKEY_TEST_STORAGE_KEY, '1');
      url.searchParams.delete('passkey');
      window.history.replaceState(null, '', url.pathname + url.search + url.hash);
      return { exercisePasskey: true, logoutDevSessionOnce: true };
    }
    if (p === '0') {
      sessionStorage.removeItem(PASSKEY_TEST_STORAGE_KEY);
      url.searchParams.delete('passkey');
      window.history.replaceState(null, '', url.pathname + url.search + url.hash);
      return { exercisePasskey: false, logoutDevSessionOnce: false };
    }
    const exercisePasskey = sessionStorage.getItem(PASSKEY_TEST_STORAGE_KEY) === '1';
    return { exercisePasskey, logoutDevSessionOnce: false };
  } catch {
    return { exercisePasskey: false, logoutDevSessionOnce: false };
  }
}

type AuthBarrierState =
  | 'loading'
  | 'none'
  | 'register'
  | 'passkey'
  | 'vaultUnlock'
  | 'vaultIncompatible';

async function refreshAuthBarrierState(
  setAuthBarrier: Dispatch<SetStateAction<AuthBarrierState>>,
  setVaultIncompatibleMessage: Dispatch<SetStateAction<string | null>>,
): Promise<'none' | 'register' | 'passkey' | 'vaultUnlock' | 'vaultIncompatible'> {
  try {
    const ver = (await fetch('/api/version', { credentials: 'include' }).then((r) => r.json())) as {
      needsRegistration?: boolean;
      needsVaultKeySetup?: boolean;
      hasCredentials?: boolean;
      canDecryptVault?: boolean;
    };
    const canDecryptVault = Boolean(ver.canDecryptVault ?? ver.hasCredentials);
    const needsVaultKeySetup = Boolean(ver.needsVaultKeySetup ?? ver.needsRegistration ?? !canDecryptVault);
    const sess = (await fetch('/api/auth/session', { credentials: 'include' }).then((r) => r.json())) as {
      authenticated?: boolean;
    };

    // Loopback dev-session can be "authenticated" without vault crypto material — still require
    // first-time vault setup before treating the session as signed-in for vault access.
    if (sess.authenticated && needsVaultKeySetup) {
      setVaultIncompatibleMessage(null);
      setAuthBarrier('register');
      return 'register';
    }

    if (sess.authenticated) {
      try {
        const vaultRes = await fetch('/api/vault/status', { credentials: 'include' });
        if (!vaultRes.ok) {
          const body = (await vaultRes.json().catch(() => ({}))) as { error?: string; code?: string };
          if (vaultRes.status === 503 || body.code === 'VAULT_LAYOUT_UNSUPPORTED') {
            setVaultIncompatibleMessage(
              body.error ?? 'This Studio data directory is not compatible with this version.',
            );
            setAuthBarrier('vaultIncompatible');
            return 'vaultIncompatible';
          }
        } else {
          const vault = (await vaultRes.json()) as {
            sealed?: boolean;
            vaultKeyMode?: string;
          };
          // Any dek-v1 sealed session needs passkey unlock — do not require vaultExists (path checks
          // can disagree with the vault file on disk during migration or partial state).
          if (vault.vaultKeyMode === 'dek-v1' && vault.sealed) {
            setVaultIncompatibleMessage(null);
            setAuthBarrier('vaultUnlock');
            return 'vaultUnlock';
          }
        }
      } catch {
        /* ignore */
      }
      setVaultIncompatibleMessage(null);
      setAuthBarrier('none');
      return 'none';
    }
    if (canDecryptVault) {
      setVaultIncompatibleMessage(null);
      setAuthBarrier('passkey');
      return 'passkey';
    }
    if (needsVaultKeySetup) {
      setVaultIncompatibleMessage(null);
      setAuthBarrier('register');
      return 'register';
    }
    setVaultIncompatibleMessage(null);
    setAuthBarrier('none');
    return 'none';
  } catch {
    setVaultIncompatibleMessage(null);
    setAuthBarrier('none');
    return 'none';
  }
}

export default function PlatformStudio() {
  const initialRoute = useMemo(() => parseStudioHashRoute(window.location.hash), []);
  const [isDark, setIsDark] = useState(() => {
    const stored = localStorage.getItem('studio-theme');
    if (stored !== null) return stored === 'dark';
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  });
  const [view, setView] = useState<StudioView>(initialRoute.view);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(initialRoute.activeProjectId);
  const [projectSubtab, setProjectSubtab] = useState<ProjectSubtab>(initialRoute.projectSubtab);

  const [projectDetail, setProjectDetail] = useState<ProjectDetail | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showMigrationImport, setShowMigrationImport] = useState(false);
  const [authBarrier, setAuthBarrier] = useState<AuthBarrierState>('loading');
  const [vaultIncompatibleMessage, setVaultIncompatibleMessage] = useState<string | null>(null);
  const [apiBootstrapDone, setApiBootstrapDone] = useState(false);
  const [isMigrationImporting, setIsMigrationImporting] = useState(false);
  const [wsStatus, setWsStatus] = useState<'offline' | 'connecting' | 'live' | 'error'>('offline');
  const [toast, setToast] = useState<{ text: string; tone: 'ok' | 'error' } | null>(null);
  const [createForm, setCreateForm] = useState<CreateProjectForm>({
    name: '',
    slug: '',
    domain: '',
    description: '',
    environments: DEFAULT_ENVIRONMENTS,
    platforms: DEFAULT_PLATFORMS,
    templateId: 'mobile-app',
    modules: DEFAULT_MODULE_IDS,
  });
  const [connections, setConnections] = useState<Map<string, WebSocket>>(new Map());
  const [connectedProviders, setConnectedProviders] = useState<ConnectedProviders>({
    firebase: false,
    expo: false,
    github: false,
    apple: false,
    cloudflare: false,
  });
  const [activeIntegration, setActiveIntegration] = useState<ProviderId | null>(null);
  const { catalog: pluginCatalog } = usePluginCatalog(apiBootstrapDone);
  const integrationConfigs = useIntegrationCatalog();
  const [firebaseDetails, setFirebaseDetails] = useState<FirebaseConnectionDetails | null>(null);
  const [appleDetails, setAppleDetails] = useState<{
    team_id?: string;
    asc_issuer_id?: string;
    asc_api_key_id?: string;
  } | null>(null);
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
  useEffect(() => {
    const onVaultSealed = () => {
      void refreshAuthBarrierState(setAuthBarrier, setVaultIncompatibleMessage);
    };
    window.addEventListener('studio:vault-sealed', onVaultSealed);
    return () => window.removeEventListener('studio:vault-sealed', onVaultSealed);
  }, []);

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
      apple:
        hasConfiguredIntegration(organization.integrations, ['apple']) ||
        hasConfiguredIntegration(projectIntegrations, ['apple']),
      cloudflare:
        hasConfiguredIntegration(organization.integrations, ['cloudflare']) ||
        hasConfiguredIntegration(projectIntegrations, ['cloudflare']),
    });

    const appleRecord = organization.integrations?.['apple'] as IntegrationStatusRecord | undefined;
    if (appleRecord && appleRecord.status === 'configured' && appleRecord.config) {
      setAppleDetails({
        team_id: appleRecord.config['team_id'],
        asc_issuer_id: appleRecord.config['asc_issuer_id'],
        asc_api_key_id: appleRecord.config['asc_api_key_id'],
      });
    } else {
      setAppleDetails(null);
    }
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
    if (providerId === 'apple') {
      const teamId = fields['appleTeamId']?.trim();
      const ascIssuerId = fields['ascIssuerId']?.trim();
      const ascApiKeyId = fields['ascApiKeyId']?.trim();
      const ascApiKeyP8 = fields['ascApiKeyP8']?.trim();
      if (!teamId || !ascIssuerId || !ascApiKeyId || !ascApiKeyP8) {
        throw new Error(
          'Apple connect requires Team ID, App Store Connect Issuer ID, Key ID, and .p8 contents.',
        );
      }
      await api<{ ascCredentials: 'stored_in_vault' }>(
        '/api/organization/integrations/apple/connect',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ teamId, ascIssuerId, ascApiKeyId, ascApiKeyP8 }),
        },
      );
      await refreshConnectedProviders();
      notify('Apple connected — Team ID + ASC Team Key stored. Automated provisioning enabled.', 'ok');
      return;
    }
    if (providerId === 'cloudflare') {
      const token = fields['cloudflareApiToken']?.trim();
      if (!token) {
        throw new Error('Cloudflare API token is required.');
      }
      await api('/api/organization/integrations/cloudflare/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      await refreshConnectedProviders();
      notify('Cloudflare integration connected', 'ok');
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
    if (providerId === 'apple') {
      await api('/api/organization/integrations/apple', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'pending',
          notes: '',
          config: {},
          replaceConfig: true,
        }),
      });
      await refreshConnectedProviders();
      notify('Apple integration disconnected', 'ok');
      return;
    }
    if (providerId === 'cloudflare') {
      await api('/api/organization/integrations/cloudflare/connection', {
        method: 'DELETE',
      });
      await refreshConnectedProviders();
      notify('Cloudflare integration disconnected', 'ok');
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
    if (plugin.providerId === 'apple') return connectedProviders.apple;
    if (plugin.providerId === 'cloudflare') return connectedProviders.cloudflare;
    return false;
  };
  const getProviderConfig = (plugin: RegistryPlugin): IntegrationConfig | null => {
    if (
      plugin.providerId === 'firebase' ||
      plugin.providerId === 'expo' ||
      plugin.providerId === 'github' ||
      plugin.providerId === 'apple' ||
      plugin.providerId === 'cloudflare'
    ) {
      return integrationConfigs?.find((c) => c.id === plugin.providerId) ?? null;
    }
    return null;
  };
  const activeIntegrationConfig = activeIntegration ? (integrationConfigs?.find((c) => c.id === activeIntegration) ?? null) : null;
  const navigateStudio = useCallback(
    (next: {
      view?: StudioView;
      activeProjectId?: string | null;
      projectSubtab?: ProjectSubtab;
      replaceHistory?: boolean;
    }) => {
      const nextView = next.view ?? view;
      const nextProjectId = next.activeProjectId === undefined ? activeProjectId : next.activeProjectId;
      const nextProjectSubtab = next.projectSubtab ?? projectSubtab;

      setView(nextView);
      setActiveProjectId(nextProjectId);
      setProjectSubtab(nextProjectSubtab);

      const nextHash = buildStudioHashRoute(nextView, nextProjectId, nextProjectSubtab);
      if (window.location.hash !== nextHash) {
        if (next.replaceHistory) {
          window.history.replaceState(null, '', nextHash);
        } else {
          window.history.pushState(null, '', nextHash);
        }
      }
    },
    [activeProjectId, projectSubtab, view],
  );

  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark);
    localStorage.setItem('studio-theme', isDark ? 'dark' : 'light');
  }, [isDark]);

  useEffect(() => {
    const expectedHash = buildStudioHashRoute(view, activeProjectId, projectSubtab);
    if (window.location.hash !== expectedHash) {
      window.history.replaceState(null, '', expectedHash);
    }
  }, [activeProjectId, projectSubtab, view]);

  useEffect(() => {
    const onHashChange = () => {
      const route = parseStudioHashRoute(window.location.hash);
      setView(route.view);
      setActiveProjectId(route.activeProjectId);
      setProjectSubtab(route.projectSubtab);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

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
    void refreshConnectedProviders().catch((error: Error) => notify(error.message, 'error'));
    void refreshIntegrationDependencyStatus().catch((error: Error) => notify(error.message, 'error'));
    // refreshConnectedProviders should re-run only when selected project context changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId, projectDetail]);

  useEffect(() => {
    if (projectDetail) syncRunSockets(projectDetail);
  }, [projectDetail]);

  useEffect(() => {
    if (!activeProjectId) {
      setProjectDetail(null);
      return;
    }
    void refreshProjectDetail(activeProjectId).catch((error: Error) => notify(error.message, 'error'));
  }, [activeProjectId]);

  useEffect(() => {
    void (async () => {
      const hash = window.location.hash;
      const m = /handoff=([^&]+)/.exec(hash);
      if (m) {
        const tok = decodeURIComponent(m[1]!);
        await fetch('/api/auth/handoff', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: tok }),
        });
        const cleaned = hash
          .replace(/[&?]handoff=[^&]*/, '')
          .replace(/^#[&?]/, '#')
          .replace(/^#$/, '');
        window.history.replaceState(
          null,
          '',
          window.location.pathname + window.location.search + (cleaned === '#' ? '' : cleaned),
        );
      } else {
        // `vite build --watch` (dev:full) sets import.meta.env.PROD — do not key off Vite's DEV flag.
        const { exercisePasskey, logoutDevSessionOnce } = syncPasskeyTestPreferenceFromUrl();
        if (logoutDevSessionOnce) {
          await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }).catch(() => {});
        }
        if (!exercisePasskey) {
          try {
            await fetch('/api/auth/dev-session', { method: 'POST', credentials: 'include' });
          } catch {
            /* ignore — barrier refresh still decides auth state */
          }
        }
      }
      const gate = await refreshAuthBarrierState(setAuthBarrier, setVaultIncompatibleMessage);
      if (gate === 'none') {
        await refreshProjects().catch((error: Error) => notify(error.message, 'error'));
      }
    })()
      .catch(() => {
        setVaultIncompatibleMessage(null);
        setAuthBarrier('none');
      })
      .finally(() => {
        setApiBootstrapDone(true);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onNeedAuth = (): void => {
      void refreshAuthBarrierState(setAuthBarrier, setVaultIncompatibleMessage).then((gate) => {
        if (gate === 'none') {
          void refreshProjects().catch((error: Error) => notify(error.message, 'error'));
        }
      });
    };
    window.addEventListener('studio:need-auth', onNeedAuth);
    return () => window.removeEventListener('studio:need-auth', onNeedAuth);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function notify(text: string, tone: 'ok' | 'error' = 'ok'): void {
    setToast({ text, tone });
    setTimeout(() => setToast(null), 2800);
  }

  async function refreshProjects(): Promise<void> {
    const payload = await api<{ projects: ProjectSummary[] }>('/api/projects');
    setProjects(payload.projects);
    if (!activeProjectId && payload.projects.length > 0) {
      navigateStudio({
        view: 'project',
        activeProjectId: payload.projects[0].id,
        projectSubtab: DEFAULT_PROJECT_SUBTAB,
        replaceHistory: true,
      });
    }
    if (activeProjectId && !payload.projects.some((project) => project.id === activeProjectId)) {
      setActiveProjectId(null);
      setProjectDetail(null);
      setProjectSubtab(DEFAULT_PROJECT_SUBTAB);
      setView('overview');
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
        setWsStatus('connecting');
        // Async: resolve token, then connect. We optimistically reserve the
        // map slot by using a sentinel WebSocket that gets replaced once the
        // real one is constructed. If that races, the cleanup loop above
        // handles it on the next plan refresh.
        void authedWebSocket(`/ws/provisioning/${encodeURIComponent(runId)}`).then((ws) => {
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
          setConnections((old) => {
            const copy = new Map(old);
            copy.set(runId, ws);
            return copy;
          });
        }).catch(() => {
          setWsStatus('error');
        });
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
        platforms: createForm.platforms,
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
      platforms: DEFAULT_PLATFORMS,
      templateId: 'mobile-app',
      modules: DEFAULT_MODULE_IDS,
    });
    await refreshProjects();
    navigateStudio({
      view: 'project',
      activeProjectId: payload.project.id,
      projectSubtab: DEFAULT_PROJECT_SUBTAB,
    });
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
    setProjectSubtab(DEFAULT_PROJECT_SUBTAB);
    setView('overview');
    await refreshProjects();
    notify('Project deleted. Infrastructure teardown skipped.', 'ok');
  }

  async function importProjectMigration(bundle: ProjectMigrationBundle, passphrase?: string): Promise<void> {
    setIsMigrationImporting(true);
    try {
      const result = await api<{
        projectId: string;
        projectName: string;
        importedRuns: number;
        instanceVaultSync?: InstanceVaultSyncStatus;
      }>('/api/projects/migration/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bundle, passphrase }),
      });
      await refreshProjects();
      await refreshProjectDetail(result.projectId);
      navigateStudio({
        view: 'project',
        activeProjectId: result.projectId,
        projectSubtab: DEFAULT_PROJECT_SUBTAB,
      });
      setShowMigrationImport(false);
      notify(`Imported ${result.projectName} (${result.importedRuns} runs).`, 'ok');
      if (result.instanceVaultSync?.pending) {
        notify(
          result.instanceVaultSync.vaultSealed
            ? 'Unlock the vault to review imported GitHub / Expo / Apple credentials for this project.'
            : 'This import includes organization credentials that differ from this Studio — open the project banner to sync or dismiss.',
          'ok',
        );
      }
    } finally {
      setIsMigrationImporting(false);
    }
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
      {authBarrier === 'loading' ? (
        <div className="fixed inset-0 z-[68] bg-background/90 flex items-center justify-center text-sm text-muted-foreground">
          Checking session…
        </div>
      ) : null}
      {authBarrier === 'vaultIncompatible' ? (
        <div className="fixed inset-0 z-[69] bg-background/95 flex items-center justify-center p-8">
          <div className="max-w-lg rounded-2xl border border-destructive/30 bg-card p-6 shadow-xl space-y-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-6 h-6 text-destructive shrink-0 mt-0.5" />
              <div className="space-y-2">
                <h2 className="text-lg font-semibold">Studio data needs reset</h2>
                <p className="text-sm text-muted-foreground whitespace-pre-wrap">
                  {vaultIncompatibleMessage ??
                    'This install’s encrypted store is not compatible with the current passkey-only vault model.'}
                </p>
                <p className="text-xs text-muted-foreground">
                  From the repo root, run <code className="rounded bg-muted px-1.5 py-0.5">npm run reset:data</code> to
                  wipe local Studio data, then restart the daemon and register a passkey again.
                </p>
              </div>
            </div>
          </div>
        </div>
      ) : null}
      {(authBarrier === 'register' || authBarrier === 'passkey' || authBarrier === 'vaultUnlock') && (
        <PasskeyAuthGate
          mode={authBarrier === 'register' ? 'register' : 'unlock'}
          lockReason={authBarrier === 'vaultUnlock' ? 'vault-sealed' : 'default'}
          allowAlternateFlow={authBarrier !== 'vaultUnlock'}
          onInstallReset={() => {
            void refreshAuthBarrierState(setAuthBarrier, setVaultIncompatibleMessage);
          }}
          onComplete={() => {
            setVaultIncompatibleMessage(null);
            setAuthBarrier('none');
            void refreshProjects().catch((error: Error) => notify(error.message, 'error'));
          }}
        />
      )}
      <div className="flex h-full w-full bg-background text-foreground overflow-hidden">
        <Sidebar
          projects={projects}
          activeProjectId={activeProjectId}
          view={view}
          onShowCreate={() => setShowCreate(true)}
          onShowImport={() => setShowMigrationImport(true)}
          onViewChange={(nextView) => navigateStudio({ view: nextView })}
          onSelectProject={(projectId) => {
            navigateStudio({
              view: 'project',
              activeProjectId: projectId,
            });
          }}
        />

        <main className="flex-1 overflow-y-auto bg-muted/20">
          <MainHeader
            title={view === 'registry' ? 'Plugin Registry' : view === 'overview' ? 'Organization' : projectDetail?.project.name || 'Studio Pro'}
            subtitle={
              view === 'registry'
                ? pluginCatalog
                  ? `${pluginCatalog.plugins.length} plugins across ${pluginCatalog.categories.length} categories`
                  : 'Loading plugin catalog…'
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
                  navigateStudio({
                    view: 'project',
                    activeProjectId: id,
                  });
                }}
                connectedProviders={connectedProviders}
                onOpenIntegration={setActiveIntegration}
                wsStatus={wsStatus}
                totalModulesConfigured={projects.reduce((acc, p) => acc + p.integration_progress.configured, 0)}
              />
            )}

            {view === 'project' && projectDetail && (
              <ProjectDetailView
                projectDetail={projectDetail}
                projectTab={projectSubtab}
                onProjectTabChange={(tab) => {
                  navigateStudio({
                    view: 'project',
                    activeProjectId: activeProjectId ?? projectDetail.project.id,
                    projectSubtab: tab,
                  });
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
                onRefreshProjectDetail={async () => {
                  if (activeProjectId) {
                    await refreshProjectDetail(activeProjectId);
                  }
                }}
                projectPlugins={(() => {
                  const int = projectDetail.integrations || {};
                  const keys = Object.keys(int);
                  const pluginIds: string[] = [];
                  // Resolve provider keys against the live catalog when it
                  // has loaded; fall back to the literal key otherwise so
                  // the UI never blocks on the catalog fetch.
                  const providerMap = pluginCatalog?.providerPluginMap ?? {};
                  for (const k of keys) {
                    const mapped = providerMap[k];
                    if (mapped && mapped.length > 0) pluginIds.push(...mapped);
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
                onOpenProjectPlugin={(pluginId) => {
                  // Plugin id → matching project subtab. LLM plugins now route
                  // to Setup where their credential gates run.
                  const subtab: ProjectSubtab | null = pluginId.startsWith('llm-') ? 'setup' : null;
                  if (!subtab || !activeProjectId) return false;
                  navigateStudio({
                    view: 'project',
                    activeProjectId,
                    projectSubtab: subtab,
                  });
                  return true;
                }}
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

        <ProjectMigrationImportModal
          show={showMigrationImport}
          isImporting={isMigrationImporting}
          onClose={() => setShowMigrationImport(false)}
          onImport={importProjectMigration}
        />

        {toast && <Toast text={toast.text} tone={toast.tone} />}

        <AnimatePresence>
          {activeIntegration === 'apple' && (
            <AppleIntegrationFlow
              key="apple-flow"
              isConnected={connectedProviders.apple}
              connectionDetails={appleDetails}
              onClose={() => setActiveIntegration(null)}
              onConnect={async (fields) => {
                await handleConnect('apple', fields);
              }}
              onDisconnect={async () => {
                await handleDisconnect('apple');
              }}
            />
          )}
          {activeIntegration === 'cloudflare' && (
            <CloudflareIntegrationFlow
              key="cloudflare-flow"
              isConnected={connectedProviders.cloudflare}
              onClose={() => setActiveIntegration(null)}
              onConnect={async (fields) => {
                await handleConnect('cloudflare', fields);
              }}
              onDisconnect={async () => {
                await handleDisconnect('cloudflare');
              }}
            />
          )}
          {activeIntegration && activeIntegrationConfig && activeIntegration !== 'firebase' && activeIntegration !== 'apple' && activeIntegration !== 'cloudflare' && (
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
