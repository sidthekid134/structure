import type * as React from 'react';

export type StudioView = 'overview' | 'project' | 'project-providers' | 'runs' | 'registry' | 'infrastructure';
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
  id: 'oauth_consent' | 'gcp_project' | 'service_account' | 'iam_binding' | 'vault';
  label: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  message?: string;
}

export interface GcpOAuthSessionStatus {
  sessionId: string;
  phase: 'awaiting_user' | 'processing' | 'completed' | 'failed' | 'expired';
  connected: boolean;
  error?: string;
  steps: GcpOAuthStepStatus[];
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
