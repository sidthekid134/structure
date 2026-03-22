import { AnimatePresence, motion } from 'framer-motion';
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Circle,
  Code2,
  Copy,
  ExternalLink,
  GitBranch,
  Github,
  Loader2,
  Package,
  Play,
  Plug,
  RefreshCw,
  RotateCcw,
  Server,
  Trash2,
  Zap,
} from 'lucide-react';
import {
  ALL_REGISTRY_PLUGINS,
  DEPLOY_STATUS_CONFIG,
  LOG_LEVEL_STYLES,
  MOCK_LOGS,
  OVERVIEW_STATS,
  SERVICE_HEALTH_DATA,
} from './constants';
import { formatDate } from './helpers';
import { InfrastructureTab } from './InfrastructureTab';
import { ProjectProvidersTab } from './ProjectProvidersTab';
import type {
  ConnectedProviders,
  DeploymentRecord,
  FirebaseConnectionDetails,
  GcpOAuthSessionStatus,
  IntegrationDependencyProviderStatus,
  ProjectDetail,
  ProviderId,
} from './types';

export function ProjectDetailView({
  projectDetail,
  projectTab,
  onProjectTabChange,
  connectedProviders,
  projectPlugins,
  onDeleteProject,
  firebaseConnectionDetails,
  githubProjectInitialized,
  expoProjectInitialized,
  integrationDependencyStatus,
  onProjectConnect,
  onProjectOAuthStart,
  onProjectTriggerSetup,
  onProjectDisconnect,
  onProjectProvidersRefresh,
}: {
  projectDetail: ProjectDetail;
  projectTab: 'overview' | 'infrastructure' | 'deployments' | 'providers';
  onProjectTabChange: (tab: 'overview' | 'infrastructure' | 'deployments' | 'providers') => void;
  connectedProviders: ConnectedProviders;
  projectPlugins: string[];
  onDeleteProject: () => void;
  firebaseConnectionDetails: FirebaseConnectionDetails | null;
  githubProjectInitialized: boolean;
  expoProjectInitialized: boolean;
  integrationDependencyStatus: Record<string, IntegrationDependencyProviderStatus>;
  onProjectConnect: (providerId: ProviderId, fields: Record<string, string>) => Promise<void>;
  onProjectOAuthStart: (providerId: ProviderId, onProgress: (progress: GcpOAuthSessionStatus) => void) => Promise<void>;
  onProjectTriggerSetup: (providerId: ProviderId) => Promise<void>;
  onProjectDisconnect: (providerId: ProviderId) => Promise<void>;
  onProjectProvidersRefresh: () => void | Promise<void>;
}) {
  const { project, provisioning } = projectDetail;
  // Only show org-scoped integrations (providers with automatic org availability are excluded)
  const activePluginDetails = projectPlugins.map((pid) => {
    const regPlugin = ALL_REGISTRY_PLUGINS.find((p) => p.id === pid);
    const health = SERVICE_HEALTH_DATA.find((s) => s.name.toLowerCase().includes(pid.split('-')[0]));
    return {
      id: pid,
      name: regPlugin?.name ?? pid,
      provider: regPlugin?.provider ?? '—',
      health,
    };
  });
  const runs = provisioning.runs;
  const apiDeployments: DeploymentRecord[] = runs.map((r) => ({
    id: r.id,
    version: '1.0',
    branch: 'main',
    commit: r.id.slice(0, 7),
    triggeredBy: 'system',
    status: (r.status === 'success' ? 'success' : r.status === 'running' ? 'running' : 'failed') as 'success' | 'failed' | 'running' | 'queued',
    platform: 'both' as const,
    createdAt: r.created_at,
    duration: undefined as string | undefined,
  }));
  const mockDeployments: DeploymentRecord[] = [
    { id: 'd1', version: '1.4.2', branch: 'main', commit: 'a3f9c12', triggeredBy: 'studio@acme.co', status: 'success', platform: 'both', createdAt: project.updatedAt, duration: '4m 12s' },
    { id: 'd2', version: '1.4.1', branch: 'main', commit: 'b7e2a88', triggeredBy: 'studio@acme.co', status: 'success', platform: 'ios', createdAt: project.updatedAt, duration: '3m 58s' },
    { id: 'd3', version: '1.4.1', branch: 'fix/auth', commit: 'c1d5f44', triggeredBy: 'studio@acme.co', status: 'failed', platform: 'android', createdAt: project.updatedAt, duration: '1m 33s' },
    { id: 'd4', version: '1.4.0', branch: 'main', commit: 'e9b3c77', triggeredBy: 'studio@acme.co', status: 'success', platform: 'both', createdAt: project.updatedAt, duration: '5m 02s' },
    { id: 'd5', version: '1.5.0-beta', branch: 'feat/vertex', commit: 'f4a8d31', triggeredBy: 'studio@acme.co', status: 'running', platform: 'both', createdAt: project.updatedAt },
  ];
  const allDeployments = apiDeployments.length > 0 ? [...apiDeployments, ...mockDeployments.slice(0, 2)] : mockDeployments;

  const PROJECT_TABS = [
    { id: 'overview' as const, label: 'Overview', icon: Activity },
    { id: 'providers' as const, label: 'Providers', icon: Plug },
    { id: 'infrastructure' as const, label: 'Infrastructure', icon: Server },
    { id: 'deployments' as const, label: 'Deployments', icon: Package },
  ];

  return (
    <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, ease: 'easeOut' }} className="space-y-0">
      <div className="flex items-center gap-4 mb-6">
        <div className="flex-grow">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight">{project.name}</h1>
            <span className="text-xs px-2 py-0.5 rounded-full border font-medium bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30">ACTIVE</span>
          </div>
          <p className="text-xs text-muted-foreground font-mono mt-0.5">{project.bundleId}</p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" className="flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 border border-border rounded-lg hover:bg-accent transition-colors">
            <Github size={14} />
            <span>Repository</span>
          </button>
          <button
            type="button"
            onClick={onDeleteProject}
            className="flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 border border-red-500/40 text-red-600 dark:text-red-400 rounded-lg hover:bg-red-500/10 transition-colors"
          >
            <Trash2 size={14} />
            <span>Delete Project</span>
          </button>
          <button type="button" className="flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 bg-primary text-primary-foreground rounded-lg hover:opacity-90 transition-opacity">
            <Zap size={14} />
            <span>Trigger Build</span>
          </button>
        </div>
      </div>

      <div className="flex items-center gap-1 border-b border-border mb-6">
        {PROJECT_TABS.map((tab) => {
          const TabIcon = tab.icon;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onProjectTabChange(tab.id)}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px ${projectTab === tab.id ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
            >
              <TabIcon size={15} />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      <AnimatePresence mode="wait">
        {projectTab === 'overview' && (
          <motion.div
            key="overview"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2 }}
            className="space-y-6"
          >
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              {OVERVIEW_STATS.map((stat) => {
                const StatIcon = stat.icon;
                return (
                  <div key={stat.id} className="bg-card border border-border rounded-xl p-4 shadow-sm">
                    <div className="flex items-center justify-between mb-3">
                      <div className={`p-2 rounded-lg ${stat.bg}`}>
                        <StatIcon size={15} className={stat.color} />
                      </div>
                    </div>
                    <p className="text-xl font-bold tracking-tight">{stat.value}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{stat.label}</p>
                    <p className="text-[10px] text-muted-foreground/70 mt-0.5">{stat.sub}</p>
                  </div>
                );
              })}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h2 className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Active Plugins</h2>
                  <span className="text-[10px] font-bold bg-primary/10 text-primary px-2 py-0.5 rounded-full">{activePluginDetails.length}</span>
                </div>
                <div className="space-y-2">
                  {activePluginDetails.map((p) => (
                    <div key={p.id} className="bg-card border border-border rounded-xl p-3.5 flex items-center gap-3 shadow-sm">
                      <div className="p-2 rounded-lg bg-primary/5">
                        <Code2 size={14} className="text-primary" />
                      </div>
                      <div className="flex-grow min-w-0">
                        <p className="text-sm font-semibold truncate">{p.name}</p>
                        <p className="text-[10px] text-muted-foreground truncate">{p.provider}</p>
                      </div>
                      <div
                        className={`w-2 h-2 rounded-full shrink-0 ${p.health?.status === 'operational' ? 'bg-emerald-500' : p.health?.status === 'degraded' ? 'bg-amber-400' : 'bg-muted-foreground/40'}`}
                      />
                    </div>
                  ))}
                  {activePluginDetails.length === 0 && (
                    <div className="bg-muted/30 border border-dashed border-border rounded-xl p-6 text-center">
                      <p className="text-xs text-muted-foreground">No plugins active yet</p>
                      <p className="text-[10px] text-muted-foreground mt-1">Configure infrastructure to add plugins</p>
                    </div>
                  )}
                </div>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h2 className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Recent Activity</h2>
                  <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                    <RefreshCw size={10} className="animate-spin" />
                    <span>Live</span>
                  </span>
                </div>
                <div className="bg-slate-950 rounded-xl border border-slate-800 overflow-hidden">
                  <div className="flex items-center gap-1.5 px-3 py-2 border-b border-slate-800 bg-slate-900">
                    <span className="w-2 h-2 rounded-full bg-red-500/70" />
                    <span className="w-2 h-2 rounded-full bg-yellow-500/70" />
                    <span className="w-2 h-2 rounded-full bg-green-500/70" />
                    <span className="ml-1.5 text-[9px] font-mono text-slate-500">{project.bundleId}</span>
                  </div>
                  <div className="p-3 space-y-1 font-mono text-[10px] leading-relaxed max-h-52 overflow-y-auto">
                    {MOCK_LOGS.slice(-8).map((log) => (
                      <div key={log.id} className="flex gap-2 items-start">
                        <span className="text-slate-600 shrink-0">{log.timestamp}</span>
                        <span className={LOG_LEVEL_STYLES[log.level]}>{log.message}</span>
                      </div>
                    ))}
                  </div>
                  <div className="border-t border-slate-800 px-3 py-2 bg-slate-900 flex items-center gap-1.5">
                    <span className="text-emerald-400 font-mono text-[10px]">$</span>
                    <span className="text-slate-500 font-mono text-[10px] flex items-center gap-1">
                      <span>studio logs --follow</span>
                      <span className="w-1.5 h-3 bg-slate-400 animate-pulse ml-0.5" />
                    </span>
                  </div>
                </div>
                <div className="bg-slate-950 text-slate-300 rounded-xl p-3 flex items-center justify-between text-[10px] font-mono">
                  <span className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    <span>MCP Active</span>
                  </span>
                  <span className="text-emerald-400">ws://localhost:3001/mcp</span>
                </div>
              </div>
            </div>
          </motion.div>
        )}

        {projectTab === 'providers' && (
          <motion.div
            key="providers"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2 }}
            className="pb-8"
          >
            <ProjectProvidersTab
              projectName={project.name}
              bundleId={project.bundleId}
              connectedFirebase={connectedProviders.firebase}
              firebaseConnectionDetails={firebaseConnectionDetails}
              githubOrgConnected={connectedProviders.github}
              expoOrgConnected={connectedProviders.expo}
              githubProjectInitialized={githubProjectInitialized}
              expoProjectInitialized={expoProjectInitialized}
              integrationDependencyStatus={integrationDependencyStatus}
              onConnect={onProjectConnect}
              onOAuthStart={onProjectOAuthStart}
              onTriggerSetup={onProjectTriggerSetup}
              onDisconnect={onProjectDisconnect}
              onRefresh={onProjectProvidersRefresh}
            />
          </motion.div>
        )}

        {projectTab === 'infrastructure' && (
          <motion.div
            key="infrastructure"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2 }}
            className="space-y-4"
          >
            <div className="flex items-center justify-between mb-2">
              <div>
                <h2 className="text-sm font-bold">Infrastructure Setup</h2>
                <p className="text-xs text-muted-foreground mt-0.5">Select one plugin per category and configure project-level settings.</p>
              </div>
            </div>
            <InfrastructureTab projectPlugins={projectPlugins} />
          </motion.div>
        )}

        {projectTab === 'deployments' && (
          <motion.div
            key="deployments"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2 }}
            className="space-y-4"
          >
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold uppercase tracking-widest text-muted-foreground">Build History</h2>
              <button type="button" className="flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 bg-primary text-primary-foreground rounded-lg hover:opacity-90 transition-opacity">
                <Zap size={13} />
                <span>Trigger Build</span>
              </button>
            </div>
            <div className="space-y-3">
              {allDeployments.map((dep) => {
                const cfg = DEPLOY_STATUS_CONFIG[dep.status] ?? DEPLOY_STATUS_CONFIG.queued;
                return (
                  <div key={dep.id} className="bg-card border border-border rounded-xl p-5 shadow-sm flex items-center gap-5">
                    <div className="shrink-0">
                      {dep.status === 'running' && <Loader2 size={20} className="text-blue-500 animate-spin" />}
                      {dep.status === 'success' && <CheckCircle2 size={20} className="text-emerald-500" />}
                      {dep.status === 'failed' && <AlertCircle size={20} className="text-red-500" />}
                      {dep.status === 'queued' && <Circle size={20} className="text-muted-foreground" />}
                    </div>
                    <div className="flex-grow min-w-0">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <span className="font-bold text-sm">v{dep.version}</span>
                        <span className="text-[10px] font-mono bg-muted px-1.5 py-0.5 rounded text-muted-foreground">{dep.commit}</span>
                        <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                          <GitBranch size={10} />
                          <span>{dep.branch}</span>
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        <span>Triggered by {dep.triggeredBy}</span>
                        <span className="mx-1.5">·</span>
                        <span>{formatDate(dep.createdAt)}</span>
                        {dep.duration && (
                          <>
                            <span className="mx-1.5">·</span>
                            <span>{dep.duration}</span>
                          </>
                        )}
                      </p>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <span className="text-[10px] uppercase font-bold text-muted-foreground">{dep.platform}</span>
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${cfg.bg} ${cfg.color}`}>{cfg.label}</span>
                      <button type="button" className="p-1.5 hover:bg-accent rounded transition-colors text-muted-foreground">
                        <ExternalLink size={13} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
