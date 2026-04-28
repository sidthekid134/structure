/**
 * Expo GraphQL API client for EAS project create / lookup.
 * Mirrors eas-cli mutations (CreateApp, AppByFullName) using the stored EXPO_TOKEN.
 */

import type { Environment } from './types.js';
import type { EasApiClient } from './eas.js';

const EXPO_GRAPHQL_URL =
  process.env['EXPO_STAGING'] === '1' || process.env['EXPO_STAGING'] === 'true'
    ? 'https://staging-api.expo.dev/graphql'
    : 'https://api.expo.dev/graphql';

const CURRENT_ACTOR_QUERY = `
  query StudioCurrentActor {
    meActor {
      __typename
      accounts {
        id
        name
      }
    }
  }
`;

const APP_BY_FULL_NAME_QUERY = `
  query StudioAppByFullName($fullName: String!) {
    app {
      byFullName(fullName: $fullName) {
        id
      }
    }
  }
`;

const CREATE_APP_MUTATION = `
  mutation StudioCreateApp($appInput: AppInput!) {
    app {
      createApp(appInput: $appInput) {
        id
      }
    }
  }
`;

const SCHEDULE_APP_DELETION_MUTATION = `
  mutation StudioScheduleAppDeletion($appId: ID!) {
    app {
      scheduleAppDeletion(appId: $appId) {
        id
      }
    }
  }
`;

const APP_BY_ID_FOR_AUTOMATION = `
  query StudioAppByIdAutomation($appId: String!) {
    app {
      byId(appId: $appId) {
        id
        ownerAccount {
          id
        }
        githubRepository {
          id
          metadata {
            githubRepoOwnerName
            githubRepoName
          }
        }
        iosAppCredentials {
          id
        }
        androidAppCredentials {
          id
          applicationIdentifier
        }
      }
    }
  }
`;

const ACCOUNT_GITHUB_INSTALLATIONS = `
  query StudioAccountGithubInstallations($accountId: String!) {
    account {
      byId(accountId: $accountId) {
        id
        githubAppInstallations {
          id
          installationIdentifier
          metadata {
            githubAccountName
            installationStatus
          }
        }
      }
    }
  }
`;

const ACCOUNT_APPLE_IDS = `
  query StudioAccountAppleAppIdentifiers($accountId: String!) {
    account {
      byId(accountId: $accountId) {
        appleAppIdentifiers {
          id
          bundleIdentifier
        }
      }
    }
  }
`;

const ACCOUNT_ASC_KEYS = `
  query StudioAccountAscKeys($accountId: String!) {
    account {
      byId(accountId: $accountId) {
        appStoreConnectApiKeys {
          id
          issuerIdentifier
          keyIdentifier
        }
      }
    }
  }
`;

const CREATE_GITHUB_REPO_LINK = `
  mutation StudioCreateGitHubRepository($data: CreateGitHubRepositoryInput!) {
    githubRepository {
      createGitHubRepository(githubRepositoryData: $data) {
        id
      }
    }
  }
`;

const CREATE_ENV_VAR_FOR_APP = `
  mutation StudioCreateEnvVarForApp($appId: ID!, $input: CreateEnvironmentVariableInput!) {
    environmentVariable {
      createEnvironmentVariableForApp(appId: $appId, environmentVariableData: $input) {
        id
        name
      }
    }
  }
`;

const APP_ENV_VARS_BY_NAME = `
  query StudioAppEnvVarsByName($appId: String!, $filterNames: [String!]) {
    app {
      byId(appId: $appId) {
        id
        environmentVariables(filterNames: $filterNames) {
          id
          name
          value
          environments
        }
      }
    }
  }
`;

const DELETE_ENV_VAR = `
  mutation StudioDeleteEnvVar($id: ID!) {
    environmentVariable {
      deleteEnvironmentVariable(id: $id) {
        id
      }
    }
  }
`;

const CREATE_ASC_API_KEY = `
  mutation StudioCreateAscApiKey($accountId: ID!, $input: AppStoreConnectApiKeyInput!) {
    appStoreConnectApiKey {
      createAppStoreConnectApiKey(accountId: $accountId, appStoreConnectApiKeyInput: $input) {
        id
      }
    }
  }
`;

const CREATE_IOS_APP_CREDENTIALS = `
  mutation StudioCreateIosAppCredentials(
    $appId: ID!
    $appleAppIdentifierId: ID!
    $input: IosAppCredentialsInput!
  ) {
    iosAppCredentials {
      createIosAppCredentials(
        appId: $appId
        appleAppIdentifierId: $appleAppIdentifierId
        iosAppCredentialsInput: $input
      ) {
        id
      }
    }
  }
`;

const SET_ASC_FOR_IOS_SUBMIT = `
  mutation StudioSetAscForIosSubmit($iosAppCredentialsId: ID!, $ascApiKeyId: ID!) {
    iosAppCredentials {
      setAppStoreConnectApiKeyForSubmissions(id: $iosAppCredentialsId, ascApiKeyId: $ascApiKeyId) {
        id
      }
    }
  }
`;

const CREATE_GOOGLE_SA_KEY = `
  mutation StudioCreateGoogleServiceAccountKey($accountId: ID!, $input: GoogleServiceAccountKeyInput!) {
    googleServiceAccountKey {
      createGoogleServiceAccountKey(accountId: $accountId, googleServiceAccountKeyInput: $input) {
        id
      }
    }
  }
`;

const CREATE_ANDROID_APP_CREDENTIALS = `
  mutation StudioCreateAndroidAppCredentials(
    $appId: ID!
    $applicationIdentifier: String!
    $input: AndroidAppCredentialsInput!
  ) {
    androidAppCredentials {
      createAndroidAppCredentials(
        appId: $appId
        applicationIdentifier: $applicationIdentifier
        androidAppCredentialsInput: $input
      ) {
        id
      }
    }
  }
`;

const SET_ANDROID_SA_FOR_SUBMIT = `
  mutation StudioSetAndroidSaForSubmit($androidCredentialsId: ID!, $googleServiceAccountKeyId: ID!) {
    androidAppCredentials {
      setGoogleServiceAccountKeyForSubmissions(
        id: $androidCredentialsId
        googleServiceAccountKeyId: $googleServiceAccountKeyId
      ) {
        id
      }
    }
  }
`;

// ---------------------------------------------------------------------------
// EAS-managed iOS App Store distribution signing
// ---------------------------------------------------------------------------
//
// Mutation/query field names are taken verbatim from eas-cli main:
//   src/credentials/ios/api/graphql/{mutations,queries}/Apple*.ts
//   src/credentials/ios/api/graphql/{mutations,queries}/IosAppBuildCredentials*.ts
// Schema is treated as eas-cli's source of truth — if Expo renames a field,
// upgrade @expo/apple-utils alongside this file.

const APPLE_TEAM_BY_IDENTIFIER_QUERY = `
  query StudioAppleTeamByIdentifier($accountId: ID!, $appleTeamIdentifier: String!) {
    appleTeam {
      byAppleTeamIdentifier(accountId: $accountId, identifier: $appleTeamIdentifier) {
        id
      }
    }
  }
`;

const CREATE_APPLE_TEAM_MUTATION = `
  mutation StudioCreateAppleTeam($appleTeamInput: AppleTeamInput!, $accountId: ID!) {
    appleTeam {
      createAppleTeam(appleTeamInput: $appleTeamInput, accountId: $accountId) {
        id
      }
    }
  }
`;

const APPLE_APP_IDENTIFIER_BY_BUNDLE_ID_QUERY = `
  query StudioAppleAppIdentifierByBundle($accountName: String!, $bundleIdentifier: String!) {
    account {
      byName(accountName: $accountName) {
        id
        appleAppIdentifiers(bundleIdentifier: $bundleIdentifier) {
          id
          bundleIdentifier
        }
      }
    }
  }
`;

const CREATE_APPLE_APP_IDENTIFIER_MUTATION = `
  mutation StudioCreateAppleAppIdentifier(
    $appleAppIdentifierInput: AppleAppIdentifierInput!
    $accountId: ID!
  ) {
    appleAppIdentifier {
      createAppleAppIdentifier(
        appleAppIdentifierInput: $appleAppIdentifierInput
        accountId: $accountId
      ) {
        id
      }
    }
  }
`;

const IOS_APP_BUILD_CREDENTIALS_QUERY = `
  query StudioIosBuildCredsByAppleIdentifier(
    $appId: String!
    $appleAppIdentifierId: String!
    $iosDistributionType: IosDistributionType
  ) {
    app {
      byId(appId: $appId) {
        id
        iosAppCredentials(filter: { appleAppIdentifierId: $appleAppIdentifierId }) {
          id
          iosAppBuildCredentialsList(filter: { iosDistributionType: $iosDistributionType }) {
            id
            distributionCertificate {
              id
              developerPortalIdentifier
              serialNumber
            }
            provisioningProfile {
              id
              developerPortalIdentifier
            }
          }
        }
      }
    }
  }
`;

const CREATE_APPLE_DIST_CERT_MUTATION = `
  mutation StudioCreateAppleDistCert(
    $appleDistributionCertificateInput: AppleDistributionCertificateInput!
    $accountId: ID!
  ) {
    appleDistributionCertificate {
      createAppleDistributionCertificate(
        appleDistributionCertificateInput: $appleDistributionCertificateInput
        accountId: $accountId
      ) {
        id
      }
    }
  }
`;

const CREATE_APPLE_PROVISIONING_PROFILE_MUTATION = `
  mutation StudioCreateAppleProvisioningProfile(
    $appleProvisioningProfileInput: AppleProvisioningProfileInput!
    $accountId: ID!
    $appleAppIdentifierId: ID!
  ) {
    appleProvisioningProfile {
      createAppleProvisioningProfile(
        appleProvisioningProfileInput: $appleProvisioningProfileInput
        accountId: $accountId
        appleAppIdentifierId: $appleAppIdentifierId
      ) {
        id
      }
    }
  }
`;

const CREATE_IOS_APP_BUILD_CREDS_MUTATION = `
  mutation StudioCreateIosAppBuildCreds(
    $iosAppBuildCredentialsInput: IosAppBuildCredentialsInput!
    $iosAppCredentialsId: ID!
  ) {
    iosAppBuildCredentials {
      createIosAppBuildCredentials(
        iosAppBuildCredentialsInput: $iosAppBuildCredentialsInput
        iosAppCredentialsId: $iosAppCredentialsId
      ) {
        id
      }
    }
  }
`;

const SET_DIST_CERT_ON_BUILD_CREDS_MUTATION = `
  mutation StudioSetDistCertOnBuildCreds(
    $iosAppBuildCredentialsId: ID!
    $distributionCertificateId: ID!
  ) {
    iosAppBuildCredentials {
      setDistributionCertificate(
        id: $iosAppBuildCredentialsId
        distributionCertificateId: $distributionCertificateId
      ) {
        id
      }
    }
  }
`;

const SET_PROVISIONING_PROFILE_ON_BUILD_CREDS_MUTATION = `
  mutation StudioSetProvisioningProfileOnBuildCreds(
    $iosAppBuildCredentialsId: ID!
    $provisioningProfileId: ID!
  ) {
    iosAppBuildCredentials {
      setProvisioningProfile(
        id: $iosAppBuildCredentialsId
        provisioningProfileId: $provisioningProfileId
      ) {
        id
      }
    }
  }
`;

interface GraphQLErrorItem {
  message: string;
  extensions?: { errorCode?: string };
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: GraphQLErrorItem[];
}

/** Thrown for GraphQL responses with a top-level `errors` array (partial data may still be present). */
export class ExpoGraphqlRequestError extends Error {
  readonly graphQLErrors: GraphQLErrorItem[];

  constructor(message: string, graphQLErrors: GraphQLErrorItem[]) {
    super(message);
    this.name = 'ExpoGraphqlRequestError';
    this.graphQLErrors = graphQLErrors;
  }
}

interface MeActorData {
  meActor: {
    __typename: string;
    accounts: Array<{ id: string; name: string }>;
  };
}

interface AppByFullNameData {
  app: { byFullName: { id: string } | null };
}

interface CreateAppData {
  app: { createApp: { id: string } };
}

interface ScheduleAppDeletionData {
  app: { scheduleAppDeletion: { id: string } };
}

function graphQLErrorCodes(errors: GraphQLErrorItem[]): string[] {
  return errors.map((e) => e.extensions?.errorCode ?? '').filter(Boolean);
}

async function expoGraphqlRequest<T>(token: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(EXPO_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      // Some CDNs/API gateways treat missing UA as bot traffic.
      'User-Agent': 'StructureStudio/1.0 (EAS provisioning)',
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`Expo GraphQL HTTP ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as GraphQLResponse<T>;
  if (body.errors?.length) {
    const msg = body.errors.map((e) => e.message).join('; ');
    throw new ExpoGraphqlRequestError(msg, body.errors);
  }
  if (body.data === undefined || body.data === null) {
    throw new Error('Expo GraphQL returned no data');
  }
  return body.data;
}

/**
 * Expo returns EXPERIENCE_NOT_FOUND in extensions when @account/slug does not exist.
 * The human-readable message often does not include that code, so we must read extensions.
 */
function isExperienceNotFoundFromError(err: unknown): boolean {
  if (err instanceof ExpoGraphqlRequestError) {
    const codes = graphQLErrorCodes(err.graphQLErrors);
    return codes.length > 0 && codes.every((c) => c === 'EXPERIENCE_NOT_FOUND');
  }
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('EXPERIENCE_NOT_FOUND');
}

function isAppNotFoundGraphqlError(err: unknown): boolean {
  if (!(err instanceof ExpoGraphqlRequestError)) return false;
  const codes = graphQLErrorCodes(err.graphQLErrors);
  if (codes.some((c) => c === 'EXPERIENCE_NOT_FOUND')) return true;
  return err.graphQLErrors.some(
    (e) =>
      /not\s+found|does\s+not\s+exist|unknown\s+app/i.test(e.message) ||
      e.extensions?.errorCode === 'APP_NOT_FOUND',
  );
}

/** Maps Studio plan environment names to Expo EAS env-var slot names (GraphQL scalar). */
function studioEnvironmentToExpoVariableEnvironments(studioEnv: string): string[] {
  const e = studioEnv.toLowerCase();
  if (e === 'development') return ['DEVELOPMENT'];
  if (e === 'preview') return ['PREVIEW'];
  if (e === 'production') return ['PRODUCTION'];
  throw new Error(
    `Unsupported Studio environment "${studioEnv}". Supported environments: development, preview, production.`,
  );
}

function studioEnvironmentsToExpoVariableEnvironments(studioEnvironments: string[]): string[] {
  const out: string[] = [];
  for (const env of studioEnvironments) {
    const mapped = studioEnvironmentToExpoVariableEnvironments(env);
    for (const slot of mapped) {
      if (!out.includes(slot)) out.push(slot);
    }
  }
  return out;
}

export class ExpoGraphqlEasApiClient implements EasApiClient {
  constructor(private readonly expoToken: string) {
    if (!expoToken?.trim()) {
      throw new Error('Expo token is required for EAS API access.');
    }
  }

  private async resolveAccountId(organization?: string): Promise<{ accountId: string; accountName: string }> {
    const data = await expoGraphqlRequest<MeActorData>(this.expoToken, CURRENT_ACTOR_QUERY, {});
    const accounts = data.meActor?.accounts ?? [];
    if (accounts.length === 0) {
      throw new Error('No Expo accounts available for this token.');
    }
    const org = organization?.trim();
    if (org) {
      const match = accounts.find((a) => a.name === org);
      if (!match) {
        throw new Error(
          `Expo account "${org}" is not accessible with this token. Available: ${accounts.map((a) => a.name).join(', ')}.`,
        );
      }
      return { accountId: match.id, accountName: match.name };
    }
    if (accounts.length > 1) {
      throw new Error(
        `Multiple Expo accounts are linked to this token (${accounts.map((a) => a.name).join(', ')}). ` +
        'Set the Expo account / org slug on this Studio project so EAS knows which account should own the app.',
      );
    }
    return { accountId: accounts[0]!.id, accountName: accounts[0]!.name };
  }

  async getProject(projectName: string, organization?: string): Promise<string | null> {
    const { accountName } = await this.resolveAccountId(organization);
    const fullName = `@${accountName}/${projectName}`;
    try {
      const data = await expoGraphqlRequest<AppByFullNameData>(this.expoToken, APP_BY_FULL_NAME_QUERY, {
        fullName,
      });
      return data.app?.byFullName?.id ?? null;
    } catch (err) {
      if (isExperienceNotFoundFromError(err)) return null;
      throw err;
    }
  }

  async createProject(projectName: string, organization?: string): Promise<string> {
    const { accountId } = await this.resolveAccountId(organization);
    const data = await expoGraphqlRequest<CreateAppData>(this.expoToken, CREATE_APP_MUTATION, {
      appInput: {
        accountId,
        projectName,
      },
    });
    const id = data.app?.createApp?.id;
    if (!id) {
      throw new Error('Expo GraphQL createApp did not return a project id.');
    }
    return id;
  }

  async deleteProject(projectId: string): Promise<void> {
    const id = projectId?.trim();
    if (!id) {
      throw new Error('Expo project id is required for deletion.');
    }
    try {
      await expoGraphqlRequest<ScheduleAppDeletionData>(this.expoToken, SCHEDULE_APP_DELETION_MUTATION, {
        appId: id,
      });
    } catch (err) {
      if (isAppNotFoundGraphqlError(err)) return;
      throw err;
    }
  }

  /**
   * Returns true when the Expo app is already linked to the expected GitHub repository.
   */
  async isGitHubRepositoryLinkedToApp(input: {
    expoAppId: string;
    organization?: string;
    githubOwner: string;
    githubRepoName: string;
  }): Promise<boolean> {
    const { accountId } = await this.resolveAccountId(input.organization);
    type AppAuto = {
      app: {
        byId: {
          id: string;
          ownerAccount: { id: string };
          githubRepository: {
            metadata: { githubRepoOwnerName: string; githubRepoName: string };
          } | null;
        } | null;
      };
    };
    const appData = await expoGraphqlRequest<AppAuto>(this.expoToken, APP_BY_ID_FOR_AUTOMATION, {
      appId: input.expoAppId,
    });
    const app = appData.app?.byId;
    if (!app) {
      throw new Error(`Expo app "${input.expoAppId}" was not found for this token.`);
    }
    if (app.ownerAccount.id !== accountId) {
      throw new Error('Expo app owner account does not match the configured Expo organization for this Studio project.');
    }
    const linked = app.githubRepository;
    return !!(
      linked &&
      linked.metadata.githubRepoOwnerName.toLowerCase() === input.githubOwner.toLowerCase() &&
      linked.metadata.githubRepoName.toLowerCase() === input.githubRepoName.toLowerCase()
    );
  }

  /**
   * Links an existing GitHub repo to the Expo app using the Expo GitHub App installation
   * on the same GitHub owner as `githubOwner`.
   * @see https://docs.expo.dev/eas-update/github-integration/
   */
  async linkGitHubRepositoryToApp(input: {
    expoAppId: string;
    organization?: string;
    githubOwner: string;
    githubRepoName: string;
    githubRepoDatabaseId: number;
    defaultBranch: string;
  }): Promise<void> {
    const alreadyLinked = await this.isGitHubRepositoryLinkedToApp({
      expoAppId: input.expoAppId,
      organization: input.organization,
      githubOwner: input.githubOwner,
      githubRepoName: input.githubRepoName,
    });
    if (alreadyLinked) {
      return;
    }
    const { accountId } = await this.resolveAccountId(input.organization);

    type AccGh = {
      account: {
        byId: {
          githubAppInstallations: Array<{
            id: string;
            metadata: { githubAccountName?: string | null; installationStatus: string };
          }>;
        } | null;
      };
    };
    const accData = await expoGraphqlRequest<AccGh>(this.expoToken, ACCOUNT_GITHUB_INSTALLATIONS, {
      accountId,
    });
    const installations = accData.account?.byId?.githubAppInstallations ?? [];
    const ownerLower = input.githubOwner.toLowerCase();
    const inst = installations.find(
      (i) =>
        i.metadata.installationStatus === 'ACTIVE' &&
        (i.metadata.githubAccountName?.toLowerCase() ?? '') === ownerLower,
    );
    if (!inst) {
      throw new Error(
        `No active Expo GitHub App installation found for GitHub owner "${input.githubOwner}" on your Expo account. ` +
        'Install the Expo GitHub App for that user or organization (Expo dashboard → Account settings → GitHub), grant access to the repository, then re-run this step. ' +
        'Docs: https://docs.expo.dev/eas-update/github-integration/',
      );
    }

    type CreateGh = { githubRepository: { createGitHubRepository: { id: string } } };
    await expoGraphqlRequest<CreateGh>(this.expoToken, CREATE_GITHUB_REPO_LINK, {
      data: {
        appId: input.expoAppId,
        githubAppInstallationId: inst.id,
        githubRepositoryIdentifier: input.githubRepoDatabaseId,
        nodeIdentifier: input.defaultBranch || 'main',
      },
    });
  }

  /**
   * Creates a non-secret EAS environment variable marking which Studio environment this Expo build channel maps to.
   * Full `eas.json` build profiles must still live in the app repository (or use Expo "Configure EAS" from the dashboard).
   */
  async ensureStudioEasEnvironmentMarkerOnApp(expoAppId: string, studioEnvironment: string): Promise<void> {
    const expoSlot = studioEnvironmentToExpoVariableEnvironments(studioEnvironment);
    const name = 'STUDIO_EAS_ENV';
    const value = studioEnvironment;
    try {
      type M = { environmentVariable: { createEnvironmentVariableForApp: { id: string } } };
      await expoGraphqlRequest<M>(this.expoToken, CREATE_ENV_VAR_FOR_APP, {
        appId: expoAppId,
        input: {
          name,
          value,
          visibility: 'PUBLIC',
          environments: expoSlot,
          overwrite: true,
        },
      });
    } catch (err) {
      if (err instanceof ExpoGraphqlRequestError) {
        const msg = err.graphQLErrors.map((e) => e.message).join('; ');
        if (/duplicate|already exists|unique/i.test(msg)) return;
      }
      throw err;
    }
  }

  async upsertAppEnvironmentVariable(
    expoAppId: string,
    studioEnvironment: string | string[],
    name: string,
    value: string,
    visibility: 'PUBLIC' | 'SENSITIVE' | 'SECRET' = 'PUBLIC',
  ): Promise<void> {
    const expoSlot = Array.isArray(studioEnvironment)
      ? studioEnvironmentsToExpoVariableEnvironments(studioEnvironment)
      : studioEnvironmentToExpoVariableEnvironments(studioEnvironment);
    type M = { environmentVariable: { createEnvironmentVariableForApp: { id: string } } };
    await expoGraphqlRequest<M>(this.expoToken, CREATE_ENV_VAR_FOR_APP, {
      appId: expoAppId,
      input: {
        name,
        value,
        visibility,
        environments: expoSlot,
        overwrite: true,
      },
    });
  }

  /**
   * Lists app-scoped EAS environment variables matching `name` across every Expo
   * env slot. Returns the variable's id, name, value, and the env slots it is
   * attached to (e.g. `['DEVELOPMENT']`).
   */
  async listAppEnvironmentVariablesByName(
    expoAppId: string,
    name: string,
  ): Promise<Array<{ id: string; name: string; value: string | null; environments: string[] }>> {
    type Q = {
      app: {
        byId: {
          id: string;
          environmentVariables: Array<{
            id: string;
            name: string;
            value: string | null;
            environments: string[] | null;
          }>;
        } | null;
      };
    };
    const data = await expoGraphqlRequest<Q>(this.expoToken, APP_ENV_VARS_BY_NAME, {
      appId: expoAppId,
      filterNames: [name],
    });
    const vars = data.app?.byId?.environmentVariables ?? [];
    return vars.map((v) => ({
      id: v.id,
      name: v.name,
      value: v.value,
      environments: v.environments ?? [],
    }));
  }

  async listAppEnvironmentVariablesByNames(
    expoAppId: string,
    names: string[],
  ): Promise<Array<{ id: string; name: string; value: string | null; environments: string[] }>> {
    const uniqueNames = Array.from(new Set(names.map((n) => n.trim()).filter((n) => n.length > 0)));
    if (uniqueNames.length === 0) return [];
    type Q = {
      app: {
        byId: {
          id: string;
          environmentVariables: Array<{
            id: string;
            name: string;
            value: string | null;
            environments: string[] | null;
          }>;
        } | null;
      };
    };
    const data = await expoGraphqlRequest<Q>(this.expoToken, APP_ENV_VARS_BY_NAME, {
      appId: expoAppId,
      filterNames: uniqueNames,
    });
    const vars = data.app?.byId?.environmentVariables ?? [];
    return vars.map((v) => ({
      id: v.id,
      name: v.name,
      value: v.value,
      environments: v.environments ?? [],
    }));
  }

  /** Deletes a single EAS environment variable by id. */
  async deleteEnvironmentVariable(envVarId: string): Promise<void> {
    type M = { environmentVariable: { deleteEnvironmentVariable: { id: string } } };
    await expoGraphqlRequest<M>(this.expoToken, DELETE_ENV_VAR, { id: envVarId });
  }

  /**
   * Removes the `STUDIO_EAS_ENV` marker from the Expo app for a specific Studio
   * environment (matching by Expo env slot — e.g. studio "development" → DEVELOPMENT).
   * Idempotent: returns the number of variables actually deleted.
   */
  async removeStudioEasEnvironmentMarkerOnApp(
    expoAppId: string,
    studioEnvironment: string,
  ): Promise<number> {
    const expoSlot = studioEnvironmentToExpoVariableEnvironments(studioEnvironment)[0];
    const vars = await this.listAppEnvironmentVariablesByName(expoAppId, 'STUDIO_EAS_ENV');
    const matching = vars.filter((v) => (v.environments ?? []).includes(expoSlot!));
    for (const v of matching) {
      await this.deleteEnvironmentVariable(v.id);
    }
    return matching.length;
  }

  async removeAppEnvironmentVariableFromStudioEnvironment(
    expoAppId: string,
    studioEnvironment: string,
    name: string,
  ): Promise<number> {
    const expoSlot = studioEnvironmentToExpoVariableEnvironments(studioEnvironment)[0];
    const vars = await this.listAppEnvironmentVariablesByName(expoAppId, name);
    const matching = vars.filter((v) => (v.environments ?? []).includes(expoSlot!));
    for (const v of matching) {
      await this.deleteEnvironmentVariable(v.id);
    }
    return matching.length;
  }

  async reconcileAppEnvironmentVariableAcrossStudioEnvironments(
    expoAppId: string,
    name: string,
    value: string,
    visibility: 'PUBLIC' | 'SENSITIVE' | 'SECRET',
    studioEnvironments: string[],
  ): Promise<void> {
    const existing = await this.listAppEnvironmentVariablesByName(expoAppId, name);
    for (const row of existing) {
      await this.deleteEnvironmentVariable(row.id);
    }
    const trimmed = value.trim();
    if (!trimmed) return;
    await this.upsertAppEnvironmentVariable(expoAppId, studioEnvironments, name, trimmed, visibility);
  }

  async configureIosEasSubmit(input: {
    expoAppId: string;
    organization?: string;
    bundleId: string;
    issuerIdentifier: string;
    keyIdentifier: string;
    keyP8: string;
  }): Promise<void> {
    const { accountId } = await this.resolveAccountId(input.organization);
    type AppAuto = {
      app: {
        byId: {
          id: string;
          ownerAccount: { id: string };
          iosAppCredentials: Array<{ id: string }>;
        } | null;
      };
    };
    const appData = await expoGraphqlRequest<AppAuto>(this.expoToken, APP_BY_ID_FOR_AUTOMATION, {
      appId: input.expoAppId,
    });
    const app = appData.app?.byId;
    if (!app || app.ownerAccount.id !== accountId) {
      throw new Error('Expo app not found or wrong Expo account.');
    }

    type AccApple = {
      account: { byId: { appleAppIdentifiers: Array<{ id: string; bundleIdentifier: string }> } | null };
    };
    const appleData = await expoGraphqlRequest<AccApple>(this.expoToken, ACCOUNT_APPLE_IDS, { accountId });
    const appleIds = appleData.account?.byId?.appleAppIdentifiers ?? [];
    const appleAppIdentifier = appleIds.find(
      (a) => a.bundleIdentifier.toLowerCase() === input.bundleId.toLowerCase(),
    );
    if (!appleAppIdentifier) {
      throw new Error(
        `No Apple App Identifier registered in Expo for bundle id "${input.bundleId}". ` +
        'Register the bundle identifier in Expo (EAS credentials / Apple) or run the Apple provisioning steps first, then re-run this step.',
      );
    }

    type AccAsc = {
      account: {
        byId: { appStoreConnectApiKeys: Array<{ id: string; keyIdentifier: string; issuerIdentifier: string }> };
      };
    };
    const ascList = await expoGraphqlRequest<AccAsc>(this.expoToken, ACCOUNT_ASC_KEYS, { accountId });
    const keys = ascList.account?.byId?.appStoreConnectApiKeys ?? [];
    let ascKeyId = keys.find(
      (k) =>
        k.keyIdentifier === input.keyIdentifier &&
        k.issuerIdentifier.toLowerCase() === input.issuerIdentifier.toLowerCase(),
    )?.id;

    if (!ascKeyId) {
      type CM = { appStoreConnectApiKey: { createAppStoreConnectApiKey: { id: string } } };
      const created = await expoGraphqlRequest<CM>(this.expoToken, CREATE_ASC_API_KEY, {
        accountId,
        input: {
          issuerIdentifier: input.issuerIdentifier,
          keyIdentifier: input.keyIdentifier,
          keyP8: input.keyP8,
          name: `Studio ${input.bundleId}`,
        },
      });
      ascKeyId = created.appStoreConnectApiKey.createAppStoreConnectApiKey.id;
    }

    let iosCredId = app.iosAppCredentials[0]?.id;
    if (!iosCredId) {
      type IM = { iosAppCredentials: { createIosAppCredentials: { id: string } } };
      const created = await expoGraphqlRequest<IM>(this.expoToken, CREATE_IOS_APP_CREDENTIALS, {
        appId: input.expoAppId,
        appleAppIdentifierId: appleAppIdentifier.id,
        input: {},
      });
      iosCredId = created.iosAppCredentials.createIosAppCredentials.id;
    }

    type SM = { iosAppCredentials: { setAppStoreConnectApiKeyForSubmissions: { id: string } } };
    await expoGraphqlRequest<SM>(this.expoToken, SET_ASC_FOR_IOS_SUBMIT, {
      iosAppCredentialsId: iosCredId,
      ascApiKeyId: ascKeyId,
    });
  }

  /**
   * Uploads an iOS App Store distribution certificate + provisioning profile
   * to EAS and binds them to the app's build credentials.
   *
   * Idempotency: if the app already has APP_STORE iosAppBuildCredentials with
   * both a distribution cert and a provisioning profile attached, returns the
   * existing IDs without uploading anything. Callers should mint fresh assets
   * via `mintAppleAppStoreSigningAssets` ONLY after this method returns
   * `wasAlreadyConfigured: false` — otherwise we waste an Apple cert slot
   * (Apple caps each team at 2 active iOS Distribution certs).
   */
  async checkExistingEasIosAppStoreSigning(input: {
    expoAppId: string;
    organization?: string;
    bundleIdentifier: string;
  }): Promise<
    | null
    | {
        accountId: string;
        accountName: string;
        appleAppIdentifierId: string;
        iosAppCredentialsId: string;
        iosAppBuildCredentialsId: string;
        distributionCertificateId: string;
        provisioningProfileId: string;
        certDeveloperPortalIdentifier: string | null;
        certSerialNumber: string | null;
        profileDeveloperPortalIdentifier: string | null;
      }
  > {
    const { accountId, accountName } = await this.resolveAccountId(input.organization);
    const appleAppIdentifierId = await this.findAppleAppIdentifierId({
      accountName,
      bundleIdentifier: input.bundleIdentifier,
    });
    if (!appleAppIdentifierId) return null;

    type Q = {
      app: {
        byId: {
          id: string;
          iosAppCredentials: Array<{
            id: string;
            iosAppBuildCredentialsList: Array<{
              id: string;
              distributionCertificate: {
                id: string;
                developerPortalIdentifier: string | null;
                serialNumber: string | null;
              } | null;
              provisioningProfile: {
                id: string;
                developerPortalIdentifier: string | null;
              } | null;
            }>;
          }>;
        } | null;
      };
    };
    const data = await expoGraphqlRequest<Q>(this.expoToken, IOS_APP_BUILD_CREDENTIALS_QUERY, {
      appId: input.expoAppId,
      appleAppIdentifierId,
      iosDistributionType: 'APP_STORE',
    });
    const cred = data.app?.byId?.iosAppCredentials?.[0];
    const buildCred = cred?.iosAppBuildCredentialsList?.[0];
    if (!cred || !buildCred?.distributionCertificate || !buildCred?.provisioningProfile) {
      return null;
    }
    return {
      accountId,
      accountName,
      appleAppIdentifierId,
      iosAppCredentialsId: cred.id,
      iosAppBuildCredentialsId: buildCred.id,
      distributionCertificateId: buildCred.distributionCertificate.id,
      provisioningProfileId: buildCred.provisioningProfile.id,
      certDeveloperPortalIdentifier:
        buildCred.distributionCertificate.developerPortalIdentifier ?? null,
      certSerialNumber: buildCred.distributionCertificate.serialNumber ?? null,
      profileDeveloperPortalIdentifier:
        buildCred.provisioningProfile.developerPortalIdentifier ?? null,
    };
  }

  /**
   * Uploads a freshly-minted distribution certificate + provisioning profile
   * to EAS and creates (or updates) the iosAppBuildCredentials record.
   * Caller is responsible for ensuring this is needed by first checking
   * `checkExistingEasIosAppStoreSigning`.
   */
  async provisionEasIosAppStoreSigning(input: {
    expoAppId: string;
    organization?: string;
    bundleIdentifier: string;
    appleTeamIdentifier: string;
    appleTeamName?: string;
    cert: {
      certP12Base64: string;
      certPassword: string;
      certPrivateSigningKey: string;
      developerPortalIdentifier: string;
    };
    profile: {
      profileContentBase64: string;
      developerPortalIdentifier: string;
    };
  }): Promise<{
    accountId: string;
    accountName: string;
    appleTeamId: string;
    appleAppIdentifierId: string;
    iosAppCredentialsId: string;
    iosAppBuildCredentialsId: string;
    appleDistributionCertificateId: string;
    appleProvisioningProfileId: string;
  }> {
    const { accountId, accountName } = await this.resolveAccountId(input.organization);

    type AppOwnerQ = {
      app: {
        byId: {
          id: string;
          ownerAccount: { id: string };
        } | null;
      };
    };
    const appData = await expoGraphqlRequest<AppOwnerQ>(this.expoToken, APP_BY_ID_FOR_AUTOMATION, {
      appId: input.expoAppId,
    });
    const app = appData.app?.byId;
    if (!app || app.ownerAccount.id !== accountId) {
      throw new Error('Expo app not found or wrong Expo account.');
    }

    const appleTeamId = await this.ensureAppleTeam({
      accountId,
      appleTeamIdentifier: input.appleTeamIdentifier,
      appleTeamName: input.appleTeamName,
    });

    const appleAppIdentifierId = await this.ensureAppleAppIdentifier({
      accountId,
      accountName,
      bundleIdentifier: input.bundleIdentifier,
      appleTeamId,
    });

    type CertM = {
      appleDistributionCertificate: { createAppleDistributionCertificate: { id: string } };
    };
    const certResp = await expoGraphqlRequest<CertM>(
      this.expoToken,
      CREATE_APPLE_DIST_CERT_MUTATION,
      {
        appleDistributionCertificateInput: {
          certP12: input.cert.certP12Base64,
          certPassword: input.cert.certPassword,
          certPrivateSigningKey: input.cert.certPrivateSigningKey,
          developerPortalIdentifier: input.cert.developerPortalIdentifier,
          appleTeamId,
        },
        accountId,
      },
    );
    const appleDistributionCertificateId =
      certResp.appleDistributionCertificate.createAppleDistributionCertificate.id;

    type ProfM = {
      appleProvisioningProfile: { createAppleProvisioningProfile: { id: string } };
    };
    const profResp = await expoGraphqlRequest<ProfM>(
      this.expoToken,
      CREATE_APPLE_PROVISIONING_PROFILE_MUTATION,
      {
        appleProvisioningProfileInput: {
          appleProvisioningProfile: input.profile.profileContentBase64,
          developerPortalIdentifier: input.profile.developerPortalIdentifier,
        },
        accountId,
        appleAppIdentifierId,
      },
    );
    const appleProvisioningProfileId =
      profResp.appleProvisioningProfile.createAppleProvisioningProfile.id;

    const iosAppCredentialsId = await this.ensureIosAppCredentials({
      expoAppId: input.expoAppId,
      appleAppIdentifierId,
      appleTeamId,
    });

    const existingBuildCreds = await this.findIosAppBuildCredentialsId({
      expoAppId: input.expoAppId,
      appleAppIdentifierId,
    });

    let iosAppBuildCredentialsId: string;
    if (existingBuildCreds) {
      iosAppBuildCredentialsId = existingBuildCreds;
      type SetCertM = { iosAppBuildCredentials: { setDistributionCertificate: { id: string } } };
      await expoGraphqlRequest<SetCertM>(this.expoToken, SET_DIST_CERT_ON_BUILD_CREDS_MUTATION, {
        iosAppBuildCredentialsId,
        distributionCertificateId: appleDistributionCertificateId,
      });
      type SetProfM = { iosAppBuildCredentials: { setProvisioningProfile: { id: string } } };
      await expoGraphqlRequest<SetProfM>(
        this.expoToken,
        SET_PROVISIONING_PROFILE_ON_BUILD_CREDS_MUTATION,
        {
          iosAppBuildCredentialsId,
          provisioningProfileId: appleProvisioningProfileId,
        },
      );
    } else {
      type CreateBuildCredsM = {
        iosAppBuildCredentials: { createIosAppBuildCredentials: { id: string } };
      };
      const created = await expoGraphqlRequest<CreateBuildCredsM>(
        this.expoToken,
        CREATE_IOS_APP_BUILD_CREDS_MUTATION,
        {
          iosAppBuildCredentialsInput: {
            iosDistributionType: 'APP_STORE',
            distributionCertificateId: appleDistributionCertificateId,
            provisioningProfileId: appleProvisioningProfileId,
          },
          iosAppCredentialsId,
        },
      );
      iosAppBuildCredentialsId =
        created.iosAppBuildCredentials.createIosAppBuildCredentials.id;
    }

    return {
      accountId,
      accountName,
      appleTeamId,
      appleAppIdentifierId,
      iosAppCredentialsId,
      iosAppBuildCredentialsId,
      appleDistributionCertificateId,
      appleProvisioningProfileId,
    };
  }

  private async findAppleAppIdentifierId(args: {
    accountName: string;
    bundleIdentifier: string;
  }): Promise<string | null> {
    type Q = {
      account: {
        byName: {
          id: string;
          appleAppIdentifiers: Array<{ id: string; bundleIdentifier: string }>;
        } | null;
      };
    };
    const data = await expoGraphqlRequest<Q>(
      this.expoToken,
      APPLE_APP_IDENTIFIER_BY_BUNDLE_ID_QUERY,
      { accountName: args.accountName, bundleIdentifier: args.bundleIdentifier },
    );
    const ids = data.account?.byName?.appleAppIdentifiers ?? [];
    const match = ids.find(
      (a) => a.bundleIdentifier.toLowerCase() === args.bundleIdentifier.toLowerCase(),
    );
    return match?.id ?? null;
  }

  private async ensureAppleAppIdentifier(args: {
    accountId: string;
    accountName: string;
    bundleIdentifier: string;
    appleTeamId: string;
  }): Promise<string> {
    const existing = await this.findAppleAppIdentifierId({
      accountName: args.accountName,
      bundleIdentifier: args.bundleIdentifier,
    });
    if (existing) return existing;

    type CreateM = {
      appleAppIdentifier: { createAppleAppIdentifier: { id: string } };
    };
    const created = await expoGraphqlRequest<CreateM>(
      this.expoToken,
      CREATE_APPLE_APP_IDENTIFIER_MUTATION,
      {
        appleAppIdentifierInput: {
          bundleIdentifier: args.bundleIdentifier,
          appleTeamId: args.appleTeamId,
        },
        accountId: args.accountId,
      },
    );
    return created.appleAppIdentifier.createAppleAppIdentifier.id;
  }

  private async ensureAppleTeam(args: {
    accountId: string;
    appleTeamIdentifier: string;
    appleTeamName?: string;
  }): Promise<string> {
    type Q = {
      appleTeam: { byAppleTeamIdentifier: { id: string } | null };
    };
    const lookup = await expoGraphqlRequest<Q>(this.expoToken, APPLE_TEAM_BY_IDENTIFIER_QUERY, {
      accountId: args.accountId,
      appleTeamIdentifier: args.appleTeamIdentifier,
    });
    if (lookup.appleTeam?.byAppleTeamIdentifier?.id) {
      return lookup.appleTeam.byAppleTeamIdentifier.id;
    }
    type CreateM = { appleTeam: { createAppleTeam: { id: string } } };
    const created = await expoGraphqlRequest<CreateM>(this.expoToken, CREATE_APPLE_TEAM_MUTATION, {
      appleTeamInput: {
        appleTeamIdentifier: args.appleTeamIdentifier,
        ...(args.appleTeamName ? { appleTeamName: args.appleTeamName } : {}),
      },
      accountId: args.accountId,
    });
    return created.appleTeam.createAppleTeam.id;
  }

  private async ensureIosAppCredentials(args: {
    expoAppId: string;
    appleAppIdentifierId: string;
    appleTeamId: string;
  }): Promise<string> {
    type AppQ = {
      app: {
        byId: {
          id: string;
          iosAppCredentials: Array<{ id: string }>;
        } | null;
      };
    };
    const appData = await expoGraphqlRequest<AppQ>(this.expoToken, APP_BY_ID_FOR_AUTOMATION, {
      appId: args.expoAppId,
    });
    const existing = appData.app?.byId?.iosAppCredentials?.[0]?.id;
    if (existing) return existing;

    type CreateM = { iosAppCredentials: { createIosAppCredentials: { id: string } } };
    const created = await expoGraphqlRequest<CreateM>(
      this.expoToken,
      CREATE_IOS_APP_CREDENTIALS,
      {
        appId: args.expoAppId,
        appleAppIdentifierId: args.appleAppIdentifierId,
        input: { appleTeamId: args.appleTeamId },
      },
    );
    return created.iosAppCredentials.createIosAppCredentials.id;
  }

  private async findIosAppBuildCredentialsId(args: {
    expoAppId: string;
    appleAppIdentifierId: string;
  }): Promise<string | null> {
    type Q = {
      app: {
        byId: {
          iosAppCredentials: Array<{
            iosAppBuildCredentialsList: Array<{ id: string }>;
          }>;
        } | null;
      };
    };
    const data = await expoGraphqlRequest<Q>(this.expoToken, IOS_APP_BUILD_CREDENTIALS_QUERY, {
      appId: args.expoAppId,
      appleAppIdentifierId: args.appleAppIdentifierId,
      iosDistributionType: 'APP_STORE',
    });
    const list = data.app?.byId?.iosAppCredentials?.[0]?.iosAppBuildCredentialsList ?? [];
    return list[0]?.id ?? null;
  }

  async configureAndroidEasSubmit(input: {
    expoAppId: string;
    organization?: string;
    androidApplicationId: string;
    googleServiceAccountJson: Record<string, unknown>;
  }): Promise<void> {
    const { accountId } = await this.resolveAccountId(input.organization);
    type AppAuto = {
      app: {
        byId: {
          id: string;
          ownerAccount: { id: string };
          androidAppCredentials: Array<{ id: string; applicationIdentifier?: string | null }>;
        } | null;
      };
    };
    const appData = await expoGraphqlRequest<AppAuto>(this.expoToken, APP_BY_ID_FOR_AUTOMATION, {
      appId: input.expoAppId,
    });
    const app = appData.app?.byId;
    if (!app || app.ownerAccount.id !== accountId) {
      throw new Error('Expo app not found or wrong Expo account.');
    }

    type GM = { googleServiceAccountKey: { createGoogleServiceAccountKey: { id: string } } };
    const gKey = await expoGraphqlRequest<GM>(this.expoToken, CREATE_GOOGLE_SA_KEY, {
      accountId,
      input: { jsonKey: input.googleServiceAccountJson },
    });
    const googleKeyId = gKey.googleServiceAccountKey.createGoogleServiceAccountKey.id;

    const pkgLower = input.androidApplicationId.toLowerCase();
    let androidCred = app.androidAppCredentials.find(
      (c) => (c.applicationIdentifier ?? '').toLowerCase() === pkgLower,
    );
    let androidCredId = androidCred?.id;
    if (!androidCredId) {
      type AM = { androidAppCredentials: { createAndroidAppCredentials: { id: string } } };
      const created = await expoGraphqlRequest<AM>(this.expoToken, CREATE_ANDROID_APP_CREDENTIALS, {
        appId: input.expoAppId,
        applicationIdentifier: input.androidApplicationId,
        input: {},
      });
      androidCredId = created.androidAppCredentials.createAndroidAppCredentials.id;
    }

    type SM = {
      androidAppCredentials: { setGoogleServiceAccountKeyForSubmissions: { id: string } };
    };
    await expoGraphqlRequest<SM>(this.expoToken, SET_ANDROID_SA_FOR_SUBMIT, {
      androidCredentialsId: androidCredId,
      googleServiceAccountKeyId: googleKeyId,
    });
  }

  async uploadEnvFile(
    projectId: string,
    environment: Environment,
    envVars: Record<string, string>,
    options?: {
      visibilityByName?: Record<string, 'PUBLIC' | 'SENSITIVE' | 'SECRET'>;
      targetEnvironments?: Environment[];
    },
  ): Promise<void> {
    if (Object.keys(envVars).length === 0) return;
    const targetEnvironments =
      options?.targetEnvironments && options.targetEnvironments.length > 0
        ? options.targetEnvironments
        : [environment];
    for (const [name, value] of Object.entries(envVars)) {
      if (!name.trim()) continue;
      const visibility = options?.visibilityByName?.[name] ?? 'PUBLIC';
      await this.reconcileAppEnvironmentVariableAcrossStudioEnvironments(
        projectId,
        name,
        value,
        visibility,
        targetEnvironments,
      );
    }
  }

  async getEnvVars(_projectId: string, _environment: Environment): Promise<Record<string, string>> {
    return {};
  }
}
