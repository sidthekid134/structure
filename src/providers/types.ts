/**
 * Core types for the cloud provider integration framework.
 *
 * Defines the ProviderAdapter<T> generic interface and all related schemas
 * that provider adapters must implement.
 */

import { CredentialError } from '../types.js';

export const PLATFORM_CORE_VERSION = '1.0';

// ---------------------------------------------------------------------------
// Provider type literals
// ---------------------------------------------------------------------------

/**
 * Open branded string — built-in providers plus any plugin-contributed ones.
 * Use BuiltinProviderType for exhaustive checks against the built-in set.
 */
export type ProviderType = string & { readonly __brand?: 'ProviderType' };

export const BUILTIN_PROVIDERS = [
  'firebase',
  'github',
  'eas',
  'apple',
  'google-play',
  'cloudflare',
  'oauth',
] as const;

export type BuiltinProviderType = (typeof BUILTIN_PROVIDERS)[number];

/** @deprecated Use globalPluginRegistry.getProviders() for the full set including plugin providers */
export const PROVIDER_TYPES: readonly string[] = BUILTIN_PROVIDERS;

/** @deprecated Use globalPluginRegistry.resolveProviderOrder() */
export const PROVIDER_DEPENDENCY_ORDER: readonly string[] = [
  'firebase',
  'github',
  'eas',
  'apple',
  'google-play',
  'cloudflare',
  'oauth',
] as const;

// ---------------------------------------------------------------------------
// Shared supporting types
// ---------------------------------------------------------------------------

export type Environment = 'development' | 'preview' | 'production';

export interface BranchProtectionRule {
  branch: string;
  require_reviews: boolean;
  dismiss_stale_reviews: boolean;
  require_status_checks: boolean;
}

// ---------------------------------------------------------------------------
// Provider-specific manifest configs (discriminated union by `provider`)
// ---------------------------------------------------------------------------

export type FirebaseService =
  | 'auth'
  | 'firestore'
  | 'storage'
  | 'fcm'
  | 'analytics'
  | 'crashlytics'
  | 'remote-config'
  | 'app-check'
  | 'vertex-ai';

export interface FirebaseManifestConfig {
  readonly provider: 'firebase';
  project_name: string;
  billing_account_id: string;
  services: FirebaseService[];
  environment: Environment;
  existing_project_id?: string;
}

export interface GitHubManifestConfig {
  readonly provider: 'github';
  repo_name: string;
  owner: string;
  branch_protection_rules: BranchProtectionRule[];
  environments: Environment[];
  workflow_templates: string[];
  existing_repo_id?: string;
}

export interface EasManifestConfig {
  readonly provider: 'eas';
  project_name: string;
  organization?: string;
  environments: Environment[];
  /** iOS bundle id from the Studio project — used when wiring App Store Connect API key in Expo for EAS Submit. */
  bundle_id?: string;
  /** Android application id — defaults to bundle_id when not set separately. */
  android_package?: string;
}

export interface AppleManifestConfig {
  readonly provider: 'apple';
  bundle_id: string;
  team_id: string;
  app_name: string;
  enable_apns: boolean;
  certificate_type: 'development' | 'distribution';
}

export interface GooglePlayManifestConfig {
  readonly provider: 'google-play';
  package_name: string;
  app_title: string;
  default_language: string;
}

export interface CloudflareManifestConfig {
  readonly provider: 'cloudflare';
  domain: string;
  zone_domain?: string;
  domain_mode?: 'zone-root' | 'subdomain';
  dns_record_name?: string;
  deep_link_routes: string[];
  ssl_mode: 'full' | 'flexible' | 'strict';
}

export interface OAuthManifestConfig {
  readonly provider: 'oauth';
  oauth_provider: 'google' | 'github' | 'apple';
  redirect_uri: string;
  scopes: string[];
  firebase_project_id: string;
}

/** Catch-all config for plugin-contributed providers not in the built-in set. */
export interface CustomProviderConfig {
  readonly provider: string;
  [key: string]: unknown;
}

export type ProviderConfig =
  | FirebaseManifestConfig
  | GitHubManifestConfig
  | EasManifestConfig
  | AppleManifestConfig
  | GooglePlayManifestConfig
  | CloudflareManifestConfig
  | OAuthManifestConfig
  | CustomProviderConfig;

// ---------------------------------------------------------------------------
// Provider manifest (top-level document)
// ---------------------------------------------------------------------------

export interface ProviderManifest {
  version: string;
  app_id: string;
  providers: ProviderConfig[];
}

// ---------------------------------------------------------------------------
// Provider state — live representation after provisioning
// ---------------------------------------------------------------------------

export interface CredentialMetadata {
  name: string;
  download_window_closed?: boolean;
  pending_manual_upload?: boolean;
  stored_at?: number;
}

export interface ProviderState {
  provider_id: string;
  provider_type: ProviderType;
  resource_ids: Record<string, string>;
  config_hashes: Record<string, string>;
  credential_metadata: Record<string, CredentialMetadata>;
  partially_complete: boolean;
  failed_steps: string[];
  completed_steps: string[];
  created_at: number;
  updated_at: number;
}

// ---------------------------------------------------------------------------
// Drift report
// ---------------------------------------------------------------------------

export type ConflictType =
  | 'missing_in_live'
  | 'missing_in_manifest'
  | 'value_mismatch'
  | 'orphaned_resource';

export interface DriftDifference {
  field: string;
  manifest_value: unknown;
  live_value: unknown;
  conflict_type: ConflictType;
}

export interface DriftReport {
  provider_id: string;
  provider_type: ProviderType;
  manifest_state: ProviderConfig;
  live_state: ProviderState | null;
  differences: DriftDifference[];
  orphaned_resources: string[];
  requires_user_decision: boolean;
}

// ---------------------------------------------------------------------------
// Reconcile direction
// ---------------------------------------------------------------------------

export type ReconcileDirection = 'manifest→live' | 'live→manifest';

/**
 * How a step invocation should behave:
 * - create: default idempotent provision path
 * - refresh: force regeneration/rebinding for steps that support rotation
 */
export type StepExecutionIntent = 'create' | 'refresh';

// ---------------------------------------------------------------------------
// Provider adapter interface
// ---------------------------------------------------------------------------

// Forward-reference the step types to avoid circular imports
export interface StepContext {
  projectId: string;
  environment: string;
  upstreamResources: Record<string, string>;
  vaultRead: (key: string) => Promise<string | null>;
  vaultWrite: (key: string, value: string) => Promise<void>;
  executionIntent?: StepExecutionIntent;
}

export interface StepResult {
  status: 'completed' | 'failed' | 'waiting-on-user';
  resourcesProduced: Record<string, string>;
  error?: string;
  userPrompt?: string;
}

export interface ProviderAdapter<T extends ProviderConfig> {
  /**
   * Creates or updates cloud resources to match the given config.
   * Must be idempotent — calling twice should not create duplicate resources.
   * Retained for backward compatibility with the provider-level orchestrator.
   */
  provision(config: T): Promise<ProviderState>;

  /**
   * Executes a single named step within this provider.
   * The step key matches the keys defined in the step catalog (step-registry.ts).
   * stepContext carries upstream resources from previously completed steps.
   */
  executeStep?(stepKey: string, config: T, context: StepContext): Promise<StepResult>;

  /**
   * Checks whether a previously provisioned step still exists in the live
   * environment. Returns the same shape as StepResult: status 'completed'
   * with resourcesProduced when the resource is found, or 'failed' when
   * it is missing / cannot be verified.
   *
   * Adapters that don't implement this fall back to a no-op (assumed not-checked).
   */
  checkStep?(stepKey: string, config: T, context: StepContext): Promise<StepResult>;

  /**
   * Compares the manifest config against live provider state and
   * returns a DriftReport describing any differences.
   */
  validate(manifest: T, liveState: ProviderState | null): Promise<DriftReport>;

  /**
   * Reconciles differences between manifest and live state in the given direction.
   */
  reconcile(report: DriftReport, direction: ReconcileDirection): Promise<ProviderState>;

  /**
   * Extracts credentials from the provisioned state as an encrypted key-value map.
   */
  extractCredentials(state: ProviderState): Promise<Record<string, string>>;
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/** Thrown when a provider adapter operation fails. */
export class AdapterError extends CredentialError {
  constructor(
    message: string,
    public readonly provider_id: string,
    operation: string,
    public readonly underlying_error?: unknown,
  ) {
    super(message, operation, provider_id);
    this.name = 'AdapterError';
  }
}

/** Structured error with user-facing and developer-facing messages. */
export interface StructuredError {
  error_code: string;
  user_message: string;
  developer_message: string;
  suggestion: string;
}
