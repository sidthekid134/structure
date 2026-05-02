import * as fs from 'fs';
import * as path from 'path';
import { isValidProjectDomain, normalizeProjectDomain } from './project-identity.js';
import type { MobilePlatform } from '../provisioning/graph.types.js';

export type IntegrationProvider =
  | 'firebase'
  | 'github'
  | 'eas'
  | 'apple'
  | 'google-play'
  | 'cloudflare'
  | 'oauth';

export type { MobilePlatform };

export interface ProjectInfo {
  id: string;
  name: string;
  slug: string;
  bundleId: string;
  description: string;
  repository: string;
  platform: 'ios' | 'android' | 'web' | 'cross-platform';
  githubOrg: string;
  easAccount: string;
  environments: string[];
  platforms: MobilePlatform[];
  domain: string;
  plugins: IntegrationProvider[];
  createdAt: string;
  updatedAt: string;
}

export interface IntegrationConfigRecord {
  provider: IntegrationProvider;
  status: 'pending' | 'in_progress' | 'configured';
  notes: string;
  config: Record<string, string>;
  lastUpdated: string | null;
}

export interface ProjectModule {
  project: ProjectInfo;
  integrations: Partial<Record<IntegrationProvider, IntegrationConfigRecord>>;
}

export interface ProvisioningPlanFile {
  projectId: string;
  environments: string[];
  selectedModules: string[];
  nodes: unknown[];
  nodeStates: Record<string, unknown>;
}

export interface OrganizationProfile {
  integrations: Partial<Record<IntegrationProvider, IntegrationConfigRecord>>;
  updatedAt: string;
}

const PROVIDERS: readonly IntegrationProvider[] = [
  'firebase',
  'github',
  'eas',
  'apple',
  'google-play',
  'cloudflare',
  'oauth',
] as const;
const DEFAULT_PLATFORMS: MobilePlatform[] = ['ios', 'android'];
export const EXPO_ENVIRONMENTS = ['development', 'preview', 'production'] as const;
export const DEFAULT_EXPO_ENVIRONMENTS = ['preview', 'production'] as const;
type ExpoEnvironment = (typeof EXPO_ENVIRONMENTS)[number];

const ENVIRONMENT_ALIASES: Readonly<Record<string, ExpoEnvironment>> = {
  development: 'development',
  dev: 'development',
  preview: 'preview',
  qa: 'preview',
  staging: 'preview',
  production: 'production',
  prod: 'production',
};

export function normalizeExpoEnvironments(input?: string[]): string[] {
  if (!input?.length) {
    return [...DEFAULT_EXPO_ENVIRONMENTS];
  }

  const unique = new Set<ExpoEnvironment>();
  for (const environment of input) {
    if (typeof environment !== 'string') {
      throw new Error('Each environment must be a string.');
    }
    const normalized = ENVIRONMENT_ALIASES[environment.trim().toLowerCase()];
    if (!normalized) {
      throw new Error(
        `Unsupported environment "${environment}". Supported environments: ${EXPO_ENVIRONMENTS.join(', ')}.`,
      );
    }
    unique.add(normalized);
  }

  if (unique.size === 0) {
    return [...DEFAULT_EXPO_ENVIRONMENTS];
  }

  return EXPO_ENVIRONMENTS.filter((environment) => unique.has(environment));
}

export class ProjectManager {
  private readonly projectsRoot: string;
  private readonly organizationPath: string;

  constructor(private readonly storeDir: string) {
    this.projectsRoot = path.join(this.storeDir, 'projects');
    this.organizationPath = path.join(this.storeDir, 'organization.json');
    fs.mkdirSync(this.projectsRoot, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(this.organizationPath)) {
      const now = new Date().toISOString();
      const profile: OrganizationProfile = { integrations: {}, updatedAt: now };
      fs.writeFileSync(this.organizationPath, JSON.stringify(profile, null, 2), {
        encoding: 'utf8',
        mode: 0o600,
      });
    }
  }

  listProjects(): ProjectInfo[] {
    fs.mkdirSync(this.projectsRoot, { recursive: true, mode: 0o700 });
    const entries = fs.readdirSync(this.projectsRoot, { withFileTypes: true });
    const projects = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => this.getProject(entry.name).project);

    projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return projects;
  }

  getProject(projectId: string): ProjectModule {
    const modulePath = this.modulePath(projectId);
    const raw = fs.readFileSync(modulePath, 'utf8');
    const parsed = JSON.parse(raw) as ProjectModule;
    // Backfill platform metadata for projects created before
    // `platforms` was introduced. Falls back to derive from the
    // legacy `platform` field when present, otherwise both platforms.
    if (!Array.isArray(parsed.project.platforms) || parsed.project.platforms.length === 0) {
      const legacy = parsed.project.platform;
      if (legacy === 'ios' || legacy === 'android') {
        parsed.project.platforms = [legacy];
      } else {
        parsed.project.platforms = [...DEFAULT_PLATFORMS];
      }
    }
    return parsed;
  }

  deleteProject(projectId: string): void {
    fs.rmSync(this.projectDir(projectId), { recursive: true, force: false });
  }

  savePlan(projectId: string, plan: ProvisioningPlanFile): void {
    const planPath = this.planPath(projectId);
    fs.writeFileSync(planPath, JSON.stringify(plan, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
  }

  loadPlan(projectId: string): ProvisioningPlanFile | null {
    const planPath = this.planPath(projectId);
    if (!fs.existsSync(planPath)) return null;
    const raw = fs.readFileSync(planPath, 'utf8');
    return JSON.parse(raw) as ProvisioningPlanFile;
  }

  deletePlan(projectId: string): void {
    const planPath = this.planPath(projectId);
    if (!fs.existsSync(planPath)) return;
    fs.unlinkSync(planPath);
  }

  getOrganization(): OrganizationProfile {
    if (!fs.existsSync(this.organizationPath)) {
      const now = new Date().toISOString();
      const profile: OrganizationProfile = { integrations: {}, updatedAt: now };
      fs.writeFileSync(this.organizationPath, JSON.stringify(profile, null, 2), {
        encoding: 'utf8',
        mode: 0o600,
      });
      return profile;
    }
    const raw = fs.readFileSync(this.organizationPath, 'utf8');
    return JSON.parse(raw) as OrganizationProfile;
  }

  createProject(input: {
    name: string;
    slug: string;
    bundleId: string;
    description?: string;
    repository?: string;
    githubOrg?: string;
    easAccount?: string;
    environments?: string[];
    platforms?: MobilePlatform[];
    domain?: string;
    plugins?: IntegrationProvider[];
  }): ProjectModule {
    if (typeof input.slug !== 'string' || !input.slug.trim()) {
      throw new Error('Project slug is required.');
    }
    if (typeof input.bundleId !== 'string' || !input.bundleId.trim()) {
      throw new Error('Bundle ID is required.');
    }
    const name = input.name?.trim();
    if (!name) {
      throw new Error('Project name is required.');
    }

    const slug = input.slug
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '');

    if (!slug) {
      throw new Error('Project slug resolved to an empty value.');
    }
    if (slug.length > 25) {
      throw new Error('Project slug must be 25 characters or fewer.');
    }

    const bundleId = input.bundleId
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9.-]+/g, '')
      .replace(/\.{2,}/g, '.')
      .replace(/^\.+|\.+$/g, '');
    if (!bundleId) {
      throw new Error('Bundle ID is required.');
    }

    const domainRaw = input.domain?.trim() ?? '';
    if (!isValidProjectDomain(domainRaw)) {
      throw new Error(
        'A valid project domain is required (e.g. app.example.com). Use letters, numbers, hyphens, and dots only.',
      );
    }
    const domain = normalizeProjectDomain(domainRaw);

    const platforms = Array.from(new Set(input.platforms?.length ? input.platforms : DEFAULT_PLATFORMS));
    if (platforms.some((platform) => platform !== 'ios' && platform !== 'android')) {
      throw new Error('Platforms must be ios and/or android.');
    }

    const plugins = Array.from(new Set(input.plugins ?? []));
    if (plugins.some((provider) => !PROVIDERS.includes(provider))) {
      throw new Error('Unknown plugin selected.');
    }

    const projectDir = this.projectDir(slug);
    if (fs.existsSync(projectDir)) {
      throw new Error(`Project "${slug}" already exists.`);
    }

    fs.mkdirSync(projectDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(projectDir, 'space'), { recursive: true, mode: 0o700 });

    const now = new Date().toISOString();
    const module: ProjectModule = {
      project: {
        id: slug,
        name,
        slug,
        bundleId,
        description: input.description?.trim() ?? '',
        repository: input.repository?.trim() ?? '',
        platform: platforms.length === 2 ? 'cross-platform' : platforms[0],
        githubOrg: input.githubOrg?.trim() ?? '',
        easAccount: input.easAccount?.trim() ?? '',
        environments: normalizeExpoEnvironments(input.environments),
        platforms,
        domain,
        plugins,
        createdAt: now,
        updatedAt: now,
      },
      integrations: this.defaultIntegrations(plugins),
    };

    this.writeModule(slug, module);
    return module;
  }

  updateProjectInfo(
    projectId: string,
    patch: Partial<Pick<ProjectInfo, 'name' | 'description' | 'repository' | 'platform' | 'domain'>>,
  ): ProjectModule {
    const module = this.getProject(projectId);
    const now = new Date().toISOString();

    let domain = module.project.domain;
    if (patch.domain !== undefined) {
      const raw = patch.domain.trim();
      if (raw === '') {
        if (module.project.domain) {
          throw new Error('Project domain cannot be cleared once set. Set a valid hostname.');
        }
      } else {
        if (!isValidProjectDomain(raw)) {
          throw new Error(
            'Invalid domain. Use a hostname such as app.example.com (letters, numbers, hyphens, dots).',
          );
        }
        domain = normalizeProjectDomain(raw);
      }
    }

    const updated: ProjectModule = {
      ...module,
      project: {
        ...module.project,
        name: patch.name?.trim() ?? module.project.name,
        description: patch.description?.trim() ?? module.project.description,
        repository: patch.repository?.trim() ?? module.project.repository,
        platform: patch.platform ?? module.project.platform,
        domain,
        updatedAt: now,
      },
    };

    this.writeModule(projectId, updated);
    return updated;
  }

  updateIntegration(
    projectId: string,
    provider: IntegrationProvider,
    patch: Partial<Pick<IntegrationConfigRecord, 'status' | 'notes' | 'config'>>,
  ): ProjectModule {
    const module = this.getProject(projectId);
    const existing = module.integrations[provider];
    if (!existing) {
      throw new Error(`Unknown integration provider "${provider}".`);
    }

    const now = new Date().toISOString();
    const mergedConfig = patch.config ? { ...existing.config, ...patch.config } : existing.config;

    const updated: ProjectModule = {
      ...module,
      project: {
        ...module.project,
        updatedAt: now,
      },
      integrations: {
        ...module.integrations,
        [provider]: {
          ...existing,
          status: patch.status ?? existing.status,
          notes: patch.notes ?? existing.notes,
          config: mergedConfig,
          lastUpdated: now,
        },
      },
    };

    this.writeModule(projectId, updated);
    return updated;
  }

  addIntegration(projectId: string, provider: IntegrationProvider): ProjectModule {
    const module = this.getProject(projectId);
    if (module.integrations[provider]) {
      throw new Error(`Integration "${provider}" is already added.`);
    }
    const orgIntegration = this.getOrganization().integrations[provider];

    const now = new Date().toISOString();
    const updated: ProjectModule = {
      ...module,
      project: {
        ...module.project,
        plugins: Array.from(new Set([...module.project.plugins, provider])),
        updatedAt: now,
      },
      integrations: {
        ...module.integrations,
        [provider]: {
          provider,
          status: 'pending',
          notes: orgIntegration?.notes ?? '',
          config: orgIntegration ? { ...orgIntegration.config } : {},
          lastUpdated: null,
        },
      },
    };

    this.writeModule(projectId, updated);
    return updated;
  }

  addOrganizationIntegration(provider: IntegrationProvider): OrganizationProfile {
    const organization = this.getOrganization();
    if (organization.integrations[provider]) {
      throw new Error(`Organization integration "${provider}" already exists.`);
    }
    const now = new Date().toISOString();
    const updated: OrganizationProfile = {
      ...organization,
      updatedAt: now,
      integrations: {
        ...organization.integrations,
        [provider]: {
          provider,
          status: 'pending',
          notes: '',
          config: {},
          lastUpdated: null,
        },
      },
    };
    this.writeOrganization(updated);
    return updated;
  }

  updateOrganizationIntegration(
    provider: IntegrationProvider,
    patch: Partial<Pick<IntegrationConfigRecord, 'status' | 'notes' | 'config'>> & {
      replaceConfig?: boolean;
    },
  ): OrganizationProfile {
    const organization = this.getOrganization();
    const existing = organization.integrations[provider];
    if (!existing) {
      throw new Error(`Organization integration "${provider}" not found.`);
    }
    const now = new Date().toISOString();
    const mergedConfig = patch.config
      ? (patch.replaceConfig ? { ...patch.config } : { ...existing.config, ...patch.config })
      : existing.config;
    const updated: OrganizationProfile = {
      ...organization,
      updatedAt: now,
      integrations: {
        ...organization.integrations,
        [provider]: {
          ...existing,
          status: patch.status ?? existing.status,
          notes: patch.notes ?? existing.notes,
          config: mergedConfig,
          lastUpdated: now,
        },
      },
    };
    this.writeOrganization(updated);
    return updated;
  }

  private defaultIntegrations(providers: IntegrationProvider[]): Partial<Record<IntegrationProvider, IntegrationConfigRecord>> {
    const out: Partial<Record<IntegrationProvider, IntegrationConfigRecord>> = {};
    for (const provider of providers) {
      out[provider] = {
        provider,
        status: 'pending',
        notes: '',
        config: {},
        lastUpdated: null,
      };
    }
    return out;
  }

  private modulePath(projectId: string): string {
    return path.join(this.projectDir(projectId), 'module.json');
  }

  private planPath(projectId: string): string {
    return path.join(this.projectDir(projectId), 'plan.json');
  }

  private projectDir(projectId: string): string {
    return path.join(this.projectsRoot, projectId);
  }

  private writeModule(projectId: string, module: ProjectModule): void {
    const modulePath = this.modulePath(projectId);
    fs.writeFileSync(modulePath, JSON.stringify(module, null, 2), { encoding: 'utf8', mode: 0o600 });
  }

  private writeOrganization(profile: OrganizationProfile): void {
    fs.writeFileSync(this.organizationPath, JSON.stringify(profile, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
  }
}
