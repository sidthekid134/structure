import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertCircle,
  AlertTriangle,
  CheckCheck,
  CheckCircle2,
  ChevronRight,
  Loader2,
  Play,
  RefreshCw,
  RotateCcw,
  X,
} from 'lucide-react';
import { INFRA_CATEGORIES } from './constants';
import type { ProjectPluginState, SetupTaskStatus } from './types';

export function InfrastructureTab({ projectPlugins }: { projectPlugins: string[] }) {
  const [pluginStates, setPluginStates] = useState<Record<string, ProjectPluginState>>(() => {
    const initial: Record<string, ProjectPluginState> = {};
    INFRA_CATEGORIES.forEach((cat) => {
      const activePlugin = cat.plugins.find((p) => projectPlugins.includes(p.id));
      initial[cat.id] = {
        categoryId: cat.id,
        selectedPluginId: activePlugin?.id ?? null,
        configValues: {},
        setupStatus: activePlugin ? 'completed' : 'idle',
        taskStates: activePlugin ? Object.fromEntries(activePlugin.setupTasks.map((t) => [t.id, 'completed' as SetupTaskStatus])) : {},
      };
    });
    return initial;
  });
  const [expandedCategory, setExpandedCategory] = useState<string | null>(INFRA_CATEGORIES[0]?.id ?? null);

  const runSetup = (categoryId: string) => {
    const state = pluginStates[categoryId];
    if (!state?.selectedPluginId) return;
    const category = INFRA_CATEGORIES.find((c) => c.id === categoryId);
    if (!category) return;
    const plugin = category.plugins.find((p) => p.id === state.selectedPluginId);
    if (!plugin) return;
    setPluginStates((prev) => ({
      ...prev,
      [categoryId]: {
        ...prev[categoryId],
        setupStatus: 'running',
        taskStates: Object.fromEntries(plugin.setupTasks.map((t) => [t.id, 'idle' as SetupTaskStatus])),
      },
    }));
    let cumulative = 0;
    plugin.setupTasks.forEach((task) => {
      const startDelay = cumulative;
      cumulative += task.duration + 200;
      setTimeout(() => {
        setPluginStates((prev) => ({
          ...prev,
          [categoryId]: {
            ...prev[categoryId],
            taskStates: { ...prev[categoryId].taskStates, [task.id]: 'running' },
          },
        }));
      }, startDelay);
      setTimeout(() => {
        const finalStatus: SetupTaskStatus = task.manualRequired ? 'manual-required' : 'completed';
        setPluginStates((prev) => {
          const newTaskStates = { ...prev[categoryId].taskStates, [task.id]: finalStatus };
          const allDone = plugin.setupTasks.every((t) => {
            const s = newTaskStates[t.id];
            return s === 'completed' || s === 'manual-required';
          });
          const hasManual = plugin.setupTasks.some((t) => newTaskStates[t.id] === 'manual-required');
          return {
            ...prev,
            [categoryId]: {
              ...prev[categoryId],
              taskStates: newTaskStates,
              setupStatus: allDone ? (hasManual ? 'manual-required' : 'completed') : 'running',
              completedAt: allDone ? new Date().toISOString() : undefined,
            },
          };
        });
      }, startDelay + task.duration);
    });
  };

  const resetSetup = (categoryId: string) => {
    setPluginStates((prev) => ({
      ...prev,
      [categoryId]: {
        ...prev[categoryId],
        setupStatus: 'idle',
        taskStates: {},
      },
    }));
  };

  return (
    <div className="space-y-4">
      {INFRA_CATEGORIES.map((category) => {
        const state = pluginStates[category.id];
        const CategoryIcon = category.icon;
        const isExpanded = expandedCategory === category.id;
        const selectedPlugin = category.plugins.find((p) => p.id === state?.selectedPluginId) ?? null;
        const isSetupDone = state?.setupStatus === 'completed' || state?.setupStatus === 'manual-required';
        const isRunning = state?.setupStatus === 'running';
        return (
          <div key={category.id} className={`bg-card border rounded-2xl overflow-hidden transition-all shadow-sm ${isExpanded ? 'border-border' : 'border-border/60'}`}>
            <button
              type="button"
              onClick={() => setExpandedCategory(isExpanded ? null : category.id)}
              className="w-full flex items-center gap-4 p-5 hover:bg-muted/40 transition-colors text-left"
            >
              <div className={`p-2 rounded-xl bg-muted ${category.color}`}>
                <CategoryIcon size={16} />
              </div>
              <div className="flex-grow min-w-0">
                <div className="flex items-center gap-2.5">
                  <span className="font-bold text-sm">{category.label}</span>
                  {selectedPlugin && (
                    <span className="text-[10px] font-mono bg-muted px-1.5 py-0.5 rounded text-muted-foreground border border-border">{selectedPlugin.name}</span>
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground mt-0.5">{category.description}</p>
              </div>
              <div className="flex items-center gap-2.5 shrink-0">
                {state?.setupStatus === 'completed' && (
                  <span className="flex items-center gap-1 text-[10px] font-bold text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 px-2 py-0.5 rounded-full">
                    <CheckCircle2 size={10} />
                    <span>CONFIGURED</span>
                  </span>
                )}
                {state?.setupStatus === 'manual-required' && (
                  <span className="flex items-center gap-1 text-[10px] font-bold text-amber-600 dark:text-amber-400 bg-amber-500/10 border border-amber-500/30 px-2 py-0.5 rounded-full">
                    <AlertTriangle size={10} />
                    <span>MANUAL STEP</span>
                  </span>
                )}
                {state?.setupStatus === 'running' && (
                  <span className="flex items-center gap-1 text-[10px] font-bold text-blue-600 dark:text-blue-400 bg-blue-500/10 border border-blue-500/30 px-2 py-0.5 rounded-full animate-pulse">
                    <Loader2 size={10} className="animate-spin" />
                    <span>RUNNING</span>
                  </span>
                )}
                {state?.setupStatus === 'idle' && !selectedPlugin && (
                  <span className="text-[10px] font-bold text-muted-foreground bg-muted px-2 py-0.5 rounded-full border border-border">NOT SET</span>
                )}
                <ChevronRight size={16} className={`text-muted-foreground transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`} />
              </div>
            </button>

            <AnimatePresence initial={false}>
              {isExpanded && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.25, ease: 'easeInOut' }}
                  className="overflow-hidden"
                >
                  <div className="border-t border-border">
                    {!isRunning && !isSetupDone && (
                      <div className="p-5 space-y-4">
                        <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">Select Plugin</p>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          {category.plugins.map((plugin) => {
                            const isSelected = state?.selectedPluginId === plugin.id;
                            return (
                              <button
                                key={plugin.id}
                                type="button"
                                onClick={() =>
                                  setPluginStates((prev) => ({
                                    ...prev,
                                    [category.id]: {
                                      ...prev[category.id],
                                      selectedPluginId: plugin.id,
                                      configValues: {},
                                    },
                                  }))
                                }
                                className={`text-left p-4 rounded-xl border-2 transition-all ${isSelected ? 'border-primary bg-primary/5 shadow-sm' : 'border-border hover:border-primary/40 hover:bg-muted/40'}`}
                              >
                                <div className="flex items-start justify-between mb-1.5">
                                  <span className="font-bold text-sm">{plugin.name}</span>
                                  {isSelected && <CheckCircle2 size={14} className="text-primary shrink-0" />}
                                </div>
                                <p className="text-[10px] font-medium text-muted-foreground mb-1">{plugin.provider}</p>
                                <p className="text-xs text-muted-foreground leading-relaxed">{plugin.description}</p>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {!isRunning && !isSetupDone && selectedPlugin && selectedPlugin.configFields.length > 0 && (
                      <div className="px-5 pb-4 space-y-3">
                        <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground mb-3">Configuration</p>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                          {selectedPlugin.configFields.map((field) => (
                            <div key={field.key} className="space-y-1.5">
                              <label className="text-xs font-semibold text-foreground">{field.label}</label>
                              {field.type === 'select' && field.options ? (
                                <select
                                  value={state?.configValues[field.key] ?? ''}
                                  onChange={(e) =>
                                    setPluginStates((prev) => ({
                                      ...prev,
                                      [category.id]: {
                                        ...prev[category.id],
                                        configValues: { ...prev[category.id].configValues, [field.key]: e.target.value },
                                      },
                                    }))
                                  }
                                  className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all"
                                >
                                  <option value="">{field.placeholder}</option>
                                  {field.options.map((opt) => (
                                    <option key={opt} value={opt}>
                                      {opt}
                                    </option>
                                  ))}
                                </select>
                              ) : (
                                <input
                                  type="text"
                                  placeholder={field.placeholder}
                                  value={state?.configValues[field.key] ?? ''}
                                  onChange={(e) =>
                                    setPluginStates((prev) => ({
                                      ...prev,
                                      [category.id]: {
                                        ...prev[category.id],
                                        configValues: { ...prev[category.id].configValues, [field.key]: e.target.value },
                                      },
                                    }))
                                  }
                                  className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all font-mono"
                                />
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {!isRunning && !isSetupDone && (
                      <div className="px-5 pb-5">
                        <button
                          type="button"
                          onClick={() => runSetup(category.id)}
                          disabled={!selectedPlugin}
                          className="flex items-center gap-2 bg-primary text-primary-foreground px-5 py-2.5 rounded-lg text-sm font-bold hover:opacity-90 transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-sm"
                        >
                          <Play size={14} fill="currentColor" />
                          <span>Run Setup</span>
                        </button>
                      </div>
                    )}

                    {(isRunning || isSetupDone) && selectedPlugin && (
                      <div className="p-5 space-y-4">
                        <div className="flex items-center justify-between">
                          <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">Setup Timeline — {selectedPlugin.name}</p>
                          {isSetupDone && (
                            <button
                              type="button"
                              onClick={() => resetSetup(category.id)}
                              className="flex items-center gap-1.5 text-[10px] font-bold text-muted-foreground hover:text-foreground px-2.5 py-1 rounded-lg border border-border hover:bg-accent transition-colors"
                            >
                              <RotateCcw size={10} />
                              <span>Reset</span>
                            </button>
                          )}
                        </div>

                        <div className="space-y-0">
                          {selectedPlugin.setupTasks.map((task, idx) => {
                            const taskStatus = state?.taskStates[task.id] ?? 'idle';
                            const isLast = idx === selectedPlugin.setupTasks.length - 1;
                            return (
                              <div key={task.id} className="flex gap-4">
                                <div className="flex flex-col items-center">
                                  <div
                                    className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 border-2 transition-all duration-300 ${
                                      taskStatus === 'completed'
                                        ? 'border-emerald-500 bg-emerald-500/10'
                                        : taskStatus === 'running'
                                          ? 'border-primary bg-primary/10'
                                          : taskStatus === 'manual-required'
                                            ? 'border-amber-500 bg-amber-500/10'
                                            : taskStatus === 'error'
                                              ? 'border-red-500 bg-red-500/10'
                                              : 'border-border bg-background'
                                    }`}
                                  >
                                    {taskStatus === 'completed' && <CheckCircle2 size={13} className="text-emerald-500" />}
                                    {taskStatus === 'running' && <Loader2 size={13} className="text-primary animate-spin" />}
                                    {taskStatus === 'manual-required' && <AlertTriangle size={13} className="text-amber-500" />}
                                    {taskStatus === 'error' && <X size={13} className="text-red-500" />}
                                    {taskStatus === 'idle' && <span className="w-2 h-2 rounded-full bg-muted-foreground/30" />}
                                  </div>
                                  {!isLast && (
                                    <div
                                      className={`w-0.5 flex-grow my-1 transition-all duration-500 ${taskStatus === 'completed' || taskStatus === 'manual-required' ? 'bg-emerald-500/40' : 'bg-border'}`}
                                      style={{ minHeight: '20px' }}
                                    />
                                  )}
                                </div>
                                <div className="flex-grow pb-4">
                                  <div className="flex items-start justify-between gap-2">
                                    <div className="pt-0.5">
                                      <p className={`text-sm font-semibold leading-tight ${taskStatus === 'idle' ? 'text-muted-foreground' : 'text-foreground'}`}>{task.title}</p>
                                      <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">{task.description}</p>
                                      {taskStatus === 'manual-required' && task.manualLabel && (
                                        <div className="mt-2 flex items-start gap-2 bg-amber-500/10 border border-amber-500/30 rounded-lg p-2.5">
                                          <AlertTriangle size={12} className="text-amber-500 shrink-0 mt-0.5" />
                                          <p className="text-[11px] text-amber-600 dark:text-amber-400 leading-relaxed">{task.manualLabel}</p>
                                        </div>
                                      )}
                                    </div>
                                    <div className="shrink-0 pt-0.5">
                                      {taskStatus === 'running' && (
                                        <span className="text-[9px] font-bold text-blue-600 dark:text-blue-400 bg-blue-500/10 border border-blue-500/30 px-1.5 py-0.5 rounded animate-pulse">RUNNING</span>
                                      )}
                                      {taskStatus === 'completed' && (
                                        <span className="text-[9px] font-bold text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 px-1.5 py-0.5 rounded">DONE</span>
                                      )}
                                      {taskStatus === 'manual-required' && (
                                        <span className="text-[9px] font-bold text-amber-600 dark:text-amber-400 bg-amber-500/10 border border-amber-500/30 px-1.5 py-0.5 rounded">ACTION</span>
                                      )}
                                    </div>
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>

                        {isSetupDone && (
                          <div
                            className={`rounded-xl p-3.5 flex items-center gap-3 border ${state?.setupStatus === 'manual-required' ? 'bg-amber-500/10 border-amber-500/30' : 'bg-emerald-500/10 border-emerald-500/30'}`}
                          >
                            {state?.setupStatus === 'manual-required' ? (
                              <AlertTriangle size={16} className="text-amber-500 shrink-0" />
                            ) : (
                              <CheckCheck size={16} className="text-emerald-500 shrink-0" />
                            )}
                            <div>
                              <p className={`text-xs font-bold ${state?.setupStatus === 'manual-required' ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                                {state?.setupStatus === 'manual-required' ? 'Setup complete — manual action required' : 'Setup complete'}
                              </p>
                              {state?.completedAt && <p className="text-[10px] text-muted-foreground mt-0.5">Finished at {new Date(state.completedAt).toLocaleTimeString()}</p>}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        );
      })}
    </div>
  );
}

// --- OrgOverview ---
