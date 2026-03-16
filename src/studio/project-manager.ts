import * as fs from 'fs';
import * as path from 'path';

export type IntegrationProvider =
  | 'firebase'
  | 'github'
  | 'eas'
  | 'apple'
  | 'google-play'
  | 'cloudflare'
  | 'oauth';

export type MobilePlatform = 'ios' | 'android';

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
    return JSON.parse(raw) as ProjectModule;
  }

  deleteProject(projectId: string): void {
    fs.rmSync(this.projectDir(projectId), { recursive: true, force: false });
  }

  getOrganization(): OrganizationProfile {
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
        environments: input.environments?.length ? input.environments : ['dev', 'preview', 'production'],
        platforms,
        domain: input.domain?.trim() ?? '',
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
    patch: Partial<Pick<ProjectInfo, 'name' | 'description' | 'repository' | 'platform'>>,
  ): ProjectModule {
    const module = this.getProject(projectId);
    const now = new Date().toISOString();
    const updated: ProjectModule = {
      ...module,
      project: {
        ...module.project,
        name: patch.name?.trim() ?? module.project.name,
        description: patch.description?.trim() ?? module.project.description,
        repository: patch.repository?.trim() ?? module.project.repository,
        platform: patch.platform ?? module.project.platform,
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
