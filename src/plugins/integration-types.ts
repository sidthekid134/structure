/**
 * Integration types — the top-level grouping of plugins.
 *
 * Hierarchy: **Integration → Plugin → Step**.
 *
 * - **Integration** is a top-level vendor/platform that exposes one or more
 *   plugins (e.g. GCP exposes Firebase Auth, Firestore, Storage, Messaging;
 *   Apple exposes App Store Connect signing).
 * - **Plugin** is a `PluginDefinition` (one feature inside an integration).
 * - **Step** is a `ProvisioningStepNode` owned by a plugin.
 *
 * Integration metadata is what Studio Core renders in the dependency-graph
 * swimlanes and the module picker. Adding a new integration here is the only
 * change Core needs to surface a new vendor in the UI.
 */

import type { IntegrationScope } from '../provisioning/graph.types.js';
import type { ProviderDisplayMeta } from './plugin-types.js';

export interface IntegrationDefinition {
  /** Stable identifier used in plugin.integrationId and API responses. */
  id: string;
  /** Human-readable label shown in the UI. */
  label: string;
  /** One-sentence description for the integration card. */
  description: string;
  /**
   * 'organization' = single connection at the org level (e.g. an Apple Team).
   * 'project'      = a separate connection per project (e.g. a GCP project).
   */
  scope: IntegrationScope;
  /**
   * OAuth provider id used to authenticate to this integration, when applicable.
   * Lookup key for the OAuthProvider implementation in `src/core/oauth-manager.ts`.
   */
  authProvider?: string;
  /**
   * Lucide icon name for the integration card (e.g. 'Cloud', 'Apple', 'Github').
   */
  icon?: string;
  /**
   * Color tokens for swimlanes / cards in the dependency graph. Mirrors
   * `ProviderDisplayMeta` so the UI can render either with the same shape.
   */
  displayMeta: ProviderDisplayMeta;
  /**
   * Lower-numbered integrations sort first in the UI.
   */
  order: number;
}
