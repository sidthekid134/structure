export interface ManifestResource {
  provider: string;
  resourceType: string;
  resourceId: string;
  configHash: string;
  lastVerified: number;
  configuration?: Record<string, unknown>;
}

export interface Manifest {
  projectId: string;
  generatedAt: number;
  version: string;
  lastDriftCheck?: number;
  resources: ManifestResource[];
}

export interface DriftFinding {
  driftType: 'config_change' | 'resource_deleted' | 'resource_added';
  resourceId: string;
  provider: string;
  resourceType: string;
  oldHash?: string;
  newHash?: string;
  oldConfig?: Record<string, unknown>;
  newConfig?: Record<string, unknown>;
  detectedAt: number;
}

export interface DriftReport {
  projectId: string;
  generatedAt: number;
  manifestVersion: string;
  findings: DriftFinding[];
  summary: {
    configChanges: number;
    deletions: number;
    additions: number;
    total: number;
  };
}

export interface LiveResource {
  provider: string;
  resourceType: string;
  resourceId: string;
  configuration: Record<string, unknown>;
}

export interface ProviderCredentials {
  firebase?: {
    projectId: string;
    serviceAccountKey: string;
  };
  apple?: {
    keyId: string;
    teamId: string;
    privateKey: string;
  };
  github?: {
    token: string;
  };
}
