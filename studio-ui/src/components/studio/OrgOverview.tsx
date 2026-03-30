import { motion } from 'framer-motion';
import {
  Activity,
  CheckCircle2,
  ChevronRight,
  Clock,
  Link2,
  Package,
  Smartphone,
  TrendingUp,
} from 'lucide-react';
import { INTEGRATION_CONFIGS, PROVIDER_PLUGIN_MAP } from './constants';
import { formatDate } from './helpers';
import type { ConnectedProviders, ProjectSummary, ProviderId } from './types';

export function OrgOverview({
  projects,
  onSelectProject,
  connectedProviders,
  onOpenIntegration,
  wsStatus,
  totalModulesConfigured,
}: {
  projects: ProjectSummary[];
  onSelectProject: (id: string) => void;
  connectedProviders: ConnectedProviders;
  onOpenIntegration: (id: ProviderId) => void;
  wsStatus: string;
  totalModulesConfigured: number;
}) {
  const integrationSummary = INTEGRATION_CONFIGS.map((cfg) => ({
    ...cfg,
    connected: connectedProviders[cfg.id],
    pluginCount: PROVIDER_PLUGIN_MAP[cfg.id]?.length ?? 0,
  }));
  const totalModules = projects.reduce((acc, p) => acc + p.integration_progress.total, 0);

  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500 space-y-8">
      <header className="flex justify-between items-end">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Organization</h1>
          <p className="text-muted-foreground mt-1">Manage your projects and infrastructure across the organization.</p>
        </div>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <div className="p-2 rounded-lg bg-primary/10">
              <Smartphone size={15} className="text-primary" />
            </div>
          </div>
          <p className="text-2xl font-bold tracking-tight">{projects.length}</p>
          <p className="text-xs text-muted-foreground mt-0.5">Projects</p>
          <p className="text-[10px] text-muted-foreground/70 mt-0.5">Total in organization</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <div className="p-2 rounded-lg bg-blue-500/10">
              <Package size={15} className="text-blue-500" />
            </div>
          </div>
          <p className="text-2xl font-bold tracking-tight">{totalModulesConfigured}/{totalModules || 1}</p>
          <p className="text-xs text-muted-foreground mt-0.5">Modules Configured</p>
          <p className="text-[10px] text-muted-foreground/70 mt-0.5">Across all projects</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <div className="p-2 rounded-lg bg-violet-500/10">
              <TrendingUp size={15} className="text-violet-500" />
            </div>
          </div>
          <p className="text-2xl font-bold tracking-tight">99.6%</p>
          <p className="text-xs text-muted-foreground mt-0.5">Avg Uptime</p>
          <p className="text-[10px] text-muted-foreground/70 mt-0.5">All services</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <div className={`p-2 rounded-lg ${wsStatus === 'live' ? 'bg-emerald-500/10' : wsStatus === 'connecting' ? 'bg-amber-500/10' : 'bg-muted'}`}>
              <Activity size={15} className={wsStatus === 'live' ? 'text-emerald-500' : wsStatus === 'connecting' ? 'text-amber-500' : 'text-muted-foreground'} />
            </div>
          </div>
          <p className="text-2xl font-bold tracking-tight capitalize">{wsStatus}</p>
          <p className="text-xs text-muted-foreground mt-0.5">Live Status</p>
          <p className="text-[10px] text-muted-foreground/70 mt-0.5">WebSocket connections</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-bold uppercase tracking-widest text-muted-foreground">All Projects</h2>
            <span className="text-[10px] font-bold bg-primary/10 text-primary px-2 py-0.5 rounded-full">{projects.length}</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {projects.length === 0 ? (
              <div className="col-span-2 rounded-xl border border-dashed border-border bg-muted/20 p-12 text-center">
                <Smartphone size={48} className="mx-auto text-muted-foreground/50 mb-4" />
                <p className="text-sm text-muted-foreground">No projects yet. Create one to get started.</p>
              </div>
            ) : (
              projects.map((project) => (
                <motion.div
                  key={project.id}
                  whileHover={{ y: -4 }}
                  className="bg-card border border-border rounded-xl p-5 shadow-sm hover:shadow-md transition-all cursor-pointer group"
                  onClick={() => onSelectProject(project.id)}
                >
                  <div className="flex justify-between items-start mb-4">
                    <div className="bg-accent p-2 rounded-lg group-hover:bg-primary/10 transition-colors">
                      <Smartphone className="text-primary" size={20} />
                    </div>
                    <span className="text-[10px] font-bold bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30 px-2 py-0.5 rounded-full">
                      ACTIVE
                    </span>
                  </div>
                  <h3 className="font-semibold text-lg">{project.name}</h3>
                  <p className="text-sm text-muted-foreground font-mono mb-4">{project.bundleId}</p>
                  <div className="flex gap-2 mb-4 flex-wrap">
                    <span className="bg-muted px-2 py-1 rounded text-[10px] uppercase font-bold text-muted-foreground">
                      {project.integration_progress.configured}/{project.integration_progress.total} configured
                    </span>
                  </div>
                  <div className="flex items-center justify-between pt-4 border-t border-border">
                    <span className="text-xs text-muted-foreground flex items-center gap-1">
                      <Clock size={12} />
                      <span>{formatDate(project.updatedAt)}</span>
                    </span>
                    <ChevronRight size={16} className="text-muted-foreground" />
                  </div>
                </motion.div>
              ))
            )}
          </div>
        </div>

        <div className="space-y-4">
          <h2 className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Integrations</h2>
          <div className="space-y-2">
            {integrationSummary.map((cfg) => {
              const CfgIcon = cfg.logo;
              const isAutoAvailable = cfg.orgAvailability === 'automatic';
              if (isAutoAvailable) {
                return (
                  <div
                    key={cfg.id}
                    className="w-full flex items-center gap-3 p-3.5 rounded-xl border bg-blue-500/8 border-blue-500/25 text-left shadow-sm"
                  >
                    <div className="p-2 rounded-lg bg-blue-500/12">
                      <CfgIcon size={14} className="text-blue-500" />
                    </div>
                    <div className="flex-grow min-w-0">
                      <p className="text-sm font-semibold truncate">{cfg.name}</p>
                      <p className="text-[10px] text-blue-600/70 dark:text-blue-400/70">Available to all projects</p>
                    </div>
                    <CheckCircle2 size={14} className="text-blue-500 shrink-0" />
                  </div>
                );
              }
              return (
                <button
                  key={cfg.id}
                  type="button"
                  onClick={() => onOpenIntegration(cfg.id)}
                  className={`w-full flex items-center gap-3 p-3.5 rounded-xl border transition-all text-left shadow-sm hover:shadow-md ${
                    cfg.connected ? 'bg-emerald-500/10 border-emerald-500/30 hover:bg-emerald-500/15' : 'bg-card border-dashed border-border hover:border-primary/40'
                  }`}
                >
                  <div className={`p-2 rounded-lg ${cfg.connected ? 'bg-emerald-500/15' : 'bg-muted'}`}>
                    <CfgIcon size={14} className={cfg.connected ? 'text-emerald-500' : 'text-muted-foreground'} />
                  </div>
                  <div className="flex-grow min-w-0">
                    <p className="text-sm font-semibold truncate">{cfg.name}</p>
                    <p className="text-[10px] text-muted-foreground">{cfg.connected ? `${cfg.pluginCount} plugins unlocked` : 'Not connected'}</p>
                  </div>
                  {cfg.connected ? <CheckCircle2 size={14} className="text-emerald-500 shrink-0" /> : <Link2 size={14} className="text-muted-foreground/50 shrink-0" />}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
