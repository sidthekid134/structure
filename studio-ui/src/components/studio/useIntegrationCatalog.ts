/**
 * useIntegrationCatalog — fetches `/api/integration-catalog` once per page
 * load and merges the result with the UI-only fields from INTEGRATION_CONFIGS
 * (logo components, logoColor, fields, docsUrl, customFlow, orgAvailability).
 *
 * The fetch is module-cached as a Promise singleton so multiple components
 * mounting at the same time share one network call.
 */

import { useEffect, useState } from 'react';
import { INTEGRATION_CONFIGS } from './constants';
import { api } from './helpers';
import type { IntegrationConfig, ProviderId } from './types';

// ---------------------------------------------------------------------------
// Backend response shape
// ---------------------------------------------------------------------------

interface BackendIntegration {
  id: string;
  label: string;
  description: string;
  scope: 'organization' | 'project';
  authProvider?: string;
  icon?: string;
  displayMeta: { primary: string; text: string; bg: string; border: string };
  order: number;
  plugins: Array<{ id: string; label: string }>;
}

interface IntegrationCatalogResponse {
  integrations: BackendIntegration[];
}

// ---------------------------------------------------------------------------
// Conversion: backend integration list → IntegrationConfig[]
// ---------------------------------------------------------------------------

function convertCatalog(response: IntegrationCatalogResponse): IntegrationConfig[] {
  return response.integrations
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((backend): IntegrationConfig => {
      // Look up UI-only fields from the static INTEGRATION_CONFIGS by id.
      const uiConfig = INTEGRATION_CONFIGS.find((c) => c.id === backend.id);

      return {
        id: backend.id as ProviderId,
        scope: backend.scope,
        name: backend.label,
        description: backend.description,
        // UI-only fields — fall back to sensible defaults when there's no
        // matching entry in INTEGRATION_CONFIGS (e.g. a new backend integration
        // added before a UI release ships the logo asset).
        logo: uiConfig?.logo ?? (() => null),
        logoColor: uiConfig?.logoColor ?? 'text-muted-foreground',
        fields: uiConfig?.fields ?? [],
        docsUrl: uiConfig?.docsUrl ?? '',
        ...(uiConfig?.customFlow !== undefined && { customFlow: uiConfig.customFlow }),
        ...(uiConfig?.orgAvailability !== undefined && { orgAvailability: uiConfig.orgAvailability }),
        ...(uiConfig?.supportsOAuth !== undefined && { supportsOAuth: uiConfig.supportsOAuth }),
      };
    });
}

// ---------------------------------------------------------------------------
// Module-level cache: one in-flight fetch shared across all callers
// ---------------------------------------------------------------------------

let cachedPromise: Promise<IntegrationConfig[]> | null = null;

async function loadCatalog(): Promise<IntegrationConfig[]> {
  if (!cachedPromise) {
    cachedPromise = api<IntegrationCatalogResponse>('/api/integration-catalog')
      .then(convertCatalog)
      .catch((err) => {
        // Reset on failure so a re-mount can retry instead of perpetually
        // returning the stale rejection.
        cachedPromise = null;
        throw err;
      });
  }
  return cachedPromise;
}

/**
 * Forces the next `useIntegrationCatalog()` call to hit the network again.
 */
export function invalidateIntegrationCatalog(): void {
  cachedPromise = null;
}

// ---------------------------------------------------------------------------
// React hook
// ---------------------------------------------------------------------------

/**
 * Returns the live integration catalog fetched from `/api/integration-catalog`,
 * merged with UI-only fields from `INTEGRATION_CONFIGS`.
 *
 * Returns `null` while loading or if the fetch fails (callers should treat
 * `null` as a loading state and render nothing or a skeleton).
 */
export function useIntegrationCatalog(): IntegrationConfig[] | null {
  const [integrations, setIntegrations] = useState<IntegrationConfig[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadCatalog()
      .then((result) => {
        if (!cancelled) setIntegrations(result);
      })
      .catch(() => {
        // On error keep integrations as null — consumers show nothing until a
        // future mount succeeds (cache was cleared by loadCatalog's .catch).
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return integrations;
}
