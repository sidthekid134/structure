/**
 * Human-readable previews of resource names each step is expected to produce.
 */

import type { ProvisioningPlan, ProvisioningNode } from '../provisioning/graph.types.js';
import { computeCanonicalNodeOrder, propagateJourneyPhases } from '../provisioning/journey-phases.js';
import { buildStudioGcpProjectId, GCP_PROVISIONER_SERVICE_ACCOUNT_ID } from '../core/gcp-connection.js';
import type { ProjectModule } from './project-manager.js';
import { projectPrimaryDomain, projectResourceSlug } from './project-identity.js';

function mergeCompletedUpstream(plan: ProvisioningPlan): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, state] of plan.nodeStates) {
    if ((state.status === 'completed' || state.status === 'skipped') && state.resourcesProduced) {
      Object.assign(out, state.resourcesProduced);
    }
  }
  return out;
}

const SENSITIVE = new Set([
  'github_token', 'expo_token', 'service_account_json', 'apns_key_p8', 'asc_api_key_p8', 'gcp_billing_account_id',
]);

function previewFor(
  resourceKey: string,
  nodeKey: string,
  ctx: {
    upstream: Record<string, string>;
    slug: string;
    domain: string;
    bundleId: string;
    expectedGcpId: string;
    linkedGcpId: string;
    githubOwner: string;
    easAccount: string;
  },
): string {
  if (SENSITIVE.has(resourceKey)) {
    return 'Assigned when you complete this step (stored securely)';
  }
  const gcp =
    ctx.upstream['gcp_project_id']?.trim() ||
    ctx.upstream['firebase_project_id']?.trim() ||
    ctx.linkedGcpId;
  const provisionerEmail = `${GCP_PROVISIONER_SERVICE_ACCOUNT_ID}@${gcp}.iam.gserviceaccount.com`;

  switch (resourceKey) {
    case 'gcp_project_id':
      return ctx.expectedGcpId;
    case 'firebase_project_id':
      return gcp;
    case 'provisioner_sa_email':
      return provisionerEmail;
    case 'domain_name':
      return ctx.domain || 'Set in project settings (App domain) or when you complete this step';
    case 'github_repo_url':
      return `https://github.com/${ctx.githubOwner}/${ctx.slug}`;
    case 'eas_project_id': {
      const acct = ctx.easAccount ? ` — Expo account “${ctx.easAccount}”` : '';
      return `EAS / Expo project named like “${ctx.slug}”${acct}`;
    }
    case 'deep_link_base_url':
      return ctx.domain ? `https://${ctx.domain}` : 'https://your-app-domain (set project App domain)';
    case 'apple_bundle_id':
      return ctx.bundleId || `com.example.${ctx.slug}`;
    case 'apple_app_id':
      return 'Apple App ID in Developer Portal (matches your bundle ID)';
    case 'asc_app_id':
      return 'App Store Connect app record for this product';
    case 'play_app_id':
      return `Play Console app (package typically aligned with “${ctx.bundleId || ctx.slug}”)`;
    case 'play_service_account_email':
      return 'Google Cloud service account for Play Developer API';
    case 'cloudflare_zone_id':
      return ctx.domain ? `Cloudflare zone for “${ctx.domain}”` : 'Cloudflare zone for your project domain';
    case 'signing_sha1':
    case 'signing_sha256':
      return 'Certificate fingerprints from Play App Signing';
    case 'oauth_client_id_ios':
    case 'oauth_client_id_android':
    case 'oauth_client_id_web':
      return 'OAuth client IDs in Google Cloud / Firebase';
    case 'apple_sign_in_service_id':
      return 'Sign in with Apple service identifier';
    case 'firebase_ios_app_id':
      return `Firebase iOS app (${ctx.bundleId || ctx.slug})`;
    case 'firebase_android_app_id':
      return `Firebase Android app (${ctx.bundleId || ctx.slug})`;
    case 'enabled_services':
      return 'GCP API enablement set on your Firebase / GCP project';
    case 'apple_team_id':
      return 'Your Apple Developer Team ID';
    case 'play_developer_id':
      return 'Google Play developer account identifier';
    case 'apns_key_id':
    case 'asc_api_key_id':
      return 'Key ID issued by Apple when you create the key';
    case 'apple_dev_profile_id':
    case 'apple_dist_profile_id':
      return 'Provisioning profile in Apple Developer Portal';
    default:
      if (resourceKey.includes('url') || resourceKey.endsWith('_uri')) {
        return 'URL assigned when this step completes';
      }
      if (resourceKey.includes('id')) {
        return 'Identifier assigned when this step completes';
      }
      if (nodeKey.includes('delete') || nodeKey.includes('remove') || nodeKey.includes('revoke')) {
        return 'Target resource from earlier steps — this step tears it down';
      }
      return 'Named when this step runs';
  }
}

export function buildPlannedOutputPreviewByNodeKey(
  plan: ProvisioningPlan,
  projectModule: ProjectModule,
  orgGithubConfig: Record<string, string>,
): Record<string, Record<string, string>> {
  const project = projectModule.project;
  const slug = projectResourceSlug(project);
  const domain = projectPrimaryDomain(project);
  const bundleId = project.bundleId?.trim() ?? '';
  const expectedGcpId = buildStudioGcpProjectId(plan.projectId);
  const firebaseConfig = (projectModule.integrations.firebase?.config ?? {}) as Record<string, string>;
  const linkedGcpId = firebaseConfig['gcp_project_id']?.trim() || expectedGcpId;
  const githubOwner =
    project.githubOrg?.trim() ||
    orgGithubConfig['owner_default']?.trim() ||
    orgGithubConfig['username']?.trim() ||
    slug;
  const upstream = mergeCompletedUpstream(plan);
  const journeyMap = propagateJourneyPhases(plan.nodes);
  const order = computeCanonicalNodeOrder(plan.nodes, journeyMap);
  const result: Record<string, Record<string, string>> = {};
  const easAccount = project.easAccount?.trim() ?? '';

  for (const nodeKey of order) {
    const node = plan.nodes.find((n) => n.key === nodeKey) as ProvisioningNode | undefined;
    if (!node || !('produces' in node) || !node.produces?.length) continue;
    const previews: Record<string, string> = {};
    for (const p of node.produces) {
      previews[p.key] = previewFor(p.key, nodeKey, {
        upstream,
        slug,
        domain,
        bundleId,
        expectedGcpId,
        linkedGcpId,
        githubOwner,
        easAccount,
      });
    }
    result[nodeKey] = previews;
  }
  return result;
}
