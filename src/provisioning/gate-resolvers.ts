/**
 * Gate resolvers — allow user-action nodes to auto-resolve during orchestration.
 *
 * When the orchestrator encounters a user-action node, it consults the
 * registered GateResolver before yielding `waiting-on-user`. If the resolver
 * determines the gate is already satisfied (e.g. credentials are in the vault),
 * the node is auto-completed and the pipeline continues without pausing.
 */

import type { GateResolver, GateResolverResult, StepContext } from './graph.types.js';
import type { GcpConnectionService, GcpProjectConnectionStatus } from '../core/gcp-connection.js';
import type { EasConnectionService } from '../core/eas-connection.js';

// ---------------------------------------------------------------------------
// Composite gate resolver — delegates to a map of per-nodeKey resolvers
// ---------------------------------------------------------------------------

type SingleGateResolver = (context: StepContext) => Promise<GateResolverResult>;

export class CompositeGateResolver implements GateResolver {
  private readonly resolvers = new Map<string, SingleGateResolver>();

  register(nodeKey: string, resolver: SingleGateResolver): void {
    this.resolvers.set(nodeKey, resolver);
  }

  async canResolve(nodeKey: string, context: StepContext): Promise<GateResolverResult> {
    const resolver = this.resolvers.get(nodeKey);
    if (!resolver) {
      return { resolved: false, action: 'wait-on-user' };
    }
    return resolver(context);
  }
}

// ---------------------------------------------------------------------------
// GCP / Firebase gate resolver factory
// ---------------------------------------------------------------------------

export function createGcpGateResolvers(
  gcpConnectionService: GcpConnectionService,
): { billingResolver: SingleGateResolver } {
  const resolveFromConnection = (
    projectId: string,
  ): GcpProjectConnectionStatus | null => {
    try {
      const status = gcpConnectionService.getProjectConnectionStatus(projectId);
      if (status.connected && status.details) return status;
    } catch {
      // Project may not exist yet or vault unavailable
    }
    return null;
  };

  const billingResolver: SingleGateResolver = async (context) => {
    const connection = resolveFromConnection(context.projectId);
    if (connection?.connected && connection.details) {
      return {
        resolved: true,
        resourcesProduced: {
          gcp_billing_account_id: '[connected via OAuth]',
        },
      };
    }
    return { resolved: false, action: 'wait-on-user' };
  };

  return { billingResolver };
}

// ---------------------------------------------------------------------------
// GitHub PAT gate resolver factory
// ---------------------------------------------------------------------------

export function createGitHubGateResolver(
  getStoredToken: () => string | undefined,
): SingleGateResolver {
  return async (_context) => {
    const token = getStoredToken();
    if (token) {
      return {
        resolved: true,
        resourcesProduced: { github_token: '[stored in vault]' },
      };
    }
    return { resolved: false, action: 'wait-on-user' };
  };
}

// ---------------------------------------------------------------------------
// Expo token gate resolver factory
// ---------------------------------------------------------------------------

export function createExpoGateResolver(
  easConnectionService: EasConnectionService,
): SingleGateResolver {
  return async (_context) => {
    const token = easConnectionService.getStoredExpoToken();
    if (token) {
      return {
        resolved: true,
        resourcesProduced: { expo_token: '[stored in vault]' },
      };
    }
    return { resolved: false, action: 'wait-on-user' };
  };
}

// ---------------------------------------------------------------------------
// Factory — builds a fully-wired CompositeGateResolver for provisioning
// ---------------------------------------------------------------------------

export function buildProvisioningGateResolver(deps: {
  gcpConnectionService: GcpConnectionService;
  easConnectionService: EasConnectionService;
  getGitHubToken: () => string | undefined;
  getCloudflareToken?: (projectId: string) => string | undefined;
  checkCloudflareZoneOwnership?: (context: StepContext) => Promise<{
    owned: boolean;
    zoneId?: string;
    accountId?: string;
    zoneStatus?: string;
    zoneDomain?: string;
    appDomain?: string;
    nameservers?: string[];
  }>;
  checkExpoGitHubInstall?: (context: StepContext) => Promise<{
    linked: boolean;
    githubOwner?: string;
    githubRepo?: string;
  }>;
}): CompositeGateResolver {
  const resolver = new CompositeGateResolver();

  const { billingResolver } = createGcpGateResolvers(deps.gcpConnectionService);
  resolver.register('user:setup-gcp-billing', billingResolver);

  resolver.register(
    'user:provide-github-pat',
    createGitHubGateResolver(deps.getGitHubToken),
  );

  resolver.register(
    'user:provide-expo-token',
    createExpoGateResolver(deps.easConnectionService),
  );

  if (deps.getCloudflareToken) {
    resolver.register(
      'user:provide-cloudflare-token',
      async (context) => {
        const token = deps.getCloudflareToken!(context.projectId);
        if (!token?.trim()) return { resolved: false, action: 'wait-on-user' };
        return {
          resolved: true,
          resourcesProduced: { cloudflare_token: '[stored in vault]' },
        };
      },
    );
  }

  if (deps.checkCloudflareZoneOwnership) {
    resolver.register(
      'user:confirm-dns-nameservers',
      async (context) => {
        const zone = await deps.checkCloudflareZoneOwnership!(context);
        if (!zone.owned || zone.zoneStatus !== 'active') {
          return { resolved: false, action: 'wait-on-user' };
        }
        return {
          resolved: true,
          resourcesProduced: {
            ...(zone.zoneId ? { cloudflare_zone_id: zone.zoneId } : {}),
            ...(zone.accountId ? { cloudflare_account_id: zone.accountId } : {}),
            ...(zone.zoneStatus ? { cloudflare_zone_status: zone.zoneStatus } : {}),
            ...(zone.zoneDomain ? { cloudflare_zone_domain: zone.zoneDomain } : {}),
            ...(zone.appDomain ? { cloudflare_app_domain: zone.appDomain } : {}),
            ...(zone.nameservers?.length
              ? { cloudflare_zone_nameservers: zone.nameservers.join(',') }
              : {}),
          },
        };
      },
    );
  }

  if (deps.checkExpoGitHubInstall) {
    resolver.register(
      'user:install-expo-github-app',
      async (context) => {
        const result = await deps.checkExpoGitHubInstall!(context);
        if (!result.linked) return { resolved: false, action: 'wait-on-user' };
        return {
          resolved: true,
          resourcesProduced: {
            expo_github_repo_linked: 'true',
            ...(result.githubOwner ? { verified_github_owner: result.githubOwner } : {}),
            ...(result.githubRepo ? { verified_github_repo: result.githubRepo } : {}),
          },
        };
      },
    );
  }

  return resolver;
}
