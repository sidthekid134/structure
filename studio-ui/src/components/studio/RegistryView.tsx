import { ArrowRight, CheckCircle2, Code2, Link2 } from 'lucide-react';
import {
  ALL_REGISTRY_PLUGINS,
  CATEGORY_LABEL_MAP,
  CATEGORY_PILL_STYLE,
  INTEGRATION_CONFIGS,
  PROVIDER_PLUGIN_MAP,
  REGISTRY_CATEGORIES,
} from './constants';
import type { ConnectedProviders, IntegrationConfig, ProviderId, RegistryPlugin } from './types';

function isPluginConnected(plugin: RegistryPlugin, connectedProviders: ConnectedProviders): boolean {
  if (plugin.providerId === 'studio') return true;
  if (plugin.providerId === 'firebase') return connectedProviders.firebase;
  if (plugin.providerId === 'expo') return connectedProviders.expo;
  if (plugin.providerId === 'github') return connectedProviders.github;
  return false;
}

function getProviderConfig(plugin: RegistryPlugin): IntegrationConfig | null {
  if (plugin.providerId === 'firebase' || plugin.providerId === 'expo' || plugin.providerId === 'github') {
    return INTEGRATION_CONFIGS.find((c) => c.id === plugin.providerId) ?? null;
  }
  return null;
}

export function RegistryView({
  connectedProviders,
  activeProjectId,
  onOpenIntegration,
}: {
  connectedProviders: ConnectedProviders;
  activeProjectId: string | null;
  onOpenIntegration: (id: ProviderId) => void;
}) {
  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500 space-y-8">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Plugin Registry</h1>
          <p className="text-muted-foreground mt-1">
            {ALL_REGISTRY_PLUGINS.length} plugins across {REGISTRY_CATEGORIES.length} categories. Plugins may appear in multiple sections.
          </p>
        </div>
      </div>

      <div className="bg-card border border-border rounded-xl p-4 flex items-center gap-3 flex-wrap">
        <p className="text-xs font-bold text-muted-foreground uppercase tracking-widest mr-1">Integrations</p>
        {INTEGRATION_CONFIGS.map((cfg) => {
          const connected = connectedProviders[cfg.id];
          const available = cfg.scope === 'project' && !activeProjectId;
          const CfgIcon = cfg.logo;
          const pluginCount = PROVIDER_PLUGIN_MAP[cfg.id]?.length ?? 0;
          return (
            <button
              key={cfg.id}
              type="button"
              onClick={() => onOpenIntegration(cfg.id)}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-semibold transition-all hover:shadow-sm ${
                connected
                  ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/15'
                  : available
                    ? 'bg-blue-500/10 border-blue-500/30 text-blue-600 dark:text-blue-400 hover:bg-blue-500/15'
                    : 'bg-muted/50 border-dashed border-border text-muted-foreground hover:border-primary/40 hover:text-foreground'
              }`}
            >
              <CfgIcon
                size={13}
                className={
                  connected
                    ? 'text-emerald-500'
                    : available
                      ? 'text-blue-500'
                      : 'text-muted-foreground'
                }
              />
              <span>{cfg.name}</span>
              {connected ? (
                <CheckCircle2 size={12} className="text-emerald-500" />
              ) : available ? (
                <span className="text-[10px] font-bold text-blue-600 dark:text-blue-400 bg-blue-500/10 border border-blue-500/30 px-1.5 py-0.5 rounded-full">
                  AVAILABLE
                </span>
              ) : (
                <span className="text-[10px] font-bold text-muted-foreground bg-muted px-1 py-0.5 rounded">
                  {pluginCount} plugins
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="space-y-10">
        {REGISTRY_CATEGORIES.map((category) => {
          const CategoryIcon = category.icon;
          const plugins = ALL_REGISTRY_PLUGINS.filter((p) => category.pluginIds.includes(p.id));
          return (
            <section key={category.id}>
              <div className="flex items-center gap-3 mb-4">
                <div className={`p-2 rounded-lg bg-muted ${category.color}`}>
                  <CategoryIcon size={16} />
                </div>
                <h2 className="text-base font-bold tracking-tight">{category.label}</h2>
                <span className="text-[10px] font-bold text-muted-foreground bg-muted px-2 py-0.5 rounded-full">{plugins.length} plugins</span>
                <div className="flex-grow h-px bg-border ml-2" />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {plugins.map((plugin) => {
                  const connected = isPluginConnected(plugin, connectedProviders);
                  const providerConfig = getProviderConfig(plugin);
                  const projectScopedAvailable =
                    providerConfig?.scope === 'project' &&
                    !activeProjectId;
                  const crossCategories = plugin.categories.filter((c) => c !== category.id);
                  const isStudio = plugin.providerId === 'studio';
                  return (
                    <div
                      key={`${category.id}-${plugin.id}`}
                      className={`relative bg-card rounded-xl p-5 flex flex-col transition-all ${
                        plugin.future
                          ? 'border border-border opacity-60'
                          : connected
                            ? 'border-2 border-emerald-500/50 shadow-sm hover:shadow-md'
                            : projectScopedAvailable
                              ? 'border border-blue-500/30 shadow-sm hover:shadow-md'
                              : 'border border-dashed border-border hover:border-primary/40 hover:shadow-sm'
                      }`}
                    >
                      {connected && !plugin.future && <div className="absolute top-0 left-0 right-0 h-0.5 bg-gradient-to-r from-emerald-500 to-emerald-400 rounded-t-xl" />}
                      <div className="flex items-start justify-between mb-3">
                        <div className={`p-2 rounded-lg ${connected && !plugin.future ? 'bg-emerald-500/10' : 'bg-accent'}`}>
                          <Code2 size={18} className={connected && !plugin.future ? 'text-emerald-500' : 'text-primary'} />
                        </div>
                        <div className="flex items-center gap-1.5">
                          {plugin.future && <span className="text-[9px] font-bold bg-muted text-muted-foreground px-1.5 py-0.5 rounded border border-border">SOON</span>}
                          {!plugin.future && connected && (
                            <span className="flex items-center gap-1 text-[9px] font-bold text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 px-1.5 py-0.5 rounded-full">
                              <CheckCircle2 size={9} />
                              <span>CONNECTED</span>
                            </span>
                          )}
                          {!plugin.future && !connected && !isStudio && (
                            projectScopedAvailable ? (
                              <span className="text-[9px] font-bold text-blue-600 dark:text-blue-400 bg-blue-500/10 border border-blue-500/30 px-1.5 py-0.5 rounded-full">
                                AVAILABLE
                              </span>
                            ) : (
                              <span className="text-[9px] font-bold text-amber-600 dark:text-amber-400 bg-amber-500/10 border border-amber-500/30 px-1.5 py-0.5 rounded-full">
                                NOT CONNECTED
                              </span>
                            )
                          )}
                          <span className="text-[10px] font-mono text-muted-foreground">v{plugin.version}</span>
                        </div>
                      </div>
                      <h3 className="font-bold text-sm mb-0.5">{plugin.name}</h3>
                      <p className="text-[11px] text-muted-foreground font-medium mb-2">{plugin.provider}</p>
                      <p className="text-xs text-muted-foreground leading-relaxed flex-grow mb-4">{plugin.description}</p>
                      {crossCategories.length > 0 && (
                        <div className="flex flex-wrap gap-1 mb-3">
                          {crossCategories.map((catId) => (
                            <span key={catId} className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${CATEGORY_PILL_STYLE[catId] ?? 'bg-muted text-muted-foreground border-border'}`}>
                              <span>Also: </span>
                              <span>{CATEGORY_LABEL_MAP[catId] ?? catId}</span>
                            </span>
                          ))}
                        </div>
                      )}
                      {plugin.future ? (
                        <button type="button" disabled className="w-full py-2 text-xs font-bold border border-border rounded-lg text-muted-foreground cursor-not-allowed opacity-60">
                          Coming Soon
                        </button>
                      ) : connected ? (
                        <button
                          type="button"
                          onClick={() => providerConfig && onOpenIntegration(providerConfig.id)}
                          className="w-full py-2 text-xs font-bold border border-emerald-500/30 text-emerald-600 dark:text-emerald-400 rounded-lg hover:bg-emerald-500/10 transition-colors flex items-center justify-center gap-1.5"
                        >
                          <CheckCircle2 size={12} />
                          <span>{isStudio ? 'View Plugin Contract' : 'View Integration'}</span>
                        </button>
                      ) : providerConfig ? (
                        <button
                          type="button"
                          onClick={() => onOpenIntegration(providerConfig.id)}
                          className={`w-full py-2 text-xs font-bold rounded-lg transition-colors flex items-center justify-center gap-1.5 ${
                            projectScopedAvailable
                              ? 'border border-blue-500/30 text-blue-600 dark:text-blue-400 hover:bg-blue-500/10'
                              : 'border border-dashed border-primary/40 text-primary hover:bg-primary/5'
                          }`}
                        >
                          <Link2 size={12} />
                          <span>
                            {projectScopedAvailable
                              ? `Configure ${providerConfig.name}`
                              : `Connect ${providerConfig.name}`}
                          </span>
                          <ArrowRight size={11} />
                        </button>
                      ) : (
                        <button type="button" className="w-full py-2 text-xs font-bold border border-border rounded-lg hover:bg-accent transition-colors">
                          View Plugin Contract
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
