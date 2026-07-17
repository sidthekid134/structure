import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ArrowRight,
  Check,
  ChevronRight,
  Globe,
  LayoutGrid,
  Layers,
  Lock,
  Package,
  Plus,
  Smartphone,
  Sparkles,
  Unlock,
} from 'lucide-react';
import { usePluginCatalog } from './usePluginCatalog';
import { ProviderLogo, providerBrandColor } from './ProviderLogo';
import type {
  ModuleDefinition,
  ModuleFunctionGroupId,
  ModuleId,
  ModuleHintKind,
  ProjectTemplate,
  ProjectTemplateId,
} from './types';

// ---------------------------------------------------------------------------
// Catalog conversion (live /api/plugin-catalog → wizard data shapes)
// ---------------------------------------------------------------------------

/**
 * Fallback `custom` template used only when the plugin catalog hasn't loaded
 * yet. The backend's plugin registry registers an authoritative `custom`
 * template (see `registerBuiltinPlugins()` in `src/plugins/builtin/index.ts`),
 * which the UI passes through unchanged once `pluginCatalog` is available.
 */
const CUSTOM_TEMPLATE_FALLBACK: ProjectTemplate = {
  id: 'custom',
  label: 'Custom',
  description: 'Start from scratch and toggle only the capabilities you need.',
  modules: [],
};

interface FunctionGroupVisual {
  title: string;
  subtitle: string;
  /** Tailwind background utility for the swatch dot. */
  dot: string;
  /** Raw HSL color used for SVG stroke gradients. */
  accent: string;
  /** Tailwind text-color utility for soft chip text. */
  text: string;
  /** Tailwind ring color utility for selected halos. */
  ring: string;
  /** Tailwind border color utility for selected outlines. */
  border: string;
}

/**
 * Per-backend-group visual styling. Keys must match `functionGroup.id` values
 * declared on the backend plugins (see src/plugins/builtin/*.plugin.ts). New
 * groups land in DEFAULT_GROUP_VISUAL automatically until styled below.
 */
const FUNCTION_GROUP_VISUALS: Record<string, FunctionGroupVisual> = {
  firebase: {
    title: 'Firebase',
    subtitle: 'Firebase app services and app registration',
    dot: 'bg-orange-500',
    accent: 'hsl(25 95% 53%)',
    text: 'text-orange-600 dark:text-orange-400',
    ring: 'ring-orange-500/30',
    border: 'border-orange-500/50',
  },
  github: {
    title: 'GitHub',
    subtitle: 'Source repository and CI/CD automation',
    dot: 'bg-slate-500 dark:bg-slate-400',
    accent: 'hsl(215 16% 47%)',
    text: 'text-slate-600 dark:text-slate-300',
    ring: 'ring-slate-500/30',
    border: 'border-slate-500/50',
  },
  mobile: {
    title: 'Mobile & App Stores',
    subtitle: 'Mobile build, signing, and store publishing',
    dot: 'bg-pink-500',
    accent: 'hsl(330 81% 60%)',
    text: 'text-pink-600 dark:text-pink-400',
    ring: 'ring-pink-500/30',
    border: 'border-pink-500/50',
  },
  infrastructure: {
    title: 'Infrastructure',
    subtitle: 'Domain, SSL, and edge network configuration',
    dot: 'bg-amber-500',
    accent: 'hsl(38 92% 50%)',
    text: 'text-amber-600 dark:text-amber-400',
    ring: 'ring-amber-500/30',
    border: 'border-amber-500/50',
  },
  auth: {
    title: 'Authentication',
    subtitle: 'Social sign-in and OAuth configuration',
    dot: 'bg-violet-500',
    accent: 'hsl(263 70% 50%)',
    text: 'text-violet-600 dark:text-violet-400',
    ring: 'ring-violet-500/30',
    border: 'border-violet-500/50',
  },
  ai: {
    title: 'AI & LLMs',
    subtitle: 'Model providers and inference endpoints',
    dot: 'bg-emerald-500',
    accent: 'hsl(160 84% 39%)',
    text: 'text-emerald-600 dark:text-emerald-400',
    ring: 'ring-emerald-500/30',
    border: 'border-emerald-500/50',
  },
};

const DEFAULT_GROUP_VISUAL: FunctionGroupVisual = {
  title: 'Other',
  subtitle: 'Modules without an assigned capability group',
  dot: 'bg-muted-foreground/40',
  accent: 'hsl(215 16% 47%)',
  text: 'text-muted-foreground',
  ring: 'ring-muted-foreground/20',
  border: 'border-muted-foreground/30',
};

function getGroupVisual(groupId: string | undefined): FunctionGroupVisual {
  if (!groupId) return DEFAULT_GROUP_VISUAL;
  return FUNCTION_GROUP_VISUALS[groupId] ?? DEFAULT_GROUP_VISUAL;
}

/**
 * Returns the requested module ids plus the transitive closure of their
 * `requiredModules`, in dependency-respecting order. Operates against a
 * caller-supplied module list (sourced from the live catalog).
 */
function resolveDependencies(input: ModuleId[], modules: ModuleDefinition[]): ModuleId[] {
  const byId = new Map(modules.map((m) => [m.id, m]));
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

/**
 * Match the saved plan's module set against the available templates and
 * return the matching template id, falling back to `'custom'` when nothing
 * matches. Caller passes the live template + module lists from the catalog
 * so this is decoupled from any hardcoded fixtures.
 */
export function inferTemplateIdFromModules(
  moduleIds: ModuleId[],
  templates: ProjectTemplate[],
  modules: ModuleDefinition[],
): ProjectTemplateId {
  const resolved = new Set(resolveDependencies(moduleIds, modules));
  for (const template of templates) {
    if (template.id === 'custom') continue;
    const expected = new Set(resolveDependencies(template.modules, modules));
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
  return 'custom' as ProjectTemplateId;
}

function templateIcon(templateId: ProjectTemplateId) {
  if (templateId === 'mobile-app') return Smartphone;
  if (templateId === 'web-app') return Globe;
  return Layers;
}

function templateBadge(templateId: ProjectTemplateId): { label: string; className: string } {
  if (templateId === 'mobile-app') {
    return {
      label: 'Verified',
      className:
        'border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
    };
  }
  if (templateId === 'custom') {
    return {
      label: 'Experimental',
      className:
        'border-violet-500/35 bg-violet-500/10 text-violet-700 dark:text-violet-300',
    };
  }
  return {
    label: 'TBD',
    className: 'border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  };
}

function platformLabel(platform: string): string {
  if (platform === 'ios') return 'iOS';
  if (platform === 'android') return 'Android';
  return platform;
}

function hintBadge(kind: ModuleHintKind): { label: string; className: string } {
  if (kind === 'requires') {
    return {
      label: 'Requires',
      className: 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300',
    };
  }
  if (kind === 'recommends') {
    return {
      label: 'Works with',
      className: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300',
    };
  }
  if (kind === 'platform') {
    return {
      label: 'Platform',
      className: 'border-pink-500/30 bg-pink-500/10 text-pink-700 dark:text-pink-300',
    };
  }
  return {
    label: 'Scope',
    className: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  };
}

/**
 * Compute the depth tier for each module in the DAG (0 = no deps, 1 =
 * depends on tier-0, etc.). Pure: takes the modules slice in.
 */
function computeModuleTiers(mods: ModuleDefinition[]): Map<ModuleId, number> {
  const byId = new Map(mods.map((m) => [m.id, m]));
  const cache = new Map<ModuleId, number>();

  const getTier = (id: ModuleId): number => {
    const cached = cache.get(id);
    if (cached !== undefined) return cached;
    const mod = byId.get(id);
    if (!mod || mod.requiredModules.length === 0) {
      cache.set(id, 0);
      return 0;
    }
    cache.set(id, 0); // cycle guard
    const depth = Math.max(...mod.requiredModules.map(getTier)) + 1;
    cache.set(id, depth);
    return depth;
  };

  for (const m of mods) getTier(m.id);
  return cache;
}

// ---------------------------------------------------------------------------
// Layout: free-flowing layered DAG (no grid, no rigid columns)
// ---------------------------------------------------------------------------

const NODE_WIDTH = 220;
/** Approximate rendered card height used for arrow anchor points and spacing.
 * Locked/blocked cards still carry a one-line hint so keep this generous. */
const NODE_HEIGHT = 96;
const HORIZONTAL_PADDING = 56;
const VERTICAL_PADDING = 44;
const MIN_VERTICAL_SPACING = 116;
/** Inter-tier horizontal gap (right-edge of src column → left-edge of dst). */
const TIER_GAP = 120;
const MIN_CANVAS_HEIGHT = 480;
const MIN_CANVAS_WIDTH = 820;

interface NodePosition {
  x: number;
  y: number;
}

interface CanvasLayout {
  positions: Map<ModuleId, NodePosition>;
  width: number;
  height: number;
}

/**
 * Sugiyama-style layered layout: x is determined by dependency tier, y is
 * the average of each module's parent y values with collision avoidance.
 * This produces an organic-feeling DAG without rigid columns.
 */
function computeCanvasLayout(
  modules: ModuleDefinition[],
  tiers: Map<ModuleId, number>,
  containerWidth: number,
  groupOrder: ModuleFunctionGroupId[],
): CanvasLayout {
  const positions = new Map<ModuleId, NodePosition>();
  if (modules.length === 0) {
    return { positions, width: Math.max(containerWidth, MIN_CANVAS_WIDTH), height: MIN_CANVAS_HEIGHT };
  }

  const tierGroups = new Map<number, ModuleDefinition[]>();
  for (const mod of modules) {
    const t = tiers.get(mod.id) ?? 0;
    if (!tierGroups.has(t)) tierGroups.set(t, []);
    tierGroups.get(t)!.push(mod);
  }
  const tierKeys = Array.from(tierGroups.keys()).sort((a, b) => a - b);
  const numTiers = tierKeys.length;

  const groupRank = (id: ModuleFunctionGroupId): number => {
    const idx = groupOrder.indexOf(id);
    return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
  };

  // Width: each column is NODE_WIDTH wide; columns are separated by TIER_GAP.
  const requiredWidth =
    numTiers * NODE_WIDTH + (numTiers - 1) * TIER_GAP + 2 * HORIZONTAL_PADDING;
  const width = Math.max(containerWidth, MIN_CANVAS_WIDTH, requiredWidth);

  // Height: enough for the densest tier given vertical spacing.
  const maxInTier = Math.max(...Array.from(tierGroups.values()).map((m) => m.length));
  const height = Math.max(
    MIN_CANVAS_HEIGHT,
    maxInTier * MIN_VERTICAL_SPACING + 2 * VERTICAL_PADDING,
  );
  const usableHeight = height - 2 * VERTICAL_PADDING - NODE_HEIGHT;

  // Columns are evenly spaced — no jitter so arrows stay clean.
  const colXFor = (tierIndex: number): number => {
    if (numTiers === 1) return width / 2 - NODE_WIDTH / 2;
    return HORIZONTAL_PADDING + tierIndex * (NODE_WIDTH + TIER_GAP);
  };

  for (let i = 0; i < tierKeys.length; i++) {
    const tier = tierKeys[i];
    const x = colXFor(i);
    const mods = tierGroups.get(tier)!;

    // Determine target y for each module:
    //  - tier 0 (or anything with no resolved parent positions): spread evenly
    //  - otherwise: average y of dependency positions
    type Item = { mod: ModuleDefinition; targetY: number; secondary: number };
    const items: Item[] = mods.map((mod) => {
      const parentYs = mod.requiredModules
        .map((d) => positions.get(d)?.y)
        .filter((y): y is number => typeof y === 'number');
      const targetY =
        parentYs.length > 0
          ? parentYs.reduce((a, b) => a + b, 0) / parentYs.length
          : Number.NaN;
      return {
        mod,
        targetY,
        secondary: groupRank(mod.functionGroupId),
      };
    });

    // For modules with no resolved parents, spread them evenly across the
    // canvas height in a stable order (group rank, then label) so they don't
    // collapse onto each other.
    const orphans = items.filter((it) => Number.isNaN(it.targetY));
    if (orphans.length > 0) {
      orphans.sort(
        (a, b) =>
          a.secondary - b.secondary ||
          a.mod.label.localeCompare(b.mod.label),
      );
      const denom = Math.max(orphans.length, 1);
      orphans.forEach((it, idx) => {
        const t = orphans.length === 1 ? 0.5 : idx / (denom - 1);
        it.targetY = VERTICAL_PADDING + t * usableHeight;
      });
    }

    // Sort by target y, then group rank, then label for stable layout.
    items.sort(
      (a, b) =>
        a.targetY - b.targetY ||
        a.secondary - b.secondary ||
        a.mod.label.localeCompare(b.mod.label),
    );

    // Resolve vertical collisions: enforce MIN_VERTICAL_SPACING from above,
    // then nudge the whole column upward if it overflowed past the bottom.
    let cursor = -Infinity;
    const placed: Array<{ id: ModuleId; y: number }> = [];
    for (const it of items) {
      const y = Math.max(it.targetY, cursor + MIN_VERTICAL_SPACING);
      placed.push({ id: it.mod.id, y });
      cursor = y;
    }

    // Center the column vertically within usableHeight.
    if (placed.length > 0) {
      const yMin = placed[0].y;
      const yMax = placed[placed.length - 1].y;
      const colSpan = yMax - yMin;
      const targetTop = VERTICAL_PADDING + (usableHeight - colSpan) / 2;
      const offset = targetTop - yMin;
      for (const p of placed) {
        positions.set(p.id, { x, y: p.y + offset });
      }
    }
  }

  return { positions, width, height };
}

// ---------------------------------------------------------------------------
// Edge geometry helpers
// ---------------------------------------------------------------------------

interface EdgeData {
  id: string;
  srcId: ModuleId;
  dstId: ModuleId;
  srcPos: NodePosition;
  dstPos: NodePosition;
  color: string;
}

function withAlpha(hexColor: string, alphaHex: string): string {
  if (/^#[0-9a-fA-F]{6}$/.test(hexColor)) {
    return `${hexColor}${alphaHex}`;
  }
  // Fallback for non-hex values (e.g. currentColor)
  return 'hsl(var(--primary) / 0.35)';
}

function edgePath(src: NodePosition, dst: NodePosition): string {
  const x1 = src.x + NODE_WIDTH;
  const y1 = src.y + NODE_HEIGHT / 2;
  const x2 = dst.x;
  const y2 = dst.y + NODE_HEIGHT / 2;
  const dx = Math.max(48, (x2 - x1) * 0.55);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

// ---------------------------------------------------------------------------
// Main wizard
// ---------------------------------------------------------------------------

export function ModuleSelectionWizard({
  variant = 'workspace',
  selectedTemplateId,
  selectedModuleIds,
  savedModuleIds = [],
  onTemplateChange,
  onModulesChange,
  hasPendingChanges = false,
  isApplying = false,
  onApply = () => {},
}: {
  variant?: 'workspace' | 'modal';
  selectedTemplateId: ProjectTemplateId;
  selectedModuleIds: ModuleId[];
  savedModuleIds?: ModuleId[];
  onTemplateChange: (templateId: ProjectTemplateId, modules: ModuleId[]) => void;
  onModulesChange: (modules: ModuleId[]) => void;
  hasPendingChanges?: boolean;
  isApplying?: boolean;
  onApply?: () => void;
}) {
  const isModal = variant === 'modal';
  const { catalog: pluginCatalog, loading: catalogLoading, error: catalogError } = usePluginCatalog();

  // Derive the wizard-shaped module/template lists from the live catalog.
  // Until the catalog is loaded these are empty, which causes the wizard to
  // render the loading state below.
  const modules: ModuleDefinition[] = useMemo(() => {
    if (!pluginCatalog) return [];
    return Object.values(pluginCatalog.raw.modules).map((entry) => ({
      id: entry.id as ModuleId,
      label: entry.label,
      description: entry.description,
      provider: entry.provider,
      functionGroupId: (entry.functionGroupId ?? '') as ModuleFunctionGroupId,
      requiredModules: entry.requiredModules as ModuleId[],
      optionalModules: entry.optionalModules as ModuleId[],
      moduleHints: entry.moduleHints,
      platforms: entry.platforms,
      stepKeys: [],
      teardownStepKeys: [],
    }));
  }, [pluginCatalog]);

  const templates: ProjectTemplate[] = useMemo(() => {
    if (!pluginCatalog) return [CUSTOM_TEMPLATE_FALLBACK];
    return Object.values(pluginCatalog.raw.templates).map((t) => ({
      id: t.id as ProjectTemplateId,
      label: t.label,
      description: t.description,
      modules: t.modules as ModuleId[],
    }));
  }, [pluginCatalog]);

  const groupOrder: ModuleFunctionGroupId[] = useMemo(() => {
    if (!pluginCatalog) return [];
    return pluginCatalog.raw.functionGroups
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((g) => g.id as ModuleFunctionGroupId);
  }, [pluginCatalog]);

  const moduleById = useMemo(() => new Map(modules.map((m) => [m.id, m])), [modules]);
  const moduleLabel = useCallback((id: ModuleId) => moduleById.get(id)?.label ?? id, [moduleById]);

  const selectedSet = useMemo(
    () => new Set(resolveDependencies(selectedModuleIds, modules)),
    [selectedModuleIds, modules],
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

  const savedSet = useMemo(
    () => new Set(resolveDependencies(savedModuleIds, modules)),
    [savedModuleIds, modules],
  );
  const addedModules = useMemo(
    () => modules.filter((m) => selectedSet.has(m.id) && !savedSet.has(m.id)),
    [modules, selectedSet, savedSet],
  );
  const removedModules = useMemo(
    () => modules.filter((m) => savedSet.has(m.id) && !selectedSet.has(m.id)),
    [modules, selectedSet, savedSet],
  );

  // ── Layout ────────────────────────────────────────────────────────────────
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState<number>(0);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const w = el.getBoundingClientRect().width;
      setContainerWidth((prev) => (Math.abs(prev - w) > 0.5 ? w : prev));
    };
    update();
    const obs = new ResizeObserver(update);
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const tiers = useMemo(() => computeModuleTiers(modules), [modules]);

  const layout = useMemo(
    () => computeCanvasLayout(modules, tiers, containerWidth, groupOrder),
    [modules, tiers, containerWidth, groupOrder],
  );

  const edges: EdgeData[] = useMemo(() => {
    const out: EdgeData[] = [];
    for (const mod of modules) {
      const dstPos = layout.positions.get(mod.id);
      if (!dstPos) continue;
      for (const reqId of mod.requiredModules) {
        const srcPos = layout.positions.get(reqId);
        if (!srcPos) continue;
        const srcMod = moduleById.get(reqId);
        const color = srcMod
          ? providerBrandColor(srcMod.provider, srcMod.id, true)
          : DEFAULT_GROUP_VISUAL.accent;
        out.push({
          id: `${reqId}->${mod.id}`,
          srcId: reqId,
          dstId: mod.id,
          srcPos,
          dstPos,
          color,
        });
      }
    }
    return out;
  }, [modules, layout, moduleById]);

  // ── Hover preview ─────────────────────────────────────────────────────────
  // Hovering a module shows a "what will happen if I click this?" preview:
  //   * wouldAutoAdd  — unselected upstream that gets pulled in by deps
  //   * wouldUnblock  — currently-blocked downstream that becomes ready
  //   * affectedByRemove — selected downstream that loses a dep if removed
  // Hovering an already-selected module (when removable) flips into the
  // "affected by remove" preview so the chain reads symmetrically.
  const [hoveredId, setHoveredId] = useState<ModuleId | null>(null);
  const hoveredIsSelected = hoveredId ? selectedSet.has(hoveredId) : false;

  /** Transitive upstream of `id` (everything `id` depends on, directly or indirectly). */
  const transitiveUpstream = useCallback(
    (id: ModuleId): Set<ModuleId> => {
      const out = new Set<ModuleId>();
      const walk = (cur: ModuleId) => {
        const mod = moduleById.get(cur);
        if (!mod) return;
        for (const dep of mod.requiredModules) {
          if (out.has(dep)) continue;
          out.add(dep);
          walk(dep);
        }
      };
      walk(id);
      return out;
    },
    [moduleById],
  );

  /** Transitive downstream of `id` (everything that ultimately depends on `id`). */
  const transitiveDownstream = useCallback(
    (id: ModuleId): Set<ModuleId> => {
      const out = new Set<ModuleId>();
      const walk = (cur: ModuleId) => {
        for (const mod of modules) {
          if (mod.requiredModules.includes(cur) && !out.has(mod.id)) {
            out.add(mod.id);
            walk(mod.id);
          }
        }
      };
      walk(id);
      return out;
    },
    [modules],
  );

  /** Modules that would be auto-added by selecting the hovered (unselected) module. */
  const wouldAutoAdd = useMemo(() => {
    const out = new Set<ModuleId>();
    if (!hoveredId || hoveredIsSelected) return out;
    for (const dep of transitiveUpstream(hoveredId)) {
      if (!selectedSet.has(dep)) out.add(dep);
    }
    return out;
  }, [hoveredId, hoveredIsSelected, transitiveUpstream, selectedSet]);

  /**
   * Modules currently blocked (missing prereqs) that would become ready once
   * the hovered module + its auto-added dependencies are in place. Limited
   * to the hovered module's downstream so the preview stays focused.
   */
  const wouldUnblock = useMemo(() => {
    const out = new Set<ModuleId>();
    if (!hoveredId || hoveredIsSelected) return out;
    const projected = new Set(selectedSet);
    projected.add(hoveredId);
    for (const id of wouldAutoAdd) projected.add(id);
    const downstream = transitiveDownstream(hoveredId);
    for (const id of downstream) {
      if (selectedSet.has(id)) continue;
      const mod = moduleById.get(id);
      if (!mod) continue;
      const currentlyBlocked = mod.requiredModules.some((d) => !selectedSet.has(d));
      const wouldBeReady = mod.requiredModules.every((d) => projected.has(d));
      if (currentlyBlocked && wouldBeReady) out.add(id);
    }
    return out;
  }, [hoveredId, hoveredIsSelected, wouldAutoAdd, transitiveDownstream, selectedSet, moduleById]);

  /**
   * For hover on a selected module: selected downstream that would lose at
   * least one dependency if this hovered module were removed. Useful as a
   * "what depends on this?" preview.
   */
  const affectedByRemove = useMemo(() => {
    const out = new Set<ModuleId>();
    if (!hoveredId || !hoveredIsSelected) return out;
    for (const id of transitiveDownstream(hoveredId)) {
      if (selectedSet.has(id)) out.add(id);
    }
    return out;
  }, [hoveredId, hoveredIsSelected, transitiveDownstream, selectedSet]);

  /** Already-selected upstream of the hovered module (chain that's keeping it alive). */
  const activeUpstream = useMemo(() => {
    const out = new Set<ModuleId>();
    if (!hoveredId) return out;
    for (const id of transitiveUpstream(hoveredId)) {
      if (selectedSet.has(id)) out.add(id);
    }
    return out;
  }, [hoveredId, transitiveUpstream, selectedSet]);

  /** True if the module participates in the hover preview (any role). */
  const isInPreview = useCallback(
    (id: ModuleId): boolean => {
      if (!hoveredId) return false;
      return (
        id === hoveredId ||
        wouldAutoAdd.has(id) ||
        wouldUnblock.has(id) ||
        affectedByRemove.has(id) ||
        activeUpstream.has(id)
      );
    },
    [hoveredId, wouldAutoAdd, wouldUnblock, affectedByRemove, activeUpstream],
  );

  type EdgePreview = 'auto-add' | 'unlock' | 'affected' | 'active-chain' | null;

  /** Categorise a dependency edge under the current hover preview. */
  const edgePreviewRole = useCallback(
    (srcId: ModuleId, dstId: ModuleId): EdgePreview => {
      if (!hoveredId) return null;
      // "Auto-add" edges connect the hovered module's upstream chain into it.
      if (
        (dstId === hoveredId || wouldAutoAdd.has(dstId)) &&
        (wouldAutoAdd.has(srcId) || activeUpstream.has(srcId))
      ) {
        return 'auto-add';
      }
      // "Unlock" edges feed currently-blocked downstream from the hovered module.
      if (wouldUnblock.has(dstId) && (srcId === hoveredId || wouldAutoAdd.has(srcId) || selectedSet.has(srcId))) {
        return 'unlock';
      }
      // "Affected by remove" edges: hovered selected → selected downstream chain.
      if (hoveredIsSelected && affectedByRemove.has(dstId) && (srcId === hoveredId || affectedByRemove.has(srcId))) {
        return 'affected';
      }
      // Active chain still alive: selected ↔ selected within the hover scope.
      if (
        (srcId === hoveredId || isInPreview(srcId)) &&
        (dstId === hoveredId || isInPreview(dstId)) &&
        selectedSet.has(srcId) &&
        selectedSet.has(dstId)
      ) {
        return 'active-chain';
      }
      return null;
    },
    [hoveredId, hoveredIsSelected, wouldAutoAdd, wouldUnblock, affectedByRemove, activeUpstream, isInPreview, selectedSet],
  );

  // ── Loading / error states ────────────────────────────────────────────────
  if (catalogLoading && modules.length === 0) {
    return (
      <div className="rounded-2xl border border-border bg-card p-6 text-sm text-muted-foreground">
        Loading module catalog…
      </div>
    );
  }

  if (catalogError && modules.length === 0) {
    return (
      <div className="rounded-2xl border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-700 dark:text-red-300">
        Failed to load module catalog: {catalogError.message}
      </div>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────
  const selectedCount = selectedSet.size;
  const inspectedModule = hoveredId ? moduleById.get(hoveredId) : null;

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
                  Pick a template to seed the graph, then click any pulsing module to add it to your stack.
                  Each selection unlocks downstream modules — the lines show what activates what.
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

      {/* ── 1. Template picker ─────────────────────────────────────────────── */}
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
          {templates.map((template) => {
            const Icon = templateIcon(template.id);
            const active = selectedTemplateId === template.id;
            const count = template.id === 'custom' ? 0 : resolveDependencies(template.modules, modules).length;
            const badge = templateBadge(template.id);
            return (
              <button
                key={template.id}
                type="button"
                onClick={() => onTemplateChange(template.id, resolveDependencies(template.modules, modules))}
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
                <div className="mt-0.5 flex items-center justify-between gap-2">
                  <p className="text-sm font-bold text-foreground">{template.label}</p>
                  <span
                    className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${badge.className}`}
                  >
                    {badge.label}
                  </span>
                </div>
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

      {/* ── 2. Module canvas + change panel ────────────────────────────────── */}
      <div
        className={
          isModal
            ? 'space-y-6'
            : 'grid grid-cols-1 lg:grid-cols-[1fr,minmax(260px,300px)] gap-8 items-start'
        }
      >
        <section aria-labelledby="modules-heading" className="space-y-3 min-w-0">
          <div className="flex items-end justify-between gap-3 flex-wrap">
            <div>
              <h3 id="modules-heading" className="text-sm font-bold text-foreground tracking-tight">
                2 · Build your dependency graph
              </h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                Hover to preview what gets pulled in or unlocked. Click to commit.
              </p>
            </div>
            <div className="flex items-center gap-2 text-[11px] font-semibold text-muted-foreground">
              <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-1 text-primary">
                <Sparkles size={11} />
                {selectedCount} active
              </span>
            </div>
          </div>

          {/* ── Canvas ──────────────────────────────────────────────────── */}
          <div
            ref={containerRef}
            className="relative isolate rounded-2xl border border-border bg-transparent dark:bg-card/40 overflow-x-auto"
            style={{ scrollbarWidth: 'thin' }}
          >
              <div
                className="relative"
                style={{ width: layout.width, height: layout.height }}
              >
                {/* Background dot grid + soft radial spotlight */}
                <div
                  className="absolute inset-0 pointer-events-none opacity-0 dark:opacity-30"
                  style={{
                    backgroundImage:
                      'radial-gradient(circle, hsl(var(--muted-foreground) / 0.18) 1px, transparent 1px)',
                    backgroundSize: '22px 22px',
                  }}
                  aria-hidden
                />
                <div
                  className="absolute inset-0 pointer-events-none hidden dark:block"
                  style={{
                    background:
                      'radial-gradient(ellipse 60% 70% at 50% 45%, hsl(var(--primary) / 0.05), transparent 70%)',
                  }}
                  aria-hidden
                />

                {/* SVG dependency arrows */}
                <svg
                  className="absolute inset-0 pointer-events-none"
                  width={layout.width}
                  height={layout.height}
                  style={{ overflow: 'visible' }}
                  aria-hidden
                >
                  <defs>
                    <marker
                      id="dep-arrow-active"
                      markerWidth="8"
                      markerHeight="8"
                      refX="6.5"
                      refY="4"
                      orient="auto"
                      markerUnits="userSpaceOnUse"
                    >
                      <path d="M0,0 L8,4 L0,8 Z" fill="currentColor" />
                    </marker>
                    <marker
                      id="dep-arrow-dim"
                      markerWidth="6"
                      markerHeight="6"
                      refX="5"
                      refY="3"
                      orient="auto"
                      markerUnits="userSpaceOnUse"
                    >
                      <path d="M0,0 L6,3 L0,6 Z" fill="hsl(var(--muted-foreground))" opacity="0.45" />
                    </marker>
                  </defs>

                  {edges.map((edge) => {
                    const srcSelected = selectedSet.has(edge.srcId);
                    const dstSelected = selectedSet.has(edge.dstId);
                    const fullyActive = srcSelected && dstSelected;
                    const partiallyActive = srcSelected !== dstSelected;
                    const role = edgePreviewRole(edge.srcId, edge.dstId);
                    const inPreview = role !== null;
                    const dimmed = hoveredId !== null && !inPreview;
                    const d = edgePath(edge.srcPos, edge.dstPos);
                    const dstMod = moduleById.get(edge.dstId);
                    const dstBrand = dstMod
                      ? providerBrandColor(dstMod.provider, dstMod.id, true)
                      : edge.color;

                    // Preview highlighting is always the target node's brand color.
                    const ROLE_COLOR: Record<NonNullable<EdgePreview>, string> = {
                      'auto-add': dstBrand,
                      unlock: dstBrand,
                      affected: dstBrand,
                      'active-chain': edge.color,
                    };

                    if (inPreview) {
                      const stroke = ROLE_COLOR[role!];
                      return (
                        <g key={edge.id}>
                          <path
                            d={d}
                            fill="none"
                            stroke={stroke}
                            strokeWidth={3}
                            opacity={0.9}
                            markerEnd="url(#dep-arrow-active)"
                            style={{
                              transition: 'opacity 0.2s ease',
                              color: stroke,
                            }}
                          />
                          <path
                            d={d}
                            fill="none"
                            stroke={stroke}
                            strokeWidth={1.2}
                            strokeDasharray="4 8"
                            opacity={0.85}
                            style={{ animation: 'wizard-flow-dash 1.2s linear infinite' }}
                          />
                        </g>
                      );
                    }

                    if (fullyActive) {
                      return (
                        <g key={edge.id} style={{ color: edge.color }}>
                          <path
                            d={d}
                            fill="none"
                            stroke={edge.color}
                            strokeWidth={2}
                            opacity={dimmed ? 0.12 : 0.85}
                            markerEnd="url(#dep-arrow-active)"
                            style={{ transition: 'opacity 0.25s ease' }}
                          />
                          {!dimmed && (
                            <path
                              d={d}
                              fill="none"
                              stroke={edge.color}
                              strokeWidth={1}
                              strokeDasharray="4 8"
                              opacity={0.55}
                              style={{
                                animation: 'wizard-flow-dash 1.6s linear infinite',
                              }}
                            />
                          )}
                        </g>
                      );
                    }

                    return (
                      <path
                        key={edge.id}
                        d={d}
                        fill="none"
                        stroke="hsl(var(--muted-foreground))"
                        strokeWidth={1}
                        strokeDasharray={partiallyActive ? '5 4' : '3 5'}
                        opacity={dimmed ? 0.05 : partiallyActive ? 0.35 : 0.18}
                        markerEnd="url(#dep-arrow-dim)"
                        style={{ transition: 'opacity 0.25s ease' }}
                      />
                    );
                  })}
                </svg>

                {/* Module nodes */}
                {modules.map((mod, i) => {
                  const pos = layout.positions.get(mod.id);
                  if (!pos) return null;
                  const selected = selectedSet.has(mod.id);
                  const requiredBy = requiredBySelected.get(mod.id) ?? [];
                  const locked = selected && requiredBy.length > 0;
                  const missingDeps = mod.requiredModules.filter((id) => !selectedSet.has(id));
                  const blocked = !selected && missingDeps.length > 0;
                  const brandColor = providerBrandColor(mod.provider, mod.id, true);

                  // Hover preview roles. A module can only be in one of these
                  // categories (hovered itself wins, then auto-add, then unlock).
                  const isHovered = hoveredId === mod.id;
                  const isAutoAdd = wouldAutoAdd.has(mod.id);
                  const isUnlock = wouldUnblock.has(mod.id);
                  const isAffected = affectedByRemove.has(mod.id);
                  const isActiveUpstream = activeUpstream.has(mod.id);
                  const inPreview =
                    isHovered || isAutoAdd || isUnlock || isAffected || isActiveUpstream;
                  const dimmed = hoveredId !== null && !inPreview;

                  // Precompute card chrome by state. Selected gets a chunky
                  // group-tinted halo so it reads as "locked in" at a glance;
                  // preview states (auto-add / unlock / affected) overlay a
                  // bright secondary border so the user can see exactly what
                  // their hovered click would do.
                  const hasPreviewRole = isAutoAdd || isUnlock || isAffected;
                  const previewOnly = hasPreviewRole && !selected;

                  let stateChrome: string;
                  if (locked) {
                    stateChrome = 'border cursor-not-allowed';
                  } else if (selected) {
                    // Selected styling uses provider brand color (not function-group color).
                    stateChrome = 'border shadow-md shadow-black/10 cursor-pointer';
                  } else {
                    stateChrome = 'border cursor-pointer';
                  }

                  return (
                    <motion.div
                      key={mod.id}
                      className="absolute"
                      style={{
                        left: pos.x,
                        top: pos.y,
                        width: NODE_WIDTH,
                        zIndex: isHovered ? 40 : inPreview ? 30 : selected ? 20 : 10,
                      }}
                      initial={{ opacity: 0, scale: 0.92 }}
                      animate={{
                        opacity: dimmed ? 0.2 : 1,
                        scale: isHovered ? 1.05 : previewOnly ? 1.025 : 1,
                      }}
                      transition={{
                        opacity: { duration: 0.22 },
                        scale: { type: 'spring', stiffness: 320, damping: 26 },
                        delay: i * 0.02,
                      }}
                      onHoverStart={() => setHoveredId(mod.id)}
                      onHoverEnd={() => setHoveredId(null)}
                    >
                      <button
                        type="button"
                        disabled={locked}
                        onClick={() => {
                          if (locked) return;
                          const next = new Set(selectedSet);
                          if (selected) next.delete(mod.id);
                          else next.add(mod.id);
                          onModulesChange(resolveDependencies(Array.from(next), modules));
                        }}
                        title={
                          locked
                            ? 'Required by selected modules'
                            : blocked
                                ? `Click to add — ${missingDeps.map(moduleLabel).join(', ')} will be pulled in automatically`
                                : selected
                                  ? 'Click to remove'
                                  : 'Click to add'
                        }
                        className={[
                          'group relative w-full text-left rounded-2xl backdrop-blur-sm p-3 transition-all duration-200',
                          'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
                          stateChrome,
                        ].join(' ')}
                        style={{
                          minHeight: NODE_HEIGHT,
                          ...(!selected
                            ? {
                                borderColor: withAlpha(brandColor, previewOnly ? 'B8' : '8A'),
                              }
                            : {}),
                          ...(previewOnly
                            ? {
                                backgroundColor: withAlpha(brandColor, '14'),
                                boxShadow: `0 0 0 2px ${withAlpha(brandColor, '55')}`,
                              }
                            : {}),
                          ...(locked
                            ? {
                                borderColor: withAlpha(brandColor, '99'),
                                boxShadow: `0 0 0 2px ${withAlpha(brandColor, '33')}`,
                              }
                            : {}),
                          // Strong group-tinted fill when selected — gives each
                          // selected module a distinct, "energised" look that
                          // sets it apart from any unselected card. The
                          // accent-coded background is layered with the card
                          // colour so it works in light/dark.
                          ...(selected
                            ? {
                                background: `linear-gradient(135deg, ${withAlpha(brandColor, '3A')}, ${withAlpha(
                                  brandColor,
                                  '18',
                                )}), hsl(var(--card))`,
                                backgroundColor: withAlpha(brandColor, '26'),
                                borderColor: brandColor,
                                boxShadow: `0 0 0 2px ${withAlpha(brandColor, '44')}, 0 0 24px ${withAlpha(
                                  brandColor,
                                  '2E',
                                )}`,
                                filter: 'none',
                              }
                            : {}),
                          ...(!selected && !previewOnly && !locked
                            ? {
                                background: `linear-gradient(135deg, ${withAlpha(
                                  brandColor,
                                  '0F',
                                )}, transparent 72%), hsl(var(--card))`,
                                boxShadow: `inset 0 0 0 1px ${withAlpha(brandColor, '2E')}`,
                                filter: 'none',
                              }
                            : {}),
                        }}
                      >
                        {/* "Selected" corner marker: solid colored bar */}
                        {selected && (
                          <span
                            className="absolute left-0 top-3 bottom-3 w-1 rounded-r-full"
                            style={{ backgroundColor: brandColor }}
                            aria-hidden
                          />
                        )}

                        {/* Hover-preview corner badge */}
                        {previewOnly && (
                          <motion.span
                            initial={{ opacity: 0, y: -4 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ duration: 0.15 }}
                            className={[
                              'absolute -top-2 right-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider shadow-sm',
                              'text-white',
                            ].join(' ')}
                            style={{ backgroundColor: brandColor }}
                          >
                            {isAutoAdd ? (
                              <>
                                <Plus size={9} strokeWidth={3} />
                                Auto-add
                              </>
                            ) : isUnlock ? (
                              <>
                                <Unlock size={9} strokeWidth={3} />
                                Unlocks
                              </>
                            ) : (
                              <>
                                <Lock size={9} strokeWidth={3} />
                                Affected
                              </>
                            )}
                          </motion.span>
                        )}


                        {/* Provider logo watermark — bottom-right of card */}
                        <span
                          className="absolute bottom-2.5 right-3 pointer-events-none select-none"
                          style={{
                            color: providerBrandColor(mod.provider, mod.id, true),
                            opacity: selected ? 0.22 : 0.08,
                          }}
                          aria-hidden
                        >
                          <ProviderLogo provider={mod.provider} moduleId={mod.id} size={28} />
                        </span>

                        <div className="relative flex items-start gap-2.5">
                          {/* Provider logo badge (left of label row) */}
                          <span
                            className={[
                              'flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border transition-colors shadow-sm',
                              locked
                                ? 'border'
                                : selected
                                  ? 'border-transparent'
                                  : isAutoAdd
                                    ? 'border'
                                    : isUnlock
                                      ? 'border'
                                      : 'border-border/60 bg-background/70 dark:bg-muted/40',
                            ].join(' ')}
                            style={
                              selected || locked || isAutoAdd || isUnlock
                                ? {
                                    backgroundColor: withAlpha(brandColor, '22'),
                                    borderColor: withAlpha(brandColor, '66'),
                                  }
                                : undefined
                            }
                            aria-hidden
                          >
                            <span
                              style={{
                                color: providerBrandColor(mod.provider, mod.id, true),
                                opacity: selected || locked ? 1 : 0.5,
                              }}
                            >
                              <ProviderLogo provider={mod.provider} moduleId={mod.id} size={13} />
                            </span>
                          </span>

                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span
                                className={[
                                  'text-[11.5px] font-bold leading-tight truncate',
                                  selected ? 'text-foreground' : 'text-foreground',
                                ].join(' ')}
                              >
                                {mod.label}
                              </span>
                            </div>
                            <p className="text-[10px] leading-snug text-muted-foreground mt-0.5 line-clamp-2 pr-7">
                              {mod.description}
                            </p>

                            {mod.platforms && mod.platforms.length > 0 ? (
                              <div className="mt-1.5 flex flex-wrap gap-1">
                                {mod.platforms.map((platform) => (
                                  <span
                                    key={`${mod.id}-${platform}`}
                                    className="rounded-full border border-border/60 bg-background/45 px-1.5 py-0.5 text-[8.5px] font-bold uppercase tracking-wider text-muted-foreground"
                                  >
                                    {platformLabel(platform)}
                                  </span>
                                ))}
                              </div>
                            ) : null}

                            {/* Hover-preview hint copy takes priority over
                                the static state hints so the user reads what
                                their pending click would do. */}
                            {isAutoAdd ? (
                              <p
                                className="mt-1.5 text-[9.5px] font-bold leading-snug"
                                style={{ color: brandColor }}
                              >
                                Pulled in as a dependency
                              </p>
                            ) : isUnlock ? (
                              <p
                                className="mt-1.5 text-[9.5px] font-bold leading-snug"
                                style={{ color: brandColor }}
                              >
                                Becomes available
                              </p>
                            ) : isAffected ? (
                              <p
                                className="mt-1.5 text-[9.5px] font-bold leading-snug"
                                style={{ color: brandColor }}
                              >
                                Loses a prerequisite
                              </p>
                            ) : null}
                          </div>
                        </div>
                      </button>
                    </motion.div>
                  );
                })}
              </div>

            {/* Footer: state legend + hover-preview legend + group key */}
            <div className="flex flex-col gap-2 px-4 py-2.5 border-t border-border/60 bg-muted/10">
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                  <span className="text-[9px] font-bold uppercase tracking-wider text-foreground/60">
                    State
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="h-2.5 w-2.5 rounded-full bg-primary shadow-sm" />
                    Selected
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="h-2.5 w-2.5 rounded-full border border-primary/50 bg-primary/15" />
                    Locked by dependent
                  </span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                  <span className="text-[9px] font-bold uppercase tracking-wider text-foreground/60">
                    On hover
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="h-2.5 w-2.5 rounded-full border border-primary/60 bg-primary/25" />
                    Auto-add / Unlock / Affected use each node&apos;s brand color
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-2 text-[10px] text-muted-foreground/80 flex-wrap">
                <span className="text-[9px] font-bold uppercase tracking-wider text-foreground/60">
                  Capability
                </span>
                {Array.from(new Set(modules.map((m) => m.functionGroupId).filter(Boolean))).map(
                  (groupId) => {
                    const v = getGroupVisual(groupId);
                    return (
                      <span key={String(groupId)} className="inline-flex items-center gap-1">
                        <span className={`h-1.5 w-1.5 rounded-full ${v.dot}`} />
                        {v.title}
                      </span>
                    );
                  },
                )}
              </div>
            </div>

            {/* Local CSS for the animated edge dash */}
            <style>{`
              @keyframes wizard-flow-dash {
                from { stroke-dashoffset: 0; }
                to { stroke-dashoffset: -24; }
              }
            `}</style>
          </div>
        </section>

        {!isModal ? (
          <aside className="lg:sticky lg:top-4 space-y-3">
            <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
              <p className="text-sm font-semibold text-foreground">
                {inspectedModule ? inspectedModule.label : 'Module relationships'}
              </p>
              <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                {inspectedModule
                  ? inspectedModule.description
                  : 'Hover a module to see hard dependencies, paired modules, and platform-specific implications.'}
              </p>

              {inspectedModule ? (
                <div className="mt-4 space-y-4">
                  {inspectedModule.platforms && inspectedModule.platforms.length > 0 ? (
                    <div>
                      <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                        Platforms
                      </p>
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {inspectedModule.platforms.map((platform) => (
                          <span
                            key={`detail-platform-${platform}`}
                            className="rounded-md border border-pink-500/30 bg-pink-500/10 px-2 py-0.5 text-[11px] font-semibold text-pink-700 dark:text-pink-300"
                          >
                            {platformLabel(platform)}
                          </span>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {inspectedModule.requiredModules.length > 0 ? (
                    <div>
                      <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                        Required modules
                      </p>
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {inspectedModule.requiredModules.map((id) => (
                          <span
                            key={`detail-required-${id}`}
                            className="rounded-md border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-[11px] font-semibold text-red-700 dark:text-red-300"
                          >
                            {moduleLabel(id)}
                          </span>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {inspectedModule.optionalModules.length > 0 ? (
                    <div>
                      <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                        Pairs with
                      </p>
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {inspectedModule.optionalModules.map((id) => (
                          <span
                            key={`detail-optional-${id}`}
                            className="rounded-md border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-[11px] font-semibold text-sky-700 dark:text-sky-300"
                          >
                            {moduleLabel(id)}
                          </span>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {inspectedModule.moduleHints && inspectedModule.moduleHints.length > 0 ? (
                    <div className="space-y-2">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                        Notes
                      </p>
                      {inspectedModule.moduleHints.map((hint, index) => {
                        const badge = hintBadge(hint.kind);
                        return (
                          <div
                            key={`${inspectedModule.id}-hint-${index}`}
                            className="rounded-xl border border-border/70 bg-muted/20 p-3"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <p className="min-w-0 truncate text-xs font-bold text-foreground">
                                {hint.label}
                              </p>
                              <span
                                className={`shrink-0 rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide ${badge.className}`}
                              >
                                {badge.label}
                              </span>
                            </div>
                            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                              {hint.description}
                            </p>
                            {(hint.moduleIds?.length || hint.platforms?.length) ? (
                              <div className="mt-2 flex flex-wrap gap-1">
                                {hint.platforms?.map((platform) => (
                                  <span
                                    key={`${inspectedModule.id}-hint-${index}-${platform}`}
                                    className="rounded-md bg-background/60 px-1.5 py-0.5 text-[9.5px] font-semibold text-muted-foreground"
                                  >
                                    {platformLabel(platform)}
                                  </span>
                                ))}
                                {hint.moduleIds?.map((id) => (
                                  <span
                                    key={`${inspectedModule.id}-hint-${index}-${id}`}
                                    className="rounded-md bg-background/60 px-1.5 py-0.5 text-[9.5px] font-semibold text-muted-foreground"
                                  >
                                    {moduleLabel(id as ModuleId)}
                                  </span>
                                ))}
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              ) : null}
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
              <AnimatePresence initial={false}>
                {hasPendingChanges && (
                  <motion.div
                    key="diff"
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.18 }}
                    className="mt-3 space-y-2 overflow-hidden"
                  >
                    {addedModules.length > 0 && (
                      <div>
                        <p className="text-[10px] font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-300">
                          Added
                        </p>
                        <div className="mt-1 flex flex-wrap gap-1.5">
                          {addedModules.map((m) => (
                            <span
                              key={`add-${m.id}`}
                              className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-800 dark:text-emerald-200"
                            >
                              {m.label}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                    {removedModules.length > 0 && (
                      <div>
                        <p className="text-[10px] font-bold uppercase tracking-wider text-red-700 dark:text-red-300">
                          Removed
                        </p>
                        <div className="mt-1 flex flex-wrap gap-1.5">
                          {removedModules.map((m) => (
                            <span
                              key={`remove-${m.id}`}
                              className="rounded-md border border-red-500/40 bg-red-500/10 px-2 py-0.5 text-[11px] text-red-800 dark:text-red-200"
                            >
                              {m.label}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
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
