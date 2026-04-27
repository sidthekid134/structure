/**
 * Human-readable previews of resource names each step is expected to produce.
 */

import type { ProvisioningPlan, ProvisioningNode } from '../provisioning/graph.types.js';
import { computeCanonicalNodeOrder, propagateJourneyPhases } from '../provisioning/journey-phases.js';
import { buildStudioGcpProjectId, GCP_PROVISIONER_SERVICE_ACCOUNT_ID } from '../core/gcp-connection.js';
import type { ProjectModule } from './project-manager.js';
import { projectPrimaryDomain, projectResourceSlug } from './project-identity.js';
import { globalPluginRegistry } from '../plugins/plugin-registry.js';
import type { ResourcePreviewContext } from '../plugins/plugin-types.js';

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
  'github_token',
  'expo_token',
  'service_account_json',
  'asc_api_key_p8',
  'gcp_billing_account_id',
  'apple_auth_key_p8_apns',
  'apple_auth_key_p8_sign_in_with_apple',
]);

function interpolateTemplate(template: string, ctx: ResourcePreviewContext): string {
  return template
    .replace(/\{slug\}/g, ctx.slug)
    .replace(/\{domain\}/g, ctx.domain)
    .replace(/\{bundleId\}/g, ctx.bundleId)
    .replace(/\{appName\}/g, ctx.appName)
    .replace(/\{easAccount\}/g, ctx.easAccount)
    .replace(/\{githubOwner\}/g, ctx.githubOwner)
    .replace(/\{upstream\.([a-z0-9_]+)\}/g, (_, k: string) => ctx.upstream[k] ?? '');
}

function previewFor(
  resourceKey: string,
  nodeKey: string,
  ctx: ResourcePreviewContext,
): string {
  if (SENSITIVE.has(resourceKey)) {
    return 'Assigned when you complete this step (stored securely)';
  }

  // Registry-driven lookup — plugins can define previewTemplate or previewText
  if (globalPluginRegistry.hasPlugin('firebase-core')) {
    const display = globalPluginRegistry.getResourceDisplay(resourceKey);
    if (display?.previewTemplate) {
      return typeof display.previewTemplate === 'function'
        ? display.previewTemplate(ctx)
        : interpolateTemplate(display.previewTemplate, ctx);
    }
    if (display?.previewText) {
      return display.previewText;
    }
  }
  const gcp: string =
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
    case 'auth_landing_url':
      return ctx.domain ? `https://${ctx.domain}/auth` : 'https://your-app-domain/auth';
    case 'apple_bundle_id':
      return ctx.bundleId || `com.example.${ctx.slug}`;
    case 'apple_app_id': {
      const teamId = ctx.upstream['apple_team_id']?.trim();
      const bundle = ctx.bundleId || `com.example.${ctx.slug}`;
      return teamId ? `${teamId}.${bundle}` : bundle;
    }
    case 'asc_app_id': {
      // Apple's App Store Connect API forbids POST /v1/apps. The user
      // creates the listing once in the App Store Connect web UI (Apps →
      // "+" → New App) using these exact values, and Studio detects it
      // via filter[bundleId] on the next run and stores asc_app_id.
      // Prefer the user-typed listing name if they've configured one — App
      // Store names must be globally unique so it often differs from
      // project.name (e.g. "Flow" → "Flow Mobile").
      const bundle = ctx.bundleId || `com.example.${ctx.slug}`;
      const listingName = ctx.nodeUserInputs['asc_app_name']?.trim() || ctx.appName;
      return `App Store Connect listing for "${listingName}" (Name "${listingName}", SKU ${bundle}, Bundle ${bundle}). Create it in App Store Connect — Studio detects and links it.`;
    }
    case 'asc_app_name': {
      const listingName = ctx.nodeUserInputs['asc_app_name']?.trim() || ctx.appName;
      return `"${listingName}" — confirmed against App Store Connect after detection.`;
    }
    case 'play_app_id':
      return `Play Console app (package typically aligned with “${ctx.bundleId || ctx.slug}”)`;
    case 'play_service_account_email':
      return 'Google Cloud service account for Play Developer API';
    case 'cloudflare_zone_id':
      return ctx.domain ? `Cloudflare zone for “${ctx.domain}”` : 'Cloudflare zone for your project domain';
    case 'cloudflare_zone_status':
      return 'active once registrar nameservers are delegated to Cloudflare';
    case 'cloudflare_zone_nameservers':
      return 'Cloudflare-assigned nameservers to set at your registrar';
    case 'cloudflare_zone_domain':
      return ctx.domain ? `Cloudflare zone apex for “${ctx.domain}”` : 'Cloudflare zone apex domain';
    case 'cloudflare_app_domain':
      return ctx.domain || 'App hostname used for auth and deep links';
    case 'cloudflare_domain_mode':
      return ctx.domain && ctx.domain.split('.').length > 2 ? 'subdomain' : 'zone-root';
    case 'cloudflare_dns_record_name':
      return ctx.domain && ctx.domain.split('.').length > 2
        ? ctx.domain.split('.').slice(0, -2).join('.')
        : '@';
    case 'signing_sha1':
    case 'signing_sha256':
      return 'Certificate fingerprints from Play App Signing';
    case 'oauth_client_id_ios':
    case 'oauth_client_id_android':
    case 'oauth_client_id_web':
      return 'OAuth client IDs in Google Cloud / Firebase';
    case 'apple_sign_in_service_id': {
      const requested = ctx.nodeUserInputs['apple_sign_in_service_id']?.trim();
      if (requested) return `Sign In with Apple service identifier "${requested}"`;
      const bundle = ctx.bundleId || `com.example.${ctx.slug}`;
      return `Sign In with Apple service identifier "${bundle}.signin"`;
    }
    case 'apple_auth_key_id_apns':
    case 'apple_auth_key_id_sign_in_with_apple': {
      const typed = ctx.nodeUserInputs['apple_auth_key_id']?.trim();
      if (typed) return `Apple Auth Key "${typed}" (10-char Key ID from Apple Developer \u2192 Keys)`;
      return 'Apple Auth Key ID (10 chars, e.g. ABCD1234EF) extracted from the AuthKey_<KEYID>.p8 filename on upload';
    }
    case 'apple_auth_key_p8_apns':
    case 'apple_auth_key_p8_sign_in_with_apple':
      return "Marker (vaulted) — PEM stored in this project's unified Apple Auth Key registry, keyed by Key ID";
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
  // Mirror the fallback chain used in api.ts when building the Apple
  // manifest config (app_name field). Keep these two derivations in sync so
  // the preview shows the exact name we will send to Apple's API.
  const appName = project.name?.trim() || slug || plan.projectId;
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
    // Pull this node's user-typed inputs (if any) so previews can reflect
    // operator-supplied values like the actual ASC listing name.
    let nodeUserInputs: Record<string, string> = {};
    for (const [, state] of plan.nodeStates) {
      if (state.nodeKey === nodeKey && state.userInputs) {
        nodeUserInputs = state.userInputs;
        break;
      }
    }
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
        appName,
        nodeUserInputs,
      });
    }
    result[nodeKey] = previews;
  }
  return result;
}
