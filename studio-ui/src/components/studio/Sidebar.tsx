import { Activity, Cpu, Layers, Plus, User } from 'lucide-react';
import type { ProjectSummary, StudioView } from './types';

export function Sidebar({
  projects,
  activeProjectId,
  view,
  onSelectProject,
  onViewChange,
  onShowCreate,
}: {
  projects: ProjectSummary[];
  activeProjectId: string | null;
  view: StudioView;
  onSelectProject: (projectId: string) => void;
  onViewChange: (view: StudioView) => void;
  onShowCreate: () => void;
}) {
  return (
    <aside className="w-72 border-r border-border bg-card flex flex-col shrink-0 overflow-hidden">
      <div className="p-4 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded bg-primary text-primary-foreground flex items-center justify-center">
            <Cpu size={16} />
          </div>
          <div className="overflow-hidden">
            <p className="text-sm font-bold leading-tight">Studio Core</p>
            <p className="text-[10px] text-muted-foreground">Magicpath UI</p>
          </div>
        </div>
        <button type="button" onClick={onShowCreate} className="rounded-md px-2 py-1 text-xs bg-primary text-primary-foreground flex items-center gap-1 shrink-0">
          <Plus size={12} /> New
        </button>
      </div>

      <div className="flex-1 min-h-0 flex flex-col">
        <div className="px-3 pt-3 pb-2 flex items-center justify-between">
          <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">Projects</p>
          <span className="text-[10px] text-muted-foreground">{projects.length}</span>
        </div>
        <div className="px-3 pb-3 flex-1 overflow-y-auto space-y-2">
          {projects.length === 0 ? (
            <div className="text-xs text-muted-foreground px-2 py-3">No projects yet.</div>
          ) : (
            projects.map((project) => (
              <button
                type="button"
                key={project.id}
                className={`w-full text-left rounded-lg border p-3 transition ${
                  project.id === activeProjectId
                    ? 'border-primary bg-primary/10 shadow-sm'
                    : 'border-border hover:border-primary/50 hover:bg-muted/40'
                }`}
                onClick={() => onSelectProject(project.id)}
              >
                <p className="text-sm font-semibold truncate">{project.name}</p>
                <p className="text-[10px] text-muted-foreground mt-1 font-mono truncate">{project.bundleId}</p>
                <p className="text-[10px] text-muted-foreground mt-1">
                  {project.integration_progress.configured}/{project.integration_progress.total} configured
                </p>
              </button>
            ))
          )}
        </div>
      </div>

      <div className="p-3 border-t border-border space-y-1">
        <button type="button" className={`w-full text-left rounded-lg px-3 py-2 text-sm flex items-center ${view === 'overview' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`} onClick={() => onViewChange('overview')}>
          <Activity size={14} className="mr-2 shrink-0" />
          Overview
        </button>
        <button type="button" className={`w-full text-left rounded-lg px-3 py-2 text-sm flex items-center ${view === 'registry' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`} onClick={() => onViewChange('registry')}>
          <Layers size={14} className="mr-2 shrink-0" />
          Registry
        </button>
      </div>

      <div className="p-3 border-t border-border">
        <div className="flex items-center gap-3 bg-muted/40 rounded-lg p-2.5">
          <div className="w-8 h-8 rounded-full bg-accent flex items-center justify-center shrink-0">
            <User size={14} />
          </div>
          <div className="min-w-0">
            <p className="text-xs font-semibold truncate">Studio Operator</p>
            <p className="text-[10px] text-muted-foreground">Admin Access</p>
          </div>
        </div>
      </div>
    </aside>
  );
}
