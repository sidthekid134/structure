/**
 * Plugin system types.
 *
 * A PluginDefinition is the single contract a module/plugin implements.
 * It declares its graph nodes, step handlers, adapter, display metadata,
 * capabilities, guided flows, and lifecycle hooks in one place.
 *
 * The PluginRegistry aggregates all definitions and provides derived views
 * to the rest of the system (step catalog, module catalog, journey phases,
 * provider schemas, UI display metadata, etc.).
 */

import type { MobilePlatform, ProvisioningStepNode, UserActionNode, CompletionPortalLink } from '../provisioning/graph.types.js';
import type { StepHandler } from '../provisioning/step-handler-registry.js';
import type { ProviderAdapter, ProviderConfig } from '../providers/types.js';
import type { FlowDefinition } from '../flows/flow-definition-types.js';
import type { NodeStatus } from '../provisioning/graph.types.js';

// ---------------------------------------------------------------------------
// Step capabilities
// ---------------------------------------------------------------------------

export interface StepCapabilities {
  /** Supports POST /plan/node/revalidate — live check against real world */
  supportsRevalidate: boolean;
  /** Supports POST /plan/node/sync — reconcile stored state */
  supportsSync: boolean;
  /** Supports automated revert (delete()) via StepHandler */
  supportsRevert: boolean;
  /** Provides manual revert instructions when automated delete is not possible */
  supportsManualRevert: boolean;
  /** Has a guided flow for manual/assisted execution */
  hasGuidedFlow: boolean;
}

// ---------------------------------------------------------------------------
// Step action descriptors (button rendering)
// ---------------------------------------------------------------------------

export type StepActionId =
  | 'run'
  | 'verify'
  | 'skip'
  | 'revert'
  | 'revalidate'
  | 'mark-done'
  | 'upload'
  | 'oauth'
  | string;

export interface StepActionDescriptor {
  id: StepActionId;
  label: string;
  /** Lucide icon name */
  icon?: string;
  variant: 'primary' | 'secondary' | 'destructive' | 'ghost';
  /** Node statuses in which this button is shown */
  visibleIn: NodeStatus[];
  /** Node statuses in which this button is enabled (subset of visibleIn) */
  enabledIn: NodeStatus[];
  requiresConfirmation?: boolean;
  confirmationMessage?: string;
}

// ---------------------------------------------------------------------------
// Display metadata
// ---------------------------------------------------------------------------

export interface PluginDisplayMeta {
  /** Lucide icon name (e.g. 'Cloud', 'Github', 'Smartphone') */
  icon: string;
  colors: {
    /** Tailwind color token e.g. 'orange-500' */
    primary: string;
    /** Full Tailwind text class e.g. 'text-orange-700 dark:text-orange-300' */
    text: string;
    /** Full Tailwind bg class e.g. 'bg-orange-500/10' */
    bg: string;
    /** Full Tailwind border class e.g. 'border-orange-500/25' */
    border: string;
  };
}

export interface ProviderDisplayMeta {
  label: string;
  color: string;
  bg: string;
  border: string;
}

// ---------------------------------------------------------------------------
// Resource display config
// ---------------------------------------------------------------------------

export type ResourcePreviewTemplate = string | ((ctx: ResourcePreviewContext) => string);

export interface ResourcePreviewContext {
  upstream: Record<string, string>;
  slug: string;
  domain: string;
  bundleId: string;
  expectedGcpId: string;
  linkedGcpId: string;
  githubOwner: string;
  easAccount: string;
  /**
   * Human-readable display name for the project. This is the same value that
   * Studio submits to provider APIs as the app/listing name (e.g. App Store
   * Connect `attributes.name`). Falls back to the slug when the project has
   * no explicit display name configured.
   */
  appName: string;
  /**
   * User-typed inputs for the *current* node, if it has any inputFields.
   * Lets previews reflect operator-supplied values (e.g. the actual App
   * Store Connect listing name when it had to differ from the project
   * name because App Store names must be globally unique).
   */
  nodeUserInputs: Record<string, string>;
}

export interface ResourceDisplayConfig {
  /** Whether to hide the raw value in the UI */
  sensitive?: boolean;
  /** Treat the produced value itself as a primary href (if it's a URL) */
  primaryLinkFromValue?: boolean;
  /** Console link pattern — {value} and {upstream.key} substitutions */
  primaryHrefTemplate?: string;
  /** Related console/docs links */
  relatedLinks?: Array<{ label: string; href?: string; hrefTemplate?: string }>;
  /**
   * Static preview text shown before the step runs (no interpolation).
   * Use previewTemplate for dynamic content.
   */
  previewText?: string;
  /**
   * Preview text shown before the step runs.
   * String template uses {slug}, {domain}, {bundleId}, {upstream.key}.
   * Function receives full context.
   */
  previewTemplate?: ResourcePreviewTemplate;
}

// ---------------------------------------------------------------------------
// Assisted step config
// ---------------------------------------------------------------------------

export interface AssistedStepConfig {
  automatedPhaseDescription?: string;
  userPhaseDescription?: string;
  fileUploadConfig?: {
    acceptedTypes: string[];
    maxSizeKb: number;
    validator: string;
  };
  timeConstraint?: {
    message: string;
    urgencyLevel: 'info' | 'warning' | 'critical';
  };
}

// ---------------------------------------------------------------------------
// Function groups (module picker UI)
// ---------------------------------------------------------------------------

export interface FunctionGroupDefinition {
  id: string;
  label: string;
  description: string;
  /** Lower = higher in the list */
  order: number;
}

// ---------------------------------------------------------------------------
// Provider metadata
// ---------------------------------------------------------------------------

export interface ProviderMetadata {
  label: string;
  scope: 'organization' | 'project';
  secretKeys: string[];
  /** Provider ids this provider depends on (for dependency ordering) */
  dependsOnProviders: string[];
  displayMeta?: ProviderDisplayMeta;
}

// ---------------------------------------------------------------------------
// Plugin registration context (passed to onRegister hook)
// ---------------------------------------------------------------------------

export interface PluginRegistrationContext {
  /**
   * Register a new journey phase that doesn't exist in the built-in set.
   * The phase will be inserted after `after` if provided, otherwise appended
   * before 'teardown'.
   */
  registerJourneyPhase(phase: {
    id: string;
    title: string;
    after?: string;
  }): void;
}

// ---------------------------------------------------------------------------
// The main plugin definition interface
// ---------------------------------------------------------------------------

export interface PluginDefinition {
  // ── Identity ────────────────────────────────────────────────────────────
  id: string;
  version: string;
  label: string;
  description: string;

  // ── Provider ────────────────────────────────────────────────────────────
  provider: string;
  /**
   * Provide this when the plugin introduces a provider not in the built-in set,
   * or to override/extend built-in provider metadata.
   */
  providerMeta?: ProviderMetadata;

  // ── Module dependency structure ─────────────────────────────────────────
  requiredModules: string[];
  optionalModules: string[];
  /** Template ids (e.g. 'mobile-app') this module should be included in by default */
  includedInTemplates?: string[];

  /**
   * Which mobile platforms this module is relevant to. Omitted = all
   * platforms. The plan builder drops this module (and its steps + user
   * actions) when its mask doesn't intersect the project's `platforms`
   * selection.
   */
  platforms?: MobilePlatform[];

  // ── Graph nodes ─────────────────────────────────────────────────────────
  steps: ProvisioningStepNode[];
  teardownSteps: ProvisioningStepNode[];
  userActions: UserActionNode[];

  // ── Step capabilities and button descriptors ─────────────────────────────
  /**
   * Override capabilities per step key.
   * Defaults are inferred from whether stepHandlers implements validate/sync/delete.
   */
  stepCapabilities?: Record<string, Partial<StepCapabilities>>;
  /**
   * Override or add button descriptors per step key.
   * The registry computes defaults from step type + automation level + capabilities.
   */
  stepActions?: Record<string, StepActionDescriptor[]>;

  // ── Step execution ───────────────────────────────────────────────────────
  stepHandlers?: StepHandler[];
  adapter?: ProviderAdapter<ProviderConfig>;

  // ── Display / UX ─────────────────────────────────────────────────────────
  /** Icon and color scheme for the module in the UI */
  displayMeta?: PluginDisplayMeta;
  /** Default journey phase for all steps in this plugin */
  defaultJourneyPhase: string;
  /** Per-step phase overrides (step key → phase id) */
  journeyPhaseOverrides?: Record<string, string>;
  /** Display config for resources produced by steps in this plugin */
  resourceDisplay?: Record<string, ResourceDisplayConfig>;
  /** Completion portal links shown when steps complete */
  completionPortalLinks?: Record<string, CompletionPortalLink[]>;
  /** Function group for the module picker UI */
  functionGroup?: FunctionGroupDefinition;

  // ── Manual / assisted step support ──────────────────────────────────────
  /** Guided flow definitions for manual/assisted steps */
  guidedFlows?: FlowDefinition[];
  /** Extra config for assisted steps (file upload, time constraints) */
  assistedStepConfigs?: Record<string, AssistedStepConfig>;

  // ── Lifecycle hooks ──────────────────────────────────────────────────────
  /** Called once when the plugin is registered — for one-time setup */
  onRegister?: (ctx: PluginRegistrationContext) => void | Promise<void>;
  /** Called when a project activates this module */
  onActivate?: (projectId: string) => void | Promise<void>;
}
