/**
 * EAS (Expo Application Services) adapter — initializes EAS projects and
 * manages environment variables scoped to development, preview, and production.
 */

import * as crypto from 'crypto';
import {
  ProviderAdapter,
  EasManifestConfig,
  ProviderState,
  DriftReport,
  DriftDifference,
  ReconcileDirection,
  AdapterError,
  Environment,
  StepContext,
  StepResult,
} from './types.js';
import { createOperationLogger } from '../logger.js';
import type { LoggingCallback } from '../types.js';
import type { GitHubApiClient } from './github.js';
import { ExpoGraphqlEasApiClient } from './expo-graphql-eas-client.js';

// ---------------------------------------------------------------------------
// API client interface
// ---------------------------------------------------------------------------

export interface EasApiClient {
  createProject(projectName: string, organization?: string): Promise<string>;
  getProject(projectName: string, organization?: string): Promise<string | null>;
  /** Permanently remove the Expo app / EAS project (async on Expo's side). */
  deleteProject(projectId: string): Promise<void>;
  uploadEnvFile(
    projectId: string,
    environment: Environment,
    envVars: Record<string, string>,
  ): Promise<void>;
  getEnvVars(projectId: string, environment: Environment): Promise<Record<string, string>>;
}

export class StubEasApiClient implements EasApiClient {
  async createProject(_projectName: string, _organization?: string): Promise<string> {
    throw new Error(
      'StubEasApiClient cannot create EAS projects. Configure EasAdapter with a real EAS API client.',
    );
  }

  async getProject(_projectName: string, _organization?: string): Promise<string | null> {
    throw new Error(
      'StubEasApiClient cannot query EAS projects. Configure EasAdapter with a real EAS API client.',
    );
  }

  async deleteProject(_projectId: string): Promise<void> {
    throw new Error(
      'StubEasApiClient cannot delete EAS projects. Configure EasAdapter with a real EAS API client.',
    );
  }

  async uploadEnvFile(
    _projectId: string,
    _environment: Environment,
    _envVars: Record<string, string>,
  ): Promise<void> {
    throw new Error(
      'StubEasApiClient cannot upload EAS environment data. Configure EasAdapter with a real EAS API client.',
    );
  }

  async getEnvVars(
    _projectId: string,
    _environment: Environment,
  ): Promise<Record<string, string>> {
    throw new Error(
      'StubEasApiClient cannot read EAS environment data. Configure EasAdapter with a real EAS API client.',
    );
  }
}

// ---------------------------------------------------------------------------
// EAS adapter
// ---------------------------------------------------------------------------

function parseGithubHttpsRepo(url: string): { owner: string; repo: string } {
  const u = url.trim().replace(/\.git$/i, '');
  const m = u.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\/|$)/i);
  if (!m) {
    throw new AdapterError(
      `Expected a github.com repository URL (https://github.com/owner/repo), got: ${url}`,
      'eas',
      'executeStep',
    );
  }
  return { owner: m[1]!, repo: m[2]! };
}

export interface EasJsonSubmitInfo {
  /** App Store Connect numeric app id (produced by `apple:create-app-store-listing`). */
  ascAppId?: string;
  /** Apple developer team identifier (10-char) — from the Apple integration / enroll step. */
  appleTeamId?: string;
  /** Apple ID email used to log in to App Store Connect. Optional — Expo can resolve from the ASC API key. */
  appleId?: string;
}

/**
 * Default eas.json content for a freshly-provisioned Expo app. Mirrors the structure
 * of a known-good production eas.json: production profile holds the real settings,
 * development/preview extend it. Profiles also reference EAS env-var environments
 * via the `environment` field (set up by `eas:configure-build-profiles`).
 *
 * Existing eas.json files are not overwritten by the provisioner; this template is
 * only used for the initial bootstrap.
 */
export function buildDefaultEasJson(environments: Environment[], submit?: EasJsonSubmitInfo): string {
  const knownChannels = new Set(['development', 'preview', 'production']);
  const requested = environments
    .map((env) => env.trim().toLowerCase())
    .filter((env) => knownChannels.has(env));
  const profileChannels = requested.length > 0
    ? Array.from(new Set(['production', ...requested]))
    : ['development', 'preview', 'production'];

  const build: Record<string, Record<string, unknown>> = {};

  if (profileChannels.includes('production')) {
    build['production'] = {
      environment: 'production',
      autoIncrement: true,
      ios: {
        buildConfiguration: 'Release',
        image: 'auto',
      },
      android: {
        buildType: 'app-bundle',
      },
    };
  }
  if (profileChannels.includes('development')) {
    build['development'] = {
      environment: 'development',
      developmentClient: true,
      distribution: 'internal',
      ios: {
        simulator: true,
      },
      extends: 'production',
    };
  }
  if (profileChannels.includes('preview')) {
    build['preview'] = {
      environment: 'preview',
      distribution: 'internal',
      extends: 'production',
    };
  }

  const submitIos: Record<string, string> = {};
  if (submit?.appleId) submitIos['appleId'] = submit.appleId;
  if (submit?.ascAppId) submitIos['ascAppId'] = submit.ascAppId;
  if (submit?.appleTeamId) submitIos['appleTeamId'] = submit.appleTeamId;

  const easJson = {
    cli: {
      version: '>= 16.0.0',
      appVersionSource: 'remote',
    },
    build,
    submit: {
      production: {
        ios: submitIos,
      },
    },
  };
  return `${JSON.stringify(easJson, null, 2)}\n`;
}

/**
 * If the repo has a static `app.json` (and no `app.config.ts/js` overriding it),
 * patch `expo.extra.eas.projectId` so `eas build` can resolve the project. Returns
 * the new file content, or null when nothing should be written.
 */
export function patchAppJsonWithEasProjectId(
  appJsonRaw: string,
  easProjectId: string,
): string | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(appJsonRaw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const expo = (parsed['expo'] as Record<string, unknown> | undefined) ?? {};
  const extra = (expo['extra'] as Record<string, unknown> | undefined) ?? {};
  const easBlock = (extra['eas'] as Record<string, unknown> | undefined) ?? {};
  if (easBlock['projectId'] === easProjectId) return null;
  easBlock['projectId'] = easProjectId;
  extra['eas'] = easBlock;
  expo['extra'] = extra;
  parsed['expo'] = expo;
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

/**
 * Best-effort patcher for `app.config.js` / `app.config.ts`. Inserts
 * `eas: { projectId: '<id>' }` inside the existing `extra: { ... }` block, or
 * creates an `extra` block inside `expo: { ... }` when one doesn't exist.
 *
 * Returns the new source on success, the original source when an `eas.projectId`
 * is already present (no change needed), or null when the file shape is unfamiliar
 * and we can't safely modify it (caller should surface a manual instruction).
 */
export function patchAppConfigJsWithEasProjectId(
  source: string,
  easProjectId: string,
): string | null {
  if (new RegExp(`projectId\\s*:\\s*['"\`]${easProjectId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`).test(source)) {
    return null;
  }
  if (/eas\s*:\s*\{[^{}]*projectId\s*:/m.test(source)) {
    return null;
  }

  const extraMatch = source.match(/(\bextra\s*:\s*\{)/);
  if (extraMatch && extraMatch.index !== undefined) {
    const insertAt = extraMatch.index + extraMatch[0].length;
    const insertion = `\n      eas: { projectId: '${easProjectId}' },`;
    return source.slice(0, insertAt) + insertion + source.slice(insertAt);
  }

  const expoMatch = source.match(/(\bexpo\s*:\s*\{)/);
  if (expoMatch && expoMatch.index !== undefined) {
    const insertAt = expoMatch.index + expoMatch[0].length;
    const insertion = `\n    extra: { eas: { projectId: '${easProjectId}' } },`;
    return source.slice(0, insertAt) + insertion + source.slice(insertAt);
  }

  return null;
}

/**
 * Best-effort patcher to declare `ios.infoPlist.ITSAppUsesNonExemptEncryption: false`
 * in an `app.config.{js,ts}` file. Apple requires this declaration before TestFlight
 * access; declaring `false` is correct for apps that only use Apple-provided
 * encryption (HTTPS, etc.) — apps that ship custom cryptography should change it
 * to `true` and complete the export compliance questionnaire.
 *
 * Returns the new source on success, or null when nothing should be written
 * (already declared, or the file shape is unfamiliar).
 */
export function patchAppConfigJsWithEncryptionDeclaration(source: string): string | null {
  if (/ITSAppUsesNonExemptEncryption/.test(source)) {
    return null;
  }

  const iosInfoPlistMatch = source.match(/(\bios\s*:\s*\{[^{}]*\binfoPlist\s*:\s*\{)/m);
  if (iosInfoPlistMatch && iosInfoPlistMatch.index !== undefined) {
    const insertAt = iosInfoPlistMatch.index + iosInfoPlistMatch[0].length;
    const insertion = `\n        ITSAppUsesNonExemptEncryption: false,`;
    return source.slice(0, insertAt) + insertion + source.slice(insertAt);
  }

  const iosBlockMatch = source.match(/(\bios\s*:\s*\{)/);
  if (iosBlockMatch && iosBlockMatch.index !== undefined) {
    const insertAt = iosBlockMatch.index + iosBlockMatch[0].length;
    const insertion = `\n      infoPlist: { ITSAppUsesNonExemptEncryption: false },`;
    return source.slice(0, insertAt) + insertion + source.slice(insertAt);
  }

  return null;
}

/** Same idea for static `app.json` — sets `expo.ios.infoPlist.ITSAppUsesNonExemptEncryption = false` if absent. */
export function patchAppJsonWithEncryptionDeclaration(appJsonRaw: string): string | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(appJsonRaw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const expo = (parsed['expo'] as Record<string, unknown> | undefined) ?? {};
  const ios = (expo['ios'] as Record<string, unknown> | undefined) ?? {};
  const infoPlist = (ios['infoPlist'] as Record<string, unknown> | undefined) ?? {};
  if ('ITSAppUsesNonExemptEncryption' in infoPlist) return null;
  infoPlist['ITSAppUsesNonExemptEncryption'] = false;
  ios['infoPlist'] = infoPlist;
  expo['ios'] = ios;
  parsed['expo'] = expo;
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

export class EasAdapter implements ProviderAdapter<EasManifestConfig> {
  private readonly log: ReturnType<typeof createOperationLogger>;

  constructor(
    private readonly apiClient: EasApiClient = new StubEasApiClient(),
    loggingCallback?: LoggingCallback,
    private readonly githubClient?: GitHubApiClient,
  ) {
    this.log = createOperationLogger('EasAdapter', loggingCallback);
  }

  private async readVaultSecret(
    context: StepContext,
    key: string,
    options?: { includeAppleScope?: boolean; includeProjectScope?: boolean },
  ): Promise<string | undefined> {
    const includeAppleScope = options?.includeAppleScope ?? true;
    const includeProjectScope = options?.includeProjectScope ?? true;
    if (includeAppleScope) {
      const shared = (await context.vaultRead(`apple/${key}`))?.trim();
      if (shared) return shared;
    }
    if (includeProjectScope) {
      const project = (await context.vaultRead(`${context.projectId}/${key}`))?.trim();
      if (project) return project;
    }
    return undefined;
  }

  private async readAscIssuerId(context: StepContext): Promise<string | undefined> {
    return (
      (await this.readVaultSecret(context, 'asc_issuer_id')) ??
      (await this.readVaultSecret(context, 'app_store_connect_issuer_id'))
    );
  }

  async provision(config: EasManifestConfig): Promise<ProviderState> {
    this.log.info('Starting EAS provisioning', { projectName: config.project_name });

    const now = Date.now();
    const state: ProviderState = {
      provider_id: `eas-${config.project_name}`,
      provider_type: 'eas',
      resource_ids: {},
      config_hashes: { config: this.hashConfig(config) },
      credential_metadata: {},
      partially_complete: false,
      failed_steps: [],
      completed_steps: [],
      created_at: now,
      updated_at: now,
    };

    try {
      // Step 1: Create or reuse EAS project
      let projectId = await this.apiClient.getProject(
        config.project_name,
        config.organization,
      );

      if (!projectId) {
        projectId = await this.apiClient.createProject(
          config.project_name,
          config.organization,
        );
        this.log.info('EAS project created', { projectId });
      }

      state.resource_ids['project_id'] = projectId;
      state.completed_steps.push('create_project');

      // Step 2: Mark each Studio environment on the Expo app (EAS env-var slots).
      for (const env of config.environments) {
        try {
          if (this.apiClient instanceof ExpoGraphqlEasApiClient) {
            await this.apiClient.ensureStudioEasEnvironmentMarkerOnApp(projectId, env);
          } else {
            await this.apiClient.uploadEnvFile(projectId, env, {});
          }
          state.resource_ids[`env_${env}`] = 'initialized';
          state.completed_steps.push(`init_env_${env}`);
          this.log.info('EAS environment initialized', { env, projectId });
        } catch (err) {
          state.failed_steps.push(`init_env_${env}`);
          state.partially_complete = true;
          this.log.error('Failed to initialize EAS environment', {
            env,
            error: (err as Error).message,
          });
        }
      }

      state.updated_at = Date.now();
      return state;
    } catch (err) {
      throw new AdapterError(
        `EAS provisioning failed: ${(err as Error).message}`,
        'eas',
        'provision',
        err,
      );
    }
  }

  async executeStep(
    stepKey: string,
    config: EasManifestConfig,
    context: StepContext,
  ): Promise<StepResult> {
    this.log.info('EasAdapter.executeStep()', { stepKey });
    switch (stepKey) {
      case 'eas:create-project': {
        const existing = await this.apiClient.getProject(config.project_name, config.organization);
        const projectId = existing ?? await this.apiClient.createProject(config.project_name, config.organization);
        return {
          status: 'completed',
          resourcesProduced: {
            eas_project_id: projectId,
            eas_project_slug: config.project_name,
            ...(config.organization ? { expo_account: config.organization } : {}),
          },
        };
      }
      case 'eas:configure-build-profiles': {
        const expo = this.apiClient instanceof ExpoGraphqlEasApiClient ? this.apiClient : null;
        if (!expo) {
          throw new AdapterError(
            'Configure build profiles requires the real Expo GraphQL client (Expo token).',
            'eas',
            'executeStep',
          );
        }
        const env = (context.environment ?? config.environments[0] ?? 'development') as Environment;
        const appId = context.upstreamResources['eas_project_id'] ?? '';
        if (!appId) {
          throw new AdapterError('Create the EAS project first (missing eas_project_id).', 'eas', 'executeStep');
        }
        await expo.ensureStudioEasEnvironmentMarkerOnApp(appId, env);
        return {
          status: 'completed',
          resourcesProduced: {},
          userPrompt:
            'Studio recorded which EAS environment slot matches this Studio environment. You must still maintain `eas.json` build profiles (development / preview / production) in your app repository — Expo builds read that file, not Studio.',
        };
      }
      case 'eas:store-token-in-github': {
        if (!this.githubClient) {
          throw new AdapterError(
            'Storing the Expo token in GitHub requires a GitHub PAT (organization settings).',
            'eas',
            'executeStep',
          );
        }
        const repoUrl = context.upstreamResources['github_repo_url'] ?? '';
        if (!repoUrl) {
          throw new AdapterError('Missing github_repo_url — create the GitHub repository first.', 'eas', 'executeStep');
        }
        const { owner, repo } = parseGithubHttpsRepo(repoUrl);
        // Always read the real token from the vault. The upstream
        // `user:provide-expo-token` gate produces the literal sentinel string
        // `[stored in vault]` for `expo_token` so the secret never travels
        // through plan state — using upstreamResources here would upload that
        // sentinel as the secret value (causing EAS "bearer token is invalid").
        const token = (await context.vaultRead('eas/expo_token'))?.trim();
        if (!token) {
          throw new AdapterError(
            'No Expo robot token available. Connect EAS under organization settings so the token is stored in the vault.',
            'eas',
            'executeStep',
          );
        }
        await this.githubClient.setRepositorySecret(owner, repo, 'EXPO_TOKEN', token);
        return {
          status: 'completed',
          resourcesProduced: {},
          userPrompt:
            'GitHub Actions can use secret EXPO_TOKEN. Reference it in workflow env (e.g. EXPO_TOKEN: ${{ secrets.EXPO_TOKEN }}).',
        };
      }
      case 'eas:write-eas-json': {
        if (!this.githubClient) {
          throw new AdapterError(
            'Writing eas.json requires a GitHub PAT (organization settings).',
            'eas',
            'executeStep',
          );
        }
        const repoUrl = context.upstreamResources['github_repo_url'] ?? '';
        if (!repoUrl) {
          throw new AdapterError(
            'Missing github_repo_url — create the GitHub repository first.',
            'eas',
            'executeStep',
          );
        }
        const easProjectId = context.upstreamResources['eas_project_id']?.trim();
        if (!easProjectId) {
          throw new AdapterError(
            'Missing eas_project_id — create the EAS project first.',
            'eas',
            'executeStep',
          );
        }
        const { owner, repo } = parseGithubHttpsRepo(repoUrl);

        const written: string[] = [];
        const skipped: string[] = [];

        const existingEasJson = await this.githubClient.getRepoFile(owner, repo, 'eas.json');
        if (!existingEasJson) {
          const submitInfo: EasJsonSubmitInfo = {
            ascAppId: context.upstreamResources['asc_app_id']?.trim() || undefined,
            appleTeamId: context.upstreamResources['apple_team_id']?.trim() || undefined,
            appleId: context.upstreamResources['apple_id']?.trim() || undefined,
          };
          const content = buildDefaultEasJson(config.environments, submitInfo);
          await this.githubClient.upsertRepoFile(
            owner,
            repo,
            'eas.json',
            content,
            'chore: add eas.json (Studio bootstrap)',
          );
          written.push('eas.json');
          this.log.info('Wrote default eas.json to repo', {
            owner,
            repo,
            includedSubmit: Object.keys(submitInfo).filter((k) => submitInfo[k as keyof EasJsonSubmitInfo]),
          });
        } else {
          skipped.push('eas.json (already present)');
          this.log.info('eas.json already present in repo, leaving untouched', { owner, repo });
        }

        const appConfigTs = await this.githubClient.getRepoFile(owner, repo, 'app.config.ts');
        const appConfigJs = await this.githubClient.getRepoFile(owner, repo, 'app.config.js');

        let appJsonNote: string | undefined;
        const appConfigSource = appConfigTs ?? appConfigJs;
        const appConfigPath = appConfigTs ? 'app.config.ts' : appConfigJs ? 'app.config.js' : null;

        if (appConfigSource && appConfigPath) {
          let working = appConfigSource.content;
          let mutated = false;
          let configNote: string | undefined;

          const withProjectId = patchAppConfigJsWithEasProjectId(working, easProjectId);
          if (withProjectId === null) {
            if (!new RegExp(`projectId\\s*:\\s*['"\`]${easProjectId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`).test(working)) {
              configNote = `Detected ${appConfigPath} but couldn't safely auto-add \`extra.eas.projectId = "${easProjectId}"\` — add it yourself.`;
            }
          } else {
            working = withProjectId;
            mutated = true;
          }

          const withEncryption = patchAppConfigJsWithEncryptionDeclaration(working);
          if (withEncryption !== null) {
            working = withEncryption;
            mutated = true;
          }

          if (mutated) {
            await this.githubClient.upsertRepoFile(
              owner,
              repo,
              appConfigPath,
              working,
              'chore: configure Expo app for EAS build (Studio)',
            );
            written.push(appConfigPath);
            this.log.info('Patched app.config for EAS build', { owner, repo, easProjectId, file: appConfigPath });
          } else {
            skipped.push(`${appConfigPath} (already configured or unrecognized shape)`);
          }
          appJsonNote = configNote;
        } else {
          const appJson = await this.githubClient.getRepoFile(owner, repo, 'app.json');
          if (!appJson) {
            appJsonNote = `No app.json or app.config.{ts,js} found in the repo root — push your Expo project (or set \`extra.eas.projectId = "${easProjectId}"\` in your app config) before running EAS build.`;
            skipped.push('app.json (missing)');
          } else {
            let working = appJson.content;
            let mutated = false;

            const withProjectId = patchAppJsonWithEasProjectId(working, easProjectId);
            if (withProjectId !== null) {
              working = withProjectId;
              mutated = true;
            }
            const withEncryption = patchAppJsonWithEncryptionDeclaration(working);
            if (withEncryption !== null) {
              working = withEncryption;
              mutated = true;
            }

            if (mutated) {
              await this.githubClient.upsertRepoFile(
                owner,
                repo,
                'app.json',
                working,
                'chore: configure Expo app for EAS build (Studio)',
              );
              written.push('app.json');
              this.log.info('Patched app.json for EAS build', { owner, repo, easProjectId });
            } else {
              skipped.push('app.json (no changes needed)');
            }
          }
        }

        const summary = [
          written.length > 0 ? `Committed: ${written.join(', ')}.` : 'No files committed.',
          skipped.length > 0 ? `Skipped: ${skipped.join(', ')}.` : null,
          appJsonNote,
        ]
          .filter(Boolean)
          .join(' ');

        return {
          status: 'completed',
          resourcesProduced: { eas_json_path: 'eas.json' },
          userPrompt: summary,
        };
      }
      case 'eas:configure-submit-apple': {
        const expo = this.apiClient instanceof ExpoGraphqlEasApiClient ? this.apiClient : null;
        if (!expo) {
          throw new AdapterError('Configure EAS Submit (Apple) requires the real Expo GraphQL client.', 'eas', 'executeStep');
        }
        const appId = context.upstreamResources['eas_project_id'] ?? '';
        const bundleId = config.bundle_id?.trim();
        if (!appId || !bundleId) {
          throw new AdapterError(
            'Missing eas_project_id or bundle_id. Ensure the Studio project has a bundle id and the EAS project exists.',
            'eas',
            'executeStep',
          );
        }
        const issuer = await this.readAscIssuerId(context);
        const keyId =
          context.upstreamResources['asc_api_key_id']?.trim() ||
          (await this.readVaultSecret(context, 'asc_api_key_id'));
        let p8 =
          context.upstreamResources['asc_api_key_p8'] === 'vaulted'
            ? null
            : context.upstreamResources['asc_api_key_p8']?.trim();
        if (!p8) p8 = (await this.readVaultSecret(context, 'asc_api_key_p8')) ?? null;
        if (!issuer || !keyId || !p8) {
          throw new AdapterError(
            'App Store Connect API key material is incomplete. Store shared credentials as apple/asc_issuer_id, ' +
              'apple/asc_api_key_id, and apple/asc_api_key_p8 (recommended), or use <projectId>/asc_issuer_id, ' +
              '<projectId>/asc_api_key_id, and <projectId>/asc_api_key_p8 to override for one project. ' +
              'Generate the key in App Store Connect → Users and Access → Keys.',
            'eas',
            'executeStep',
          );
        }
        await expo.configureIosEasSubmit({
          expoAppId: appId,
          organization: config.organization,
          bundleId,
          issuerIdentifier: issuer,
          keyIdentifier: keyId,
          keyP8: p8,
        });
        return {
          status: 'completed',
          resourcesProduced: {},
          userPrompt:
            'Expo is configured to use this ASC API key for iOS submissions. You still need valid `eas.json` submit profile(s) and matching credentials in the repo or EAS.',
        };
      }
      case 'eas:configure-submit-android': {
        const expo = this.apiClient instanceof ExpoGraphqlEasApiClient ? this.apiClient : null;
        if (!expo) {
          throw new AdapterError(
            'Configure EAS Submit (Android) requires the real Expo GraphQL client.',
            'eas',
            'executeStep',
          );
        }
        const appId = context.upstreamResources['eas_project_id'] ?? '';
        const pkg = (config.android_package ?? config.bundle_id)?.trim();
        if (!appId || !pkg) {
          throw new AdapterError(
            'Missing eas_project_id or Android application id. Set the Studio project bundle / package id.',
            'eas',
            'executeStep',
          );
        }
        const jsonRaw =
          (await context.vaultRead(`${context.projectId}/google_play_service_account_json`)) ??
          (await context.vaultRead(`${context.projectId}/play_service_account_json`));
        if (!jsonRaw?.trim()) {
          throw new AdapterError(
            'Google Play service account JSON not found. Upload it to the vault as ' +
              `${context.projectId}/google_play_service_account_json (JSON key with Play Console API access).`,
            'eas',
            'executeStep',
          );
        }
        let jsonKey: Record<string, unknown>;
        try {
          jsonKey = JSON.parse(jsonRaw) as Record<string, unknown>;
        } catch {
          throw new AdapterError(
            'google_play_service_account_json in the vault is not valid JSON.',
            'eas',
            'executeStep',
          );
        }
        await expo.configureAndroidEasSubmit({
          expoAppId: appId,
          organization: config.organization,
          androidApplicationId: pkg,
          googleServiceAccountJson: jsonKey,
        });
        return {
          status: 'completed',
          resourcesProduced: {},
          userPrompt:
            'Expo stores a Google Play service account key for Android submissions. Confirm `eas.json` submit config and Play Console API access for that service account.',
        };
      }
      default:
        throw new AdapterError(`Unknown EAS step: ${stepKey}`, 'eas', 'executeStep');
    }
  }

  async checkStep(
    stepKey: string,
    config: EasManifestConfig,
    context: StepContext,
  ): Promise<StepResult> {
    switch (stepKey) {
      case 'eas:create-project': {
        const projectId = context.upstreamResources['eas_project_id']?.trim();
        if (!projectId) {
          return {
            status: 'failed',
            resourcesProduced: {},
            error:
              'EAS project id is missing. Re-run "Create EAS Project" after connecting Expo / EAS credentials.',
          };
        }
        return { status: 'completed', resourcesProduced: { eas_project_id: projectId } };
      }
      case 'eas:configure-build-profiles': {
        const projectId = context.upstreamResources['eas_project_id']?.trim();
        if (!projectId) {
          return {
            status: 'failed',
            resourcesProduced: {},
            error: 'Cannot validate build profile setup without eas_project_id.',
          };
        }
        return { status: 'completed', resourcesProduced: {} };
      }
      case 'eas:store-token-in-github': {
        const repoUrl = context.upstreamResources['github_repo_url']?.trim();
        if (!repoUrl) {
          return {
            status: 'failed',
            resourcesProduced: {},
            error: 'GitHub repository URL is missing. Re-run GitHub repository provisioning first.',
          };
        }
        return { status: 'completed', resourcesProduced: {} };
      }
      case 'eas:write-eas-json': {
        const repoUrl = context.upstreamResources['github_repo_url']?.trim();
        const easProjectId = context.upstreamResources['eas_project_id']?.trim();
        if (!repoUrl || !easProjectId) {
          return {
            status: 'failed',
            resourcesProduced: {},
            error:
              'Cannot validate eas.json bootstrap without github_repo_url and eas_project_id. Run the GitHub repo and EAS project steps first.',
          };
        }
        if (!this.githubClient) {
          return {
            status: 'failed',
            resourcesProduced: {},
            error: 'No GitHub client configured — cannot inspect repository contents.',
          };
        }
        const { owner, repo } = parseGithubHttpsRepo(repoUrl);
        const easJson = await this.githubClient.getRepoFile(owner, repo, 'eas.json');
        if (!easJson) {
          return {
            status: 'failed',
            resourcesProduced: {},
            error: `eas.json is missing from ${owner}/${repo}. Re-run "Commit eas.json to Repo".`,
          };
        }
        return { status: 'completed', resourcesProduced: { eas_json_path: 'eas.json' } };
      }
      case 'eas:configure-submit-apple': {
        const easProjectId = context.upstreamResources['eas_project_id']?.trim();
        const ascKeyId =
          context.upstreamResources['asc_api_key_id']?.trim() ||
          (await this.readVaultSecret(context, 'asc_api_key_id'));
        const ascP8 = await this.readVaultSecret(context, 'asc_api_key_p8');
        const ascIssuer = await this.readAscIssuerId(context);
        if (!easProjectId || !ascKeyId || !ascP8) {
          return {
            status: 'failed',
            resourcesProduced: {},
            error:
              'Apple submit prerequisites are incomplete. Expected eas_project_id plus ASC credentials in vault: issuer (asc_issuer_id or app_store_connect_issuer_id), key id (asc_api_key_id), and private key (asc_api_key_p8) at apple/* shared scope or <projectId>/* override scope.',
          };
        }
        if (!ascIssuer) {
          return {
            status: 'failed',
            resourcesProduced: {},
            error:
              'ASC issuer id is missing. Store asc_issuer_id (or app_store_connect_issuer_id) in vault at apple/* shared scope or <projectId>/* override scope.',
          };
        }
        return { status: 'completed', resourcesProduced: {} };
      }
      case 'eas:configure-submit-android': {
        const easProjectId = context.upstreamResources['eas_project_id']?.trim();
        const playJson =
          (await context.vaultRead(`${context.projectId}/google_play_service_account_json`))?.trim() ||
          (await context.vaultRead(`${context.projectId}/play_service_account_json`))?.trim();
        if (!easProjectId || !playJson) {
          return {
            status: 'failed',
            resourcesProduced: {},
            error:
              'Android submit prerequisites are incomplete. Expected eas_project_id and a vaulted Google Play service account JSON.',
          };
        }
        return { status: 'completed', resourcesProduced: {} };
      }
      default:
        return { status: 'completed', resourcesProduced: {} };
    }
  }

  async validate(
    manifest: EasManifestConfig,
    liveState: ProviderState | null,
  ): Promise<DriftReport> {
    const differences: DriftDifference[] = [];

    if (!liveState) {
      return {
        provider_id: `eas-${manifest.project_name}`,
        provider_type: 'eas',
        manifest_state: manifest,
        live_state: null,
        differences: [
          {
            field: 'project',
            manifest_value: manifest.project_name,
            live_value: null,
            conflict_type: 'missing_in_live',
          },
        ],
        orphaned_resources: [],
        requires_user_decision: false,
      };
    }

    const projectId = liveState.resource_ids['project_id'];
    if (!projectId) {
      differences.push({
        field: 'project_id',
        manifest_value: manifest.project_name,
        live_value: null,
        conflict_type: 'missing_in_live',
      });
    } else {
      for (const env of manifest.environments) {
        if (!liveState.resource_ids[`env_${env}`]) {
          differences.push({
            field: `environment.${env}`,
            manifest_value: env,
            live_value: null,
            conflict_type: 'missing_in_live',
          });
        }
      }
    }

    return {
      provider_id: liveState.provider_id,
      provider_type: 'eas',
      manifest_state: manifest,
      live_state: liveState,
      differences,
      orphaned_resources: [],
      requires_user_decision: false,
    };
  }

  async reconcile(
    report: DriftReport,
    direction: ReconcileDirection,
  ): Promise<ProviderState> {
    const manifest = report.manifest_state as EasManifestConfig;

    if (!report.live_state) {
      return this.provision(manifest);
    }

    if (direction === 'manifest→live') {
      const projectId = report.live_state.resource_ids['project_id'];
      if (projectId) {
        for (const diff of report.differences) {
          if (diff.conflict_type === 'missing_in_live' && diff.field.startsWith('environment.')) {
            const env = diff.field.replace('environment.', '') as Environment;
            if (this.apiClient instanceof ExpoGraphqlEasApiClient) {
              await this.apiClient.ensureStudioEasEnvironmentMarkerOnApp(projectId, env);
            } else {
              await this.apiClient.uploadEnvFile(projectId, env, {});
            }
            report.live_state.resource_ids[`env_${env}`] = 'initialized';
          }
        }
      }
    }

    report.live_state.updated_at = Date.now();
    return report.live_state;
  }

  async extractCredentials(state: ProviderState): Promise<Record<string, string>> {
    return {
      project_id: state.resource_ids['project_id'] ?? '',
    };
  }

  private hashConfig(config: EasManifestConfig): string {
    return crypto
      .createHash('sha256')
      .update(JSON.stringify(config))
      .digest('hex')
      .slice(0, 16);
  }
}
