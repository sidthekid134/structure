/**
 * usePluginCatalog — fetches `/api/plugin-catalog` once per page load and
 * exposes it in the shapes the existing UI components expect
 * (RegistryPlugin[], RegistryCategory[], PROVIDER_PLUGIN_MAP).
 *
 * The fetch is module-cached as a Promise singleton so multiple components
 * mounting at the same time share one network call.
 */

import { useEffect, useState } from 'react';
import {
  Activity,
  BookOpen,
  Cloud,
  Code2,
  Cpu,
  Github,
  Globe,
  KeyRound,
  Layers,
  Smartphone,
  Sparkles,
  Wrench,
} from 'lucide-react';
import { api } from './helpers';
import type {
  PluginCatalog,
  PluginCatalogEntry,
  ProviderId,
  RegistryCategory,
  RegistryPlugin,
} from './types';

// ---------------------------------------------------------------------------
// Provider id mapping (backend provider type → UI ProviderId)
// ---------------------------------------------------------------------------

/**
 * The UI's IntegrationConfig set is keyed by ('firebase', 'expo', 'github',
 * 'apple', 'cloudflare'). The backend uses provider type ids that mostly
 * match, except `eas` (UI calls it `expo`). Everything else (oauth, llm,
 * google-play) maps to 'other' — those plugins still appear in the registry
 * but render with the generic "View Plugin Contract" affordance instead of
 * an integration card.
 */
const BACKEND_TO_UI_PROVIDER_ID: Record<string, ProviderId | 'studio' | 'other'> = {
  firebase: 'firebase',
  github: 'github',
  eas: 'expo',
  apple: 'apple',
  cloudflare: 'cloudflare',
  // No first-party integration card — show as "other" so the registry card
  // falls back to "View Plugin Contract" instead of showing a connect button
  // that would point at a non-existent flow.
  oauth: 'other',
  llm: 'other',
  'google-play': 'other',
};

function mapProviderId(backendProvider: string): ProviderId | 'studio' | 'other' {
  return BACKEND_TO_UI_PROVIDER_ID[backendProvider] ?? 'other';
}

// ---------------------------------------------------------------------------
// Function group → display config
// ---------------------------------------------------------------------------

/**
 * Visual styling per backend function group id. New groups (added by future
 * plugins) get a sensible default rather than crashing the UI.
 */
const GROUP_VISUALS: Record<string, { icon: React.ElementType; color: string }> = {
  firebase: { icon: Cloud, color: 'text-orange-500' },
  github: { icon: Github, color: 'text-slate-700 dark:text-slate-300' },
  mobile: { icon: Smartphone, color: 'text-pink-500' },
  infrastructure: { icon: Globe, color: 'text-amber-500' },
  auth: { icon: KeyRound, color: 'text-violet-500' },
  ai: { icon: Sparkles, color: 'text-emerald-500' },
};

const DEFAULT_GROUP_VISUAL = { icon: Layers, color: 'text-blue-500' };

// ---------------------------------------------------------------------------
// Conversion: PluginCatalog → UI shapes
// ---------------------------------------------------------------------------

export interface ConvertedCatalog {
  /** Raw catalog as returned by the backend (kept for callers that need it). */
  raw: PluginCatalog;
  /** Plugin list in the legacy `RegistryPlugin` shape consumed by RegistryView. */
  plugins: RegistryPlugin[];
  /** Categories derived from backend `functionGroups`, ordered by `order`. */
  categories: RegistryCategory[];
  /** providerId (UI) → plugin ids backed by that integration. */
  providerPluginMap: Record<string, string[]>;
}

function convertCatalog(catalog: PluginCatalog): ConvertedCatalog {
  const plugins: RegistryPlugin[] = Object.values(catalog.modules).map(
    (entry: PluginCatalogEntry): RegistryPlugin => ({
      id: entry.id,
      name: entry.label,
      provider:
        catalog.providers.find((p) => p.id === entry.provider)?.label ?? entry.provider,
      providerId: mapProviderId(entry.provider),
      description: entry.description,
      categories: entry.functionGroupId ? [entry.functionGroupId] : [],
      version: entry.version,
    }),
  );

  // Build categories from backend-declared function groups so adding a new
  // group on the backend doesn't require a UI release.
  const categories: RegistryCategory[] = catalog.functionGroups
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((group) => {
      const visual = GROUP_VISUALS[group.id] ?? DEFAULT_GROUP_VISUAL;
      return {
        id: group.id,
        label: group.label,
        icon: visual.icon,
        color: visual.color,
        pluginIds: plugins.filter((p) => p.categories.includes(group.id)).map((p) => p.id),
      };
    });

  // Plugins that have no functionGroup (or whose group isn't surfaced in
  // functionGroups) get a synthetic "Other" bucket so they're still
  // visible — the UI's contract is "every registered plugin renders".
  const ungroupedPluginIds = plugins
    .filter((p) => p.categories.length === 0 || !categories.some((c) => c.id === p.categories[0]))
    .map((p) => p.id);
  if (ungroupedPluginIds.length > 0) {
    categories.push({
      id: '__other__',
      label: 'Other',
      icon: BookOpen,
      color: 'text-muted-foreground',
      pluginIds: ungroupedPluginIds,
    });
  }

  const providerPluginMap: Record<string, string[]> = {};
  for (const plugin of plugins) {
    if (plugin.providerId === 'studio' || plugin.providerId === 'other') continue;
    const key = plugin.providerId as string;
    (providerPluginMap[key] ??= []).push(plugin.id);
  }

  return { raw: catalog, plugins, categories, providerPluginMap };
}

// ---------------------------------------------------------------------------
// Module-level cache: one in-flight fetch shared across all callers
// ---------------------------------------------------------------------------

let cachedPromise: Promise<ConvertedCatalog> | null = null;

async function loadCatalog(): Promise<ConvertedCatalog> {
  if (!cachedPromise) {
    cachedPromise = api<PluginCatalog>('/api/plugin-catalog')
      .then(convertCatalog)
      .catch((err) => {
        // Reset the cache on failure so a re-mount can retry instead of
        // perpetually returning the stale rejection.
        cachedPromise = null;
        throw err;
      });
  }
  return cachedPromise;
}

/**
 * Forces the next `usePluginCatalog()` call to hit the network again.
 * Useful after a plugin install/uninstall flow lands.
 */
export function invalidatePluginCatalog(): void {
  cachedPromise = null;
}

// ---------------------------------------------------------------------------
// React hook
// ---------------------------------------------------------------------------

export interface UsePluginCatalogResult {
  catalog: ConvertedCatalog | null;
  loading: boolean;
  error: Error | null;
  reload: () => void;
}

export function usePluginCatalog(): UsePluginCatalogResult {
  const [catalog, setCatalog] = useState<ConvertedCatalog | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loadKey, setLoadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    loadCatalog()
      .then((next) => {
        if (cancelled) return;
        setCatalog(next);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err);
      });
    return () => {
      cancelled = true;
    };
  }, [loadKey]);

  return {
    catalog,
    loading: catalog === null && error === null,
    error,
    reload: () => {
      invalidatePluginCatalog();
      setLoadKey((k) => k + 1);
    },
  };
}

// ---------------------------------------------------------------------------
// Re-exports of the icon set used above so callers can build matching UIs
// (kept here so the export surface of helpers stays small).
// ---------------------------------------------------------------------------

export const PLUGIN_CATALOG_ICONS = {
  Activity,
  Code2,
  Cpu,
  Wrench,
};
