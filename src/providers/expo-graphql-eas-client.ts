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
    _projectId: string,
    _environment: Environment,
    envVars: Record<string, string>,
  ): Promise<void> {
    if (Object.keys(envVars).length === 0) return;
    throw new Error(
      'Studio does not push non-empty EAS environment files yet. Configure variables in the Expo dashboard or app repo.',
    );
  }

  async getEnvVars(_projectId: string, _environment: Environment): Promise<Record<string, string>> {
    return {};
  }
}
