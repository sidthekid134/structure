import { useMemo } from 'react';
import {
  ArrowRight,
  Check,
  ChevronRight,
  Globe,
  Layers,
  LayoutGrid,
  Link2,
  Package,
  Smartphone,
  Sparkles,
} from 'lucide-react';
import type {
  ModuleDefinition,
  ModuleFunctionGroupId,
  ModuleId,
  ProjectTemplate,
  ProjectTemplateId,
} from './types';

const MODULES: ModuleDefinition[] = [
  {
    id: 'firebase-core',
    label: 'Firebase Core',
    description: 'Project + service account bootstrap.',
    provider: 'firebase',
    functionGroupId: 'cloud-foundation',
    requiredModules: [],
    optionalModules: [],
    stepKeys: [],
    teardownStepKeys: [],
  },
  {
    id: 'firebase-auth',
    label: 'Firebase Auth',
    description: 'Authentication provider setup.',
    provider: 'oauth',
    functionGroupId: 'auth-identity',
    requiredModules: ['firebase-core'],
    optionalModules: [],
    stepKeys: [],
    teardownStepKeys: [],
  },
  {
    id: 'firebase-firestore',
    label: 'Firestore',
    description: 'Database rules and provisioning.',
    provider: 'firebase',
    functionGroupId: 'persistent-store',
    requiredModules: ['firebase-core'],
    optionalModules: [],
    stepKeys: [],
    teardownStepKeys: [],
  },
  {
    id: 'firebase-storage',
    label: 'Storage',
    description: 'Cloud Storage and rules.',
    provider: 'firebase',
    functionGroupId: 'object-storage',
    requiredModules: ['firebase-core'],
    optionalModules: [],
    stepKeys: [],
    teardownStepKeys: [],
  },
  {
    id: 'firebase-messaging',
    label: 'Messaging',
    description: 'Push notifications wiring.',
    provider: 'firebase',
    functionGroupId: 'messaging',
    requiredModules: ['firebase-core'],
    optionalModules: [],
    stepKeys: [],
    teardownStepKeys: [],
  },
  {
    id: 'github-repo',
    label: 'GitHub Repository',
    description: 'Repository creation and hooks.',
    provider: 'github',
    functionGroupId: 'source-control',
    requiredModules: [],
    optionalModules: [],
    stepKeys: [],
    teardownStepKeys: [],
  },
  {
    id: 'github-ci',
    label: 'GitHub CI/CD',
    description: 'Workflow and environment automation.',
    provider: 'github',
    functionGroupId: 'ci-automation',
    requiredModules: ['github-repo'],
    optionalModules: [],
    stepKeys: [],
    teardownStepKeys: [],
  },
  {
    id: 'eas-builds',
    label: 'EAS Builds',
    description: 'Build profile setup for Expo.',
    provider: 'eas',
    functionGroupId: 'mobile-release',
    requiredModules: ['github-repo'],
    optionalModules: [],
    stepKeys: [],
    teardownStepKeys: [],
  },
  {
    id: 'eas-submit',
    label: 'EAS Submit',
    description: 'Store submission automation.',
    provider: 'eas',
    functionGroupId: 'mobile-release',
    requiredModules: ['eas-builds', 'apple-signing', 'google-play-publishing'],
    optionalModules: [],
    stepKeys: [],
    teardownStepKeys: [],
  },
  {
    id: 'apple-signing',
    label: 'Apple Signing',
    description: 'Apple IDs, profiles, and keys.',
    provider: 'apple',
    functionGroupId: 'apple-distribution',
    requiredModules: [],
    optionalModules: [],
    stepKeys: [],
    teardownStepKeys: [],
  },
  {
    id: 'google-play-publishing',
    label: 'Google Play Publishing',
    description: 'Play app setup and service account.',
    provider: 'google-play',
    functionGroupId: 'google-play',
    requiredModules: ['firebase-core'],
    optionalModules: [],
    stepKeys: [],
    teardownStepKeys: [],
  },
  {
    id: 'cloudflare-domain',
    label: 'Cloudflare Domain',
    description: 'DNS and deep-link domain setup.',
    provider: 'cloudflare',
    functionGroupId: 'domain-edge',
    requiredModules: [],
    optionalModules: [],
    stepKeys: [],
    teardownStepKeys: [],
  },
  {
    id: 'oauth-social',
    label: 'OAuth Social',
    description: 'Google/Apple social auth wiring.',
    provider: 'oauth',
    functionGroupId: 'auth-identity',
    requiredModules: ['firebase-auth', 'cloudflare-domain'],
    optionalModules: [],
    stepKeys: [],
    teardownStepKeys: [],
  },
];

const TEMPLATES: ProjectTemplate[] = [
  {
    id: 'mobile-app',
    label: 'Mobile App',
    description: 'Stores, signing, EAS, push, and full CI — best for Expo / React Native shipping to iOS & Android.',
    modules: [
      'firebase-core',
      'firebase-auth',
      'firebase-firestore',
      'firebase-storage',
      'firebase-messaging',
      'github-repo',
      'github-ci',
      'eas-builds',
      'eas-submit',
      'apple-signing',
      'google-play-publishing',
      'cloudflare-domain',
      'oauth-social',
    ],
  },
  {
    id: 'web-app',
    label: 'Web App',
    description: 'Auth, data, GitHub automation, and domain — without mobile store or EAS modules.',
    modules: [
      'firebase-core',
      'firebase-auth',
      'firebase-firestore',
      'firebase-storage',
      'github-repo',
      'github-ci',
      'cloudflare-domain',
      'oauth-social',
    ],
  },
  {
    id: 'custom',
    label: 'Custom',
    description: 'Start from scratch and toggle only the capabilities you need.',
    modules: [],
  },
];

/** Display order for capability sections (foundation → data → auth → delivery). */
const FUNCTION_GROUP_ORDER: ModuleFunctionGroupId[] = [
  'cloud-foundation',
  'persistent-store',
  'object-storage',
  'messaging',
  'auth-identity',
  'domain-edge',
  'source-control',
  'ci-automation',
  'mobile-release',
  'apple-distribution',
  'google-play',
];

const FUNCTION_GROUP_STYLE: Record<
  ModuleFunctionGroupId,
  { title: string; subtitle: string; dot: string; ring: string; softBg: string }
> = {
  'cloud-foundation': {
    title: 'Cloud & project foundation',
    subtitle: 'GCP/Firebase project and service bootstrap',
    dot: 'bg-orange-500',
    ring: 'ring-orange-500/20',
    softBg: 'from-orange-500/[0.07] to-transparent',
  },
  'persistent-store': {
    title: 'Persistent store',
    subtitle: 'Structured application data',
    dot: 'bg-emerald-500',
    ring: 'ring-emerald-500/20',
    softBg: 'from-emerald-500/[0.07] to-transparent',
  },
  'object-storage': {
    title: 'Object & file storage',
    subtitle: 'User files, media, and bucket rules',
    dot: 'bg-cyan-500',
    ring: 'ring-cyan-500/20',
    softBg: 'from-cyan-500/[0.07] to-transparent',
  },
  messaging: {
    title: 'Messaging & push',
    subtitle: 'FCM and notification wiring',
    dot: 'bg-sky-500',
    ring: 'ring-sky-500/20',
    softBg: 'from-sky-500/[0.07] to-transparent',
  },
  'auth-identity': {
    title: 'Authentication & identity',
    subtitle: 'Sign-in providers and social OAuth',
    dot: 'bg-violet-500',
    ring: 'ring-violet-500/20',
    softBg: 'from-violet-500/[0.07] to-transparent',
  },
  'domain-edge': {
    title: 'Domain & edge',
    subtitle: 'DNS, SSL, and deep-link hosting',
    dot: 'bg-amber-500',
    ring: 'ring-amber-500/20',
    softBg: 'from-amber-500/[0.07] to-transparent',
  },
  'source-control': {
    title: 'Source control',
    subtitle: 'Repository and remotes',
    dot: 'bg-slate-500 dark:bg-slate-400',
    ring: 'ring-slate-500/20',
    softBg: 'from-slate-500/[0.07] to-transparent',
  },
  'ci-automation': {
    title: 'CI & automation',
    subtitle: 'Workflows, environments, and secrets in GitHub',
    dot: 'bg-blue-500',
    ring: 'ring-blue-500/20',
    softBg: 'from-blue-500/[0.07] to-transparent',
  },
  'mobile-release': {
    title: 'Mobile builds & submit',
    subtitle: 'EAS build profiles and store submission',
    dot: 'bg-indigo-500',
    ring: 'ring-indigo-500/20',
    softBg: 'from-indigo-500/[0.07] to-transparent',
  },
  'apple-distribution': {
    title: 'Apple signing & distribution',
    subtitle: 'Certificates, profiles, and App Store Connect',
    dot: 'bg-zinc-500',
    ring: 'ring-zinc-500/20',
    softBg: 'from-zinc-500/[0.07] to-transparent',
  },
  'google-play': {
    title: 'Google Play',
    subtitle: 'Console app, API access, and releases',
    dot: 'bg-green-500',
    ring: 'ring-green-500/20',
    softBg: 'from-green-500/[0.07] to-transparent',
  },
};

function resolveDependencies(input: ModuleId[]): ModuleId[] {
  const byId = new Map(MODULES.map((m) => [m.id, m]));
  const seen = new Set<ModuleId>();
  const visiting = new Set<ModuleId>();

  const walk = (id: ModuleId) => {
    if (seen.has(id)) return;
    if (visiting.has(id)) throw new Error(`Circular module dependency at ${id}`);
    const module = byId.get(id);
    if (!module) return;
    visiting.add(id);
    for (const required of module.requiredModules) walk(required);
    visiting.delete(id);
    seen.add(id);
  };

  for (const id of input) walk(id);
  return Array.from(seen);
}

/** Match loaded plan modules to a template, or `custom` if the set does not match any preset. */
export function inferTemplateIdFromModules(moduleIds: ModuleId[]): ProjectTemplateId {
  const resolved = new Set(resolveDependencies(moduleIds));
  for (const template of TEMPLATES) {
    if (template.id === 'custom') continue;
    const expected = new Set(resolveDependencies(template.modules));
    if (expected.size !== resolved.size) continue;
    let ok = true;
    for (const id of expected) {
      if (!resolved.has(id)) {
        ok = false;
        break;
      }
    }
    if (ok) return template.id;
  }
  return 'custom';
}

function templateIcon(templateId: ProjectTemplateId) {
  if (templateId === 'mobile-app') return Smartphone;
  if (templateId === 'web-app') return Globe;
  return Layers;
}

function moduleLabel(id: ModuleId): string {
  return MODULES.find((m) => m.id === id)?.label ?? id;
}

export function ModuleSelectionWizard({
  variant = 'workspace',
  selectedTemplateId,
  selectedModuleIds,
  onTemplateChange,
  onModulesChange,
  hasPendingChanges = false,
  isApplying = false,
  onApply = () => {},
  setupStepCount = null,
  savedModuleCount = null,
}: {
  /** `workspace`: full page with summary + save plan. `modal`: picker only (e.g. create project). */
  variant?: 'workspace' | 'modal';
  selectedTemplateId: ProjectTemplateId;
  selectedModuleIds: ModuleId[];
  onTemplateChange: (templateId: ProjectTemplateId, modules: ModuleId[]) => void;
  onModulesChange: (modules: ModuleId[]) => void;
  hasPendingChanges?: boolean;
  isApplying?: boolean;
  onApply?: () => void;
  setupStepCount?: number | null;
  savedModuleCount?: number | null;
}) {
  const isModal = variant === 'modal';
  const moduleById = useMemo(() => new Map(MODULES.map((m) => [m.id, m])), []);

  const selectedSet = useMemo(
    () => new Set(resolveDependencies(selectedModuleIds)),
    [selectedModuleIds],
  );

  const requiredBySelected = useMemo(() => {
    const map = new Map<ModuleId, ModuleId[]>();
    for (const moduleId of selectedSet) {
      const mod = moduleById.get(moduleId);
      if (!mod) continue;
      for (const required of mod.requiredModules) {
        const arr = map.get(required) ?? [];
        arr.push(mod.id);
        map.set(required, arr);
      }
    }
    return map;
  }, [selectedSet, moduleById]);

  const grouped = useMemo(() => {
    const byGroup = new Map<ModuleFunctionGroupId, ModuleDefinition[]>();
    for (const mod of MODULES) {
      const list = byGroup.get(mod.functionGroupId) ?? [];
      list.push(mod);
      byGroup.set(mod.functionGroupId, list);
    }
    return FUNCTION_GROUP_ORDER.map((id) => [id, byGroup.get(id) ?? []] as const).filter(
      ([, modules]) => modules.length > 0,
    );
  }, []);

  const selectedList = useMemo(
    () => MODULES.filter((m) => selectedSet.has(m.id)),
    [selectedSet],
  );

  return (
    <div className={isModal ? 'space-y-5' : 'space-y-8'}>
      {!isModal ? (
        <div className="rounded-2xl border border-border bg-gradient-to-br from-primary/[0.06] via-card to-card p-5 sm:p-6 shadow-sm">
          <div className="flex flex-col sm:flex-row sm:items-start gap-4 sm:justify-between">
            <div className="flex gap-3 min-w-0">
              <div className="shrink-0 flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/20">
                <Package size={22} strokeWidth={2} />
              </div>
              <div className="min-w-0">
                <h2 className="text-lg font-bold tracking-tight text-foreground flex items-center gap-2 flex-wrap">
                  Modules & provisioning scope
                  <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                    <Sparkles size={10} />
                    Start here
                  </span>
                </h2>
                <p className="text-sm text-muted-foreground mt-1.5 max-w-2xl leading-relaxed">
                  Choose a template, then fine-tune modules. Saving updates the{' '}
                  <span className="font-semibold text-foreground">Setup</span> tab with the matching step graph — order and
                  phases stay in sync with what you enable.
                </p>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div>
          <h2 className="text-base font-bold text-foreground">Modules</h2>
          <p className="text-xs text-muted-foreground mt-1">
            Template and optional modules for this project&apos;s provisioning plan.
          </p>
        </div>
      )}

      <section aria-labelledby="template-heading" className="space-y-3">
        <div className="flex items-end justify-between gap-3 flex-wrap">
          <div>
            <h3 id="template-heading" className="text-sm font-bold text-foreground tracking-tight">
              1 · Pick a starting template
            </h3>
            <p className="text-xs text-muted-foreground mt-0.5">Applies a curated module set; you can change it below.</p>
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {TEMPLATES.map((template) => {
            const Icon = templateIcon(template.id);
            const active = selectedTemplateId === template.id;
            const count = template.id === 'custom' ? 0 : resolveDependencies(template.modules).length;
            return (
              <button
                key={template.id}
                type="button"
                onClick={() => onTemplateChange(template.id, resolveDependencies(template.modules))}
                className={`group text-left rounded-2xl border p-4 transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
                  active
                    ? 'border-primary bg-primary/[0.07] shadow-md shadow-primary/10 ring-1 ring-primary/25'
                    : 'border-border bg-card hover:border-primary/30 hover:bg-muted/30'
                }`}
              >
                <div className="flex items-start justify-between gap-2 mb-2">
                  <span
                    className={`flex h-10 w-10 items-center justify-center rounded-xl border ${
                      active
                        ? 'border-primary/30 bg-primary/15 text-primary'
                        : 'border-border bg-muted/50 text-muted-foreground group-hover:text-foreground'
                    }`}
                  >
                    <Icon size={20} strokeWidth={2} />
                  </span>
                  {active ? (
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm">
                      <Check size={14} strokeWidth={3} />
                    </span>
                  ) : (
                    <span className="h-6 w-6 rounded-full border border-dashed border-border" aria-hidden />
                  )}
                </div>
                <p className="text-sm font-bold text-foreground">{template.label}</p>
                <p className="text-xs text-muted-foreground mt-1 leading-snug line-clamp-3">{template.description}</p>
                <div className="mt-3 flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
                  <LayoutGrid size={12} />
                  {template.id === 'custom' ? 'Build your own stack' : `${count} modules included`}
                </div>
              </button>
            );
          })}
        </div>
      </section>

      <div
        className={
          isModal
            ? 'space-y-6'
            : 'grid grid-cols-1 lg:grid-cols-[1fr,minmax(260px,300px)] gap-8 items-start'
        }
      >
        <section aria-labelledby="modules-heading" className="space-y-3 min-w-0">
          <div>
            <h3 id="modules-heading" className="text-sm font-bold text-foreground tracking-tight">
              2 · Customize modules
            </h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Grouped by capability (not vendor). Locked items are required by another selected module.
            </p>
          </div>

          <div className="space-y-4">
            {grouped.map(([groupId, modules]) => {
              const style = FUNCTION_GROUP_STYLE[groupId];
              const groupSelected = modules.filter((m) => selectedSet.has(m.id)).length;
              return (
                <div
                  key={groupId}
                  className={`rounded-2xl border border-border overflow-hidden bg-gradient-to-br ${style.softBg} to-card shadow-sm`}
                >
                  <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-border/80 bg-card/80 backdrop-blur-sm">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`h-2 w-2 rounded-full shrink-0 ${style.dot} ring-2 ${style.ring}`} aria-hidden />
                      <div className="min-w-0">
                        <span className="text-xs font-bold uppercase tracking-wider text-foreground block truncate">
                          {style.title}
                        </span>
                        <span className="text-[10px] text-muted-foreground font-medium normal-case tracking-normal line-clamp-1">
                          {style.subtitle}
                        </span>
                      </div>
                    </div>
                    <span className="text-[10px] font-bold tabular-nums text-muted-foreground bg-muted/80 px-2 py-0.5 rounded-full border border-border">
                      {groupSelected}/{modules.length}
                    </span>
                  </div>
                  <ul className="p-2 sm:p-3 grid grid-cols-1 gap-2">
                    {modules.map((mod) => {
                      const selected = selectedSet.has(mod.id);
                      const requiredBy = requiredBySelected.get(mod.id) ?? [];
                      const locked = requiredBy.length > 0 && selected;
                      const depLabels = requiredBy.map((id) => moduleLabel(id)).join(', ');
                      return (
                        <li key={mod.id}>
                          <button
                            type="button"
                            disabled={locked}
                            onClick={() => {
                              if (locked) return;
                              const next = new Set(selectedSet);
                              if (selected) next.delete(mod.id);
                              else next.add(mod.id);
                              onModulesChange(resolveDependencies(Array.from(next)));
                            }}
                            className={`w-full text-left rounded-xl border px-3 py-3 sm:px-4 transition-all ${
                              selected
                                ? 'border-primary/40 bg-primary/[0.06] shadow-sm ring-1 ring-primary/15'
                                : 'border-border/80 bg-card/60 hover:bg-muted/40 hover:border-border'
                            } ${locked ? 'opacity-[0.92] cursor-not-allowed' : ''}`}
                          >
                            <div className="flex items-start gap-3">
                              <span
                                className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2 transition-colors ${
                                  selected
                                    ? 'border-primary bg-primary text-primary-foreground'
                                    : 'border-muted-foreground/30 bg-background'
                                }`}
                                aria-hidden
                              >
                                {selected ? <Check size={12} strokeWidth={3} /> : null}
                              </span>
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="text-sm font-semibold text-foreground">{mod.label}</span>
                                  {locked ? (
                                    <span className="inline-flex items-center gap-1 rounded-md bg-amber-500/10 text-amber-800 dark:text-amber-200 px-1.5 py-px text-[10px] font-bold uppercase tracking-wide border border-amber-500/25">
                                      <Link2 size={10} />
                                      Required
                                    </span>
                                  ) : null}
                                </div>
                                <p className="text-xs text-muted-foreground mt-0.5 leading-snug">{mod.description}</p>
                                <p className="text-[10px] text-muted-foreground/70 mt-1 font-mono capitalize">
                                  {mod.provider.replace(/-/g, ' ')}
                                </p>
                                {locked ? (
                                  <p className="mt-2 text-[11px] text-amber-800/90 dark:text-amber-200/90 leading-snug">
                                    Needed by <span className="font-semibold">{depLabels}</span>
                                  </p>
                                ) : null}
                              </div>
                            </div>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
          </div>
        </section>

        {!isModal ? (
        <aside className="lg:sticky lg:top-4 space-y-3">
          <div className="rounded-2xl border border-border bg-card p-4 shadow-sm space-y-4">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Summary</p>
              <p className="text-2xl font-bold tabular-nums text-foreground mt-1">{selectedSet.size}</p>
              <p className="text-xs text-muted-foreground">modules in scope (with dependencies)</p>
            </div>
            <div className="rounded-xl bg-muted/40 border border-border/80 p-3 space-y-2 text-xs">
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">Setup steps (saved plan)</span>
                <span className="font-mono font-semibold text-foreground">
                  {setupStepCount === null ? '—' : setupStepCount}
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">Modules on server</span>
                <span className="font-mono font-semibold text-foreground">
                  {savedModuleCount === null ? '—' : savedModuleCount}
                </span>
              </div>
            </div>
            {selectedList.length > 0 ? (
              <div>
                <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-2">Selected</p>
                <ul className="max-h-48 overflow-y-auto space-y-1.5 pr-1">
                  {selectedList.map((m) => (
                    <li
                      key={m.id}
                      className="flex items-center gap-2 text-[11px] text-foreground/90 rounded-lg bg-muted/30 px-2 py-1.5 border border-border/60"
                    >
                      <Check size={11} className="text-emerald-600 dark:text-emerald-400 shrink-0" />
                      <span className="truncate font-medium">{m.label}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground italic">No modules selected. Choose a template or toggle items.</p>
            )}
          </div>

          <div
            className={`rounded-2xl border p-4 shadow-sm transition-colors ${
              hasPendingChanges
                ? 'border-primary/35 bg-primary/[0.04] ring-1 ring-primary/15'
                : 'border-border bg-card'
            }`}
          >
            <p className="text-sm font-semibold text-foreground">
              {hasPendingChanges ? 'Unsaved changes' : 'Plan matches Setup'}
            </p>
            <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
              {hasPendingChanges
                ? 'Update the server plan so the Setup tab shows the right steps and journey phases.'
                : 'Your module list matches the last saved provisioning plan.'}
            </p>
            <button
              type="button"
              disabled={!hasPendingChanges || isApplying}
              onClick={onApply}
              className="mt-4 w-full inline-flex items-center justify-center gap-2 rounded-xl bg-primary text-primary-foreground px-4 py-3 text-sm font-bold shadow-md shadow-primary/20 hover:opacity-95 disabled:opacity-40 disabled:shadow-none transition-opacity"
            >
              {isApplying ? (
                <span className="inline-block h-4 w-4 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
              ) : (
                <ArrowRight size={18} />
              )}
              {isApplying ? 'Updating plan…' : 'Save & update Setup plan'}
            </button>
            <p className="text-[10px] text-muted-foreground mt-2 flex items-center gap-1">
              <ChevronRight size={12} className="shrink-0 opacity-60" />
              After save, opens the Setup tab with the refreshed graph.
            </p>
          </div>
        </aside>
        ) : null}
      </div>
    </div>
  );
}
