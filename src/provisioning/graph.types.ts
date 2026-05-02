/**
 * Step-level provisioning graph types.
 *
 * This module replaces the flat provider-level abstraction with a DAG of
 * ProvisioningStepNode and UserActionNode items. The orchestrator executes
 * batches of nodes in topological order, pausing when it encounters a
 * UserActionNode that requires human intervention.
 */

import type { ProviderType, StepExecutionIntent } from '../providers/types.js';

// ---------------------------------------------------------------------------
// Environment as a primary concept
// ---------------------------------------------------------------------------

export type EnvironmentScope = 'global' | 'per-environment';

export type StepDirection = 'provision' | 'teardown';

// ---------------------------------------------------------------------------
// Mobile platform tagging
// ---------------------------------------------------------------------------

/**
 * The set of mobile platforms a project can target. Steps, modules, and
 * user-action nodes may opt into a subset; an absent `platforms` mask means
 * the node applies to all platforms (i.e. it has no iOS/Android coupling).
 */
export type MobilePlatform = 'ios' | 'android';

export const ALL_MOBILE_PLATFORMS: MobilePlatform[] = ['ios', 'android'];

// ---------------------------------------------------------------------------
// Automation level
// ---------------------------------------------------------------------------

export type AutomationLevel =
  | 'full'      // system executes without user input
  | 'assisted'  // system initiates, user must complete a handoff (e.g., download a key)
  | 'manual';   // user does it entirely outside the platform

// ---------------------------------------------------------------------------
// User action categories
// ---------------------------------------------------------------------------

export type UserActionCategory =
  | 'account-enrollment'     // sign up for Apple Dev, Google Play, etc.
  | 'credential-upload'      // upload a .p8 key, service account JSON, etc.
  | 'external-configuration' // change DNS nameservers, configure something in a portal
  | 'approval';              // approve a TestFlight build, respond to review

// ---------------------------------------------------------------------------
// How the platform verifies a user action was completed
// ---------------------------------------------------------------------------

export type VerificationMethod =
  | { type: 'api-check'; description: string }
  | { type: 'credential-upload'; secretKey: string }
  | { type: 'manual-confirm' };

export type InteractiveAction =
  | { type: 'oauth'; provider: string; label: string }
  | { type: 'integration-connect'; provider: string; label: string };

// ---------------------------------------------------------------------------
// Dependency reference — points to any node in the graph
// ---------------------------------------------------------------------------

export interface DependencyRef {
  nodeKey: string;      // e.g., 'firebase:create-gcp-project' or 'user:enroll-apple-developer'
  required: boolean;
  description?: string; // why this dependency exists
}

// ---------------------------------------------------------------------------
// Resource — something a step produces that downstream steps can consume
// ---------------------------------------------------------------------------

/** Optional Studio / API metadata for how a saved resource should be shown when a step is complete. */
export interface CompletionRelatedLink {
  label: string;
  href?: string;
  /** Substitute `{value}` and `{upstream.resource_key}` (e.g. `{upstream.firebase_project_id}`). */
  hrefTemplate?: string;
}

export interface ResourceOutputPresentation {
  /** Credential-like — never surface raw value in UI. */
  sensitive?: boolean;
  /** Human-readable storage destination (e.g. "Expo EAS environment variable"). */
  destinationType?: string;
  /** Provider visibility/classification (e.g. PUBLIC, SENSITIVE, SECRET). */
  secretType?: string;
  /** How this write behaves (e.g. create-only vs upsert/overwrite). */
  writeBehavior?: string;
  /** When true and the stored value is http(s), treat it as the primary outbound link. */
  primaryLinkFromValue?: boolean;
  /** Primary console link pattern, e.g. `https://console.firebase.google.com/project/{upstream.firebase_project_id}` */
  primaryHrefTemplate?: string;
  relatedLinks?: CompletionRelatedLink[];
}

export interface ResourceOutput {
  key: string;         // e.g., 'gcp_project_id', 'clone_url'
  label: string;
  description: string;
  presentation?: ResourceOutputPresentation;
}

// ---------------------------------------------------------------------------
// Step input fields — user-configurable parameters for a step
// ---------------------------------------------------------------------------

export type StepInputFieldType = 'text' | 'select' | 'p8';

export interface StepInputField {
  key: string;
  label: string;
  description?: string;
  type: StepInputFieldType;
  placeholder?: string;
  /**
   * Default value shown in the UI. Supports project tokens that are resolved
   * server-side before sending to the frontend:
   *   {slug}     — project slug / resource name
   *   {bundleId} — app bundle ID (e.g. com.example.myapp)
   *   {domain}   — app domain (e.g. myapp.example.com)
   *   {name}     — project display name
   */
  defaultValue?: string;
  options?: string[];
  required?: boolean;
}

/** Shown when a node is complete — docs, consoles (static or templated). */
export interface CompletionPortalLink {
  label: string;
  href?: string;
  hrefTemplate?: string;
}

// ---------------------------------------------------------------------------
// The two node types in the provisioning graph
// ---------------------------------------------------------------------------

export interface UserActionNode {
  type: 'user-action';
  key: string;             // e.g., 'user:enroll-apple-developer'
  label: string;
  description: string;
  category: UserActionCategory;
  provider?: ProviderType;
  verification: VerificationMethod;
  /** When set, the UI can offer a one-click flow (e.g. OAuth) alongside manual verification. */
  interactiveAction?: InteractiveAction;
  helpUrl?: string;
  dependencies: DependencyRef[];
  produces: ResourceOutput[];
  /** Optional links to portals/docs once this action is satisfied. */
  completionPortalLinks?: CompletionPortalLink[];
  /** Optional tie-break within the same topological layer (lower runs first). */
  orderHint?: number;
  /**
   * Which mobile platforms this action applies to. Omitted = all platforms.
   * The plan builder drops user actions whose platform mask doesn't intersect
   * the project's `platforms` selection.
   */
  platforms?: MobilePlatform[];
}

export interface ProvisioningStepNode {
  type: 'step';
  key: string;             // e.g., 'firebase:create-gcp-project'
  label: string;
  description: string;
  provider: ProviderType;
  environmentScope: EnvironmentScope;
  automationLevel: AutomationLevel;
  dependencies: DependencyRef[];
  produces: ResourceOutput[];
  estimatedDurationMs?: number;
  bridgeTarget?: ProviderType; // non-null = this step writes to another provider
  direction?: StepDirection;
  teardownOf?: string;
  /** Optional links to consoles/docs when this step has finished successfully. */
  completionPortalLinks?: CompletionPortalLink[];
  /** Optional one-click flow (e.g. OAuth) before running this automated step. */
  interactiveAction?: InteractiveAction;
  /** Optional tie-break within the same topological layer (lower runs first). */
  orderHint?: number;
  /** Configurable input fields — user-provided parameters for this step. */
  inputFields?: StepInputField[];
  /**
   * When any listed node key completes successfully, this step is considered
   * stale and should be reset to not-started before the next execution.
   */
  refreshTriggers?: string[];
  /**
   * Which mobile platforms this step applies to. Omitted = all platforms.
   * The plan builder drops steps whose platform mask doesn't intersect the
   * project's `platforms` selection. Required dependencies on filtered-out
   * upstream nodes are silently relaxed so that platform-specific cousins
   * don't block their cross-platform peers.
   */
  platforms?: MobilePlatform[];
  /**
   * Env var keys this step writes/updates in a downstream build system.
   * Used by UI to preview exact key names before execution.
   */
  managedEnvKeys?: string[];
}

export type ProvisioningNode = UserActionNode | ProvisioningStepNode;

// ---------------------------------------------------------------------------
// Node execution state
// ---------------------------------------------------------------------------

export type NodeStatus =
  | 'not-started'
  | 'blocked'         // dependencies not met
  | 'ready'           // all deps met, can execute
  | 'in-progress'
  | 'waiting-on-user' // user action pending
  | 'resolving'       // gate auto-resolution in progress
  | 'completed'
  | 'failed'
  | 'skipped';

export interface NodeState {
  nodeKey: string;
  status: NodeStatus;
  environment?: string;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  /** Operator guidance when a step pauses in waiting-on-user status. */
  userPrompt?: string;
  resourcesProduced?: Record<string, string>;
  /** User-provided input values for steps with inputFields. */
  userInputs?: Record<string, string>;
  /** Step key that invalidated this state and forced re-run. */
  invalidatedBy?: string;
  invalidatedAt?: number;
}

// ---------------------------------------------------------------------------
// Step execution context — what the adapter receives
// ---------------------------------------------------------------------------

export interface StepContext {
  projectId: string;
  environment: string;
  upstreamResources: Record<string, string>; // all resources produced by completed deps
  vaultRead: (key: string) => Promise<string | null>;
  vaultWrite: (key: string, value: string) => Promise<void>;
  executionIntent?: StepExecutionIntent;
}

export interface StepResult {
  status: 'completed' | 'failed' | 'waiting-on-user';
  resourcesProduced: Record<string, string>;
  error?: string;
  userPrompt?: string; // what to show the user if waiting-on-user
}

// ---------------------------------------------------------------------------
// Gate resolver — allows user-action nodes to auto-resolve during execution
// ---------------------------------------------------------------------------

export type GateResolverResult =
  | { resolved: true; resourcesProduced: Record<string, string>; completedSteps?: Array<{ nodeKey: string; resourcesProduced: Record<string, string> }> }
  | { resolved: false; action: 'wait-on-user' };

export interface GateResolver {
  canResolve(nodeKey: string, context: StepContext): Promise<GateResolverResult>;
}

// ---------------------------------------------------------------------------
// Provider blueprint — replaces IntegrationBlueprintDescriptor
// ---------------------------------------------------------------------------

export type IntegrationScope = 'organization' | 'project';

export interface ProviderBlueprint {
  provider: ProviderType;
  scope: IntegrationScope;
  steps: ProvisioningStepNode[];
  userActions: UserActionNode[];
}

// ---------------------------------------------------------------------------
// The full provisioning plan for a project
// ---------------------------------------------------------------------------

export interface ProvisioningPlan {
  projectId: string;
  environments: string[];
  selectedModules: SelectedModules;
  /**
   * Mobile platforms this plan targets. Used by the plan builder to drop
   * platform-irrelevant nodes and relax dependencies that point at them.
   * Empty array means "platform filtering disabled" (treat as all platforms).
   */
  platforms: MobilePlatform[];
  nodes: ProvisioningNode[];
  nodeStates: Map<string, NodeState>; // keyed by nodeKey (or nodeKey:env for per-env)
}

// ---------------------------------------------------------------------------
// Serializable version of ProvisioningPlan for API transport
// ---------------------------------------------------------------------------

export interface ProvisioningPlanSnapshot {
  projectId: string;
  environments: string[];
  selectedModules: SelectedModules;
  platforms: MobilePlatform[];
  nodes: ProvisioningNode[];
  nodeStates: Record<string, NodeState>; // Map serialized as plain object
}

export type SelectedModules = string[];

// ---------------------------------------------------------------------------
// Execution group — a batch of nodes that can run in parallel
// ---------------------------------------------------------------------------

export interface ExecutionGroupItem {
  nodeKey: string;
  environment?: string; // present for per-environment step instances
}

export interface ExecutionGroup {
  depth: number;
  items: ExecutionGroupItem[];
}

// ---------------------------------------------------------------------------
// Step progress event — yielded by provisionBySteps()
// ---------------------------------------------------------------------------

export type StepProgressStatus =
  | 'ready'
  | 'running'
  | 'success'
  | 'failure'
  | 'waiting-on-user'
  | 'resolving'
  | 'skipped'
  | 'blocked';

export interface StepProgressEvent {
  nodeKey: string;                 // 'firebase:create-gcp-project'
  nodeType: 'step' | 'user-action';
  provider?: ProviderType;
  environment?: string;            // null for global steps, 'dev'/'prod' for per-env
  status: StepProgressStatus;
  result?: StepResult;
  userPrompt?: string;             // for waiting-on-user status
  timestamp: Date;
  correlation_id: string;
}
