import type * as React from 'react';

export type StudioView =
  | 'overview'
  | 'project'
  | 'project-setup'
  | 'project-modules'
  | 'project-dashboard'
  | 'project-settings'
  | 'project-providers'
  | 'runs'
  | 'registry'
  | 'infrastructure';

// ---------------------------------------------------------------------------
// Provisioning Graph Types (mirrors backend graph.types.ts)
// ---------------------------------------------------------------------------

export type EnvironmentScope = 'global' | 'per-environment';
export type AutomationLevel = 'full' | 'assisted' | 'manual';
export type StepDirection = 'provision' | 'teardown';
export type UserActionCategory =
  | 'account-enrollment'
  | 'credential-upload'
  | 'external-configuration'
  | 'approval';

export type VerificationMethod =
  | { type: 'api-check'; description: string }
  | { type: 'credential-upload'; secretKey: string }
  | { type: 'manual-confirm' };

export type InteractiveAction =
  | { type: 'oauth'; provider: 'firebase'; label: string };

export interface DependencyRef {
  nodeKey: string;
  required: boolean;
  description?: string;
}

export interface CompletionRelatedLink {
  label: string;
  href?: string;
  hrefTemplate?: string;
}

export interface ResourceOutputPresentation {
  sensitive?: boolean;
  primaryLinkFromValue?: boolean;
  primaryHrefTemplate?: string;
  relatedLinks?: CompletionRelatedLink[];
}

export interface ResourceOutput {
  key: string;
  label: string;
  description: string;
  presentation?: ResourceOutputPresentation;
}

export interface CompletionPortalLink {
  label: string;
  href?: string;
  hrefTemplate?: string;
}

export interface UserActionNode {
  type: 'user-action';
  key: string;
  label: string;
  description: string;
  category: UserActionCategory;
  provider?: string;
  verification: VerificationMethod;
  interactiveAction?: InteractiveAction;
  helpUrl?: string;
  dependencies: DependencyRef[];
  produces: ResourceOutput[];
  completionPortalLinks?: CompletionPortalLink[];
}

export interface ProvisioningStepNode {
  type: 'step';
  key: string;
  label: string;
  description: string;
  provider: string;
  environmentScope: EnvironmentScope;
  automationLevel: AutomationLevel;
  dependencies: DependencyRef[];
  produces: ResourceOutput[];
  estimatedDurationMs?: number;
  bridgeTarget?: string;
  direction?: StepDirection;
  teardownOf?: string;
  completionPortalLinks?: CompletionPortalLink[];
  interactiveAction?: InteractiveAction;
}

export type ProvisioningGraphNode = UserActionNode | ProvisioningStepNode;

export type NodeStatus =
  | 'not-started'
  | 'blocked'
  | 'ready'
  | 'in-progress'
  | 'waiting-on-user'
  | 'resolving'
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
  resourcesProduced?: Record<string, string>;
}

export type JourneyPhaseId =
  | 'accounts'
  | 'domain_dns'
  | 'credentials'
  | 'cloud_firebase'
  | 'repo'
  | 'cicd'
  | 'mobile_build'
  | 'signing_apple'
  | 'play'
  | 'edge_ssl'
  | 'deep_links'
  | 'oauth'
  | 'verification'
  | 'teardown';

/** Display titles — keep in sync with `src/provisioning/journey-phases.ts` */
export const JOURNEY_PHASE_TITLE: Record<JourneyPhaseId, string> = {
  accounts: 'Accounts & billing',
  domain_dns: 'Domain & DNS',
  credentials: 'Credentials & access',
  cloud_firebase: 'Cloud & Firebase',
  repo: 'Source repository',
  cicd: 'CI/CD & automation',
  mobile_build: 'Mobile builds',
  signing_apple: 'Apple signing & App Store',
  play: 'Google Play',
  edge_ssl: 'Edge & SSL',
  deep_links: 'Deep linking',
  oauth: 'Auth & OAuth',
  verification: 'Verification & go-live',
  teardown: 'Teardown',
};

export interface SequentialExecutionItem {
  nodeKey: string;
  environment?: string;
}

export interface ProvisioningPlanResponse {
  projectId: string;
  environments: string[];
  selectedModules: string[];
  nodes: ProvisioningGraphNode[];
  nodeStates: Record<string, NodeState>;
  /** Server-computed topological order (logical node keys). */
  canonicalNodeOrder: string[];
  journeyPhaseByNodeKey: Record<string, JourneyPhaseId>;
  /** Phases that appear in this plan, in sidebar order. */
  journeyPhaseOrder: JourneyPhaseId[];
  sequentialExecutionItems: SequentialExecutionItem[];
}

export type ModuleId =
  | 'firebase-core'
  | 'firebase-auth'
  | 'firebase-firestore'
  | 'firebase-storage'
  | 'firebase-messaging'
  | 'github-repo'
  | 'github-ci'
  | 'eas-builds'
  | 'eas-submit'
  | 'apple-signing'
  | 'google-play-publishing'
  | 'cloudflare-domain'
  | 'oauth-social';

/** Logical capability buckets for the Studio module picker (UI only). */
export type ModuleFunctionGroupId =
  | 'cloud-foundation'
  | 'persistent-store'
  | 'object-storage'
  | 'messaging'
  | 'auth-identity'
  | 'domain-edge'
  | 'source-control'
  | 'ci-automation'
  | 'mobile-release'
  | 'apple-distribution'
  | 'google-play';

export interface ModuleDefinition {
  id: ModuleId;
  label: string;
  description: string;
  provider: string;
  /** Studio: group under a capability heading in the module wizard. */
  functionGroupId: ModuleFunctionGroupId;
  requiredModules: ModuleId[];
  optionalModules: ModuleId[];
  stepKeys: string[];
  teardownStepKeys: string[];
}

export type ProjectTemplateId = 'mobile-app' | 'web-app' | 'api-backend' | 'custom';

export interface ProjectTemplate {
  id: ProjectTemplateId;
  label: string;
  description: string;
  modules: ModuleId[];
}

export type StepProgressStatus =
  | 'ready'
  | 'running'
  | 'success'
  | 'failure'
  | 'waiting-on-user'
  | 'resolving'
  | 'skipped'
  | 'blocked';

export interface WsStepProgressMessage {
  type: 'step_progress';
  runId: string;
  timestamp: string;
  data: {
    nodeKey: string;
    nodeType: 'step' | 'user-action';
    status: StepProgressStatus;
    environment?: string;
    resourcesProduced?: Record<string, string>;
    error?: string;
    userPrompt?: string;
  };
}
export type ProviderId = 'firebase' | 'expo' | 'github';
export type SetupTaskStatus = 'idle' | 'running' | 'completed' | 'error' | 'manual-required';

export interface RegistryPlugin {
  id: string;
  name: string;
  provider: string;
  providerId: ProviderId | 'studio' | 'other';
  description: string;
  categories: string[];
  version: string;
  future?: boolean;
}

export interface RegistryCategory {
  id: string;
  label: string;
  icon: React.ElementType;
  color: string;
  pluginIds: string[];
}

export interface IntegrationField {
  key: string;
  label: string;
  placeholder: string;
  hint: string;
  type: 'text' | 'password' | 'textarea';
}

export interface IntegrationConfig {
  id: ProviderId;
  scope: 'organization' | 'project';
  orgAvailability?: 'automatic' | 'requires-credentials';
  name: string;
  logo: React.ElementType;
  logoColor: string;
  description: string;
  docsUrl: string;
  fields: IntegrationField[];
  supportsOAuth?: boolean;
}

export interface IntegrationDependencyStatus {
  key: string;
  label: string;
  required: boolean;
  source: 'project' | 'organization' | 'integration';
  description: string;
  value: string | null;
  status: 'ready' | 'missing';
}

export interface IntegrationPlannedResourceStatus {
  key: string;
  label: string;
  description: string;
  naming: string;
  standardized_name: string;
}

export interface IntegrationDependencyProviderStatus {
  provider: string;
  scope: 'organization' | 'project';
  dependencies: IntegrationDependencyStatus[];
  plannedResources: IntegrationPlannedResourceStatus[];
}

export type SetupPlanStepStatus = 'idle' | 'in_progress' | 'completed' | 'failed';

export interface ConnectedProviders {
  firebase: boolean;
  expo: boolean;
  github: boolean;
}

export const mapGcpStepToSetupStatus = (
  status: GcpOAuthStepStatus['status'] | undefined,
): SetupPlanStepStatus => {
  if (status === 'completed') return 'completed';
  if (status === 'in_progress') return 'in_progress';
  if (status === 'failed') return 'failed';
  return 'idle';
};

export interface InfraPluginCategory {
  id: string;
  label: string;
  icon: React.ElementType;
  color: string;
  description: string;
  plugins: InfraPlugin[];
}

export interface InfraConfigField {
  key: string;
  label: string;
  placeholder: string;
  type: 'text' | 'select';
  options?: string[];
}

export interface SetupTask {
  id: string;
  title: string;
  description: string;
  duration: number;
  manualRequired?: boolean;
  manualLabel?: string;
}

export interface InfraPlugin {
  id: string;
  name: string;
  provider: string;
  description: string;
  configFields: InfraConfigField[];
  setupTasks: SetupTask[];
}

export interface ProjectPluginState {
  categoryId: string;
  selectedPluginId: string | null;
  configValues: Record<string, string>;
  setupStatus: SetupTaskStatus;
  taskStates: Record<string, SetupTaskStatus>;
  completedAt?: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  slug: string;
  bundleId: string;
  updatedAt: string;
  integration_progress: { configured: number; total: number };
}

export interface ProjectDetail {
  project: {
    id: string;
    name: string;
    slug: string;
    bundleId: string;
    updatedAt: string;
  };
  integrations: Record<string, unknown>;
  provisioning: {
    runs: Array<{
      id: string;
      status: string;
      created_at: string;
      updated_at: string;
    }>;
  };
}

export interface IntegrationStatusRecord {
  status?: string;
  config?: Record<string, string>;
}

export interface OrganizationProfile {
  integrations?: Record<string, IntegrationStatusRecord>;
}

export interface GcpOAuthStepStatus {
  id: 'oauth_consent';
  label: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  message?: string;
}

export interface GcpOAuthProjectDiscoverResult {
  outcome: 'linked' | 'already_linked' | 'not_found' | 'inaccessible' | 'ambiguous' | 'error';
  gcpProjectId?: string;
  expectedProjectId: string;
  expectedDisplayName: string;
  message: string;
}

export interface GcpOAuthSessionStatus {
  sessionId: string;
  projectId?: string;
  phase: 'awaiting_user' | 'processing' | 'completed' | 'failed' | 'expired';
  connected: boolean;
  error?: string;
  steps: GcpOAuthStepStatus[];
  gcpProjectDiscover?: GcpOAuthProjectDiscoverResult;
}

export interface FirebaseConnectionDetails {
  project_id?: string;
  service_account_email?: string;
  connected_by?: string;
}

export interface LogEntry {
  id: string;
  timestamp: string;
  level: 'info' | 'success' | 'warn' | 'error' | 'debug';
  message: string;
}

export interface ServiceHealth {
  id: string;
  name: string;
  provider: string;
  uptime: number;
  latency: number;
  status: 'operational' | 'degraded' | 'outage' | 'provisioning';
  lastCheck: string;
}

export interface DeploymentRecord {
  id: string;
  version: string;
  branch: string;
  commit: string;
  triggeredBy: string;
  status: 'success' | 'failed' | 'running' | 'queued';
  platform: 'ios' | 'android' | 'both';
  createdAt: string;
  duration?: string;
}

export interface ProjectSetupStep {
  id: string;
  label: string;
  description: string;
}

export interface ProjectSetupConfig {
  providerId: ProviderId;
  name: string;
  icon: React.ElementType;
  iconColorClass: string;
  iconBgClass: string;
  introDescription: string;
  introBadges?: string[];
  setupMethod: 'oauth-or-manual' | 'trigger';
  triggerLabel?: string;
  triggerDescription?: string;
  steps: ProjectSetupStep[];
  oauthSteps?: Array<{ key: GcpOAuthStepStatus['id']; label: string; description: string }>;
  pluginIds: string[];
  docsUrl: string;
  disconnectSupported: boolean;
}
