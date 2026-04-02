/**
 * Configurable Studio presentation for completed provisioning steps:
 * sensitivity, primary links, and related console/docs URLs.
 *
 * Merge order: defaults by resource key → graph `resource.presentation` (from API).
 * Add or override entries here without changing backend step definitions.
 */

import type {
  CompletionPortalLink,
  CompletionRelatedLink,
  NodeState,
  ProvisioningGraphNode,
  ResourceOutput,
  ResourceOutputPresentation,
} from './types';

export function isVaultPlaceholder(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v === 'vaulted' || v.includes('[stored') || v.includes('in vault');
}

const DEFAULT_SENSITIVE_KEYS = new Set([
  'service_account_json',
  'gcp_credentials',
  'github_token',
  'expo_token',
  'apns_key_p8',
  'asc_api_key_p8',
]);

/** Default presentation keyed by `ResourceOutput.key`. Extend as new resources are produced. */
const RESOURCE_DISPLAY_BY_KEY: Record<string, ResourceOutputPresentation> = {
  gcp_project_id: {
    primaryHrefTemplate: 'https://console.cloud.google.com/home/dashboard?project={value}',
    relatedLinks: [
      { label: 'Google Cloud Console', href: 'https://console.cloud.google.com/' },
      { label: 'Billing', href: 'https://console.cloud.google.com/billing' },
    ],
  },
  firebase_project_id: {
    primaryHrefTemplate: 'https://console.firebase.google.com/project/{value}',
    relatedLinks: [{ label: 'Firebase console', href: 'https://console.firebase.google.com/' }],
  },
  firebase_ios_app_id: {
    primaryHrefTemplate:
      'https://console.firebase.google.com/project/{upstream.firebase_project_id}/settings/general/ios',
    relatedLinks: [
      {
        label: 'Firebase project settings',
        hrefTemplate: 'https://console.firebase.google.com/project/{upstream.firebase_project_id}/settings/general',
      },
    ],
  },
  firebase_android_app_id: {
    primaryHrefTemplate:
      'https://console.firebase.google.com/project/{upstream.firebase_project_id}/settings/general/android',
    relatedLinks: [
      {
        label: 'Firebase project settings',
        hrefTemplate: 'https://console.firebase.google.com/project/{upstream.firebase_project_id}/settings/general',
      },
    ],
  },
  github_repo_url: {
    primaryLinkFromValue: true,
    relatedLinks: [
      { label: 'Repository settings', hrefTemplate: '{value}/settings' },
      { label: 'Actions', hrefTemplate: '{value}/actions' },
    ],
  },
  github_environment_id: {
    relatedLinks: [
      { label: 'GitHub Environments', hrefTemplate: '{upstream.github_repo_url}/settings/environments' },
    ],
  },
  eas_project_id: {
    primaryHrefTemplate: 'https://expo.dev/projects/{value}',
    relatedLinks: [{ label: 'Expo dashboard', href: 'https://expo.dev/' }],
  },
  asc_app_id: {
    primaryHrefTemplate: 'https://appstoreconnect.apple.com/apps/{value}/appstore',
    relatedLinks: [{ label: 'App Store Connect', href: 'https://appstoreconnect.apple.com/' }],
  },
  play_app_id: {
    relatedLinks: [{ label: 'Play Console', href: 'https://play.google.com/console' }],
  },
  cloudflare_zone_id: {
    primaryHrefTemplate: 'https://dash.cloudflare.com/?zoneId={value}',
    relatedLinks: [
      { label: 'Cloudflare dashboard', href: 'https://dash.cloudflare.com/' },
      { label: 'DNS docs', href: 'https://developers.cloudflare.com/dns/' },
    ],
  },
  domain_name: {
    relatedLinks: [{ label: 'WHOIS / registrar', hrefTemplate: 'https://www.whois.com/whois/{value}' }],
  },
  provisioner_sa_email: {
    primaryHrefTemplate:
      'https://console.cloud.google.com/iam-admin/serviceaccounts?project={upstream.gcp_project_id}',
    relatedLinks: [
      {
        label: 'IAM',
        hrefTemplate: 'https://console.cloud.google.com/iam-admin/iam?project={upstream.gcp_project_id}',
      },
    ],
  },
  play_service_account_email: {
    primaryHrefTemplate:
      'https://console.cloud.google.com/iam-admin/serviceaccounts?project={upstream.gcp_project_id}',
  },
  apple_team_id: {
    relatedLinks: [
      { label: 'Apple Developer', href: 'https://developer.apple.com/account' },
      { label: 'Membership details', href: 'https://developer.apple.com/account#membership' },
    ],
  },
  apple_app_id: {
    relatedLinks: [{ label: 'Certificates, IDs & Profiles', href: 'https://developer.apple.com/account/resources/identifiers/list' }],
  },
  deep_link_base_url: {
    primaryLinkFromValue: true,
  },
  gcp_billing_account_id: {
    primaryHrefTemplate: 'https://console.cloud.google.com/billing/{value}',
  },
};

/** Optional node-level portal links (merged with `node.completionPortalLinks` from API). */
const NODE_PORTAL_LINKS_BY_NODE_KEY: Record<string, CompletionPortalLink[]> = {
  'firebase:create-gcp-project': [
    {
      label: 'Open project in Google Cloud',
      hrefTemplate: 'https://console.cloud.google.com/home/dashboard?project={upstream.gcp_project_id}',
    },
  ],
  'firebase:enable-firebase': [
    {
      label: 'Firebase console',
      hrefTemplate: 'https://console.firebase.google.com/project/{upstream.firebase_project_id}',
    },
  ],
  'github:create-repository': [
    { label: 'Open repository', hrefTemplate: '{upstream.github_repo_url}' },
    { label: 'Repository settings', hrefTemplate: '{upstream.github_repo_url}/settings' },
  ],
  'github:create-environments': [
    { label: 'GitHub environments', hrefTemplate: '{upstream.github_repo_url}/settings/environments' },
  ],
  'github:inject-secrets': [
    { label: 'Actions secrets', hrefTemplate: '{upstream.github_repo_url}/settings/secrets/actions' },
  ],
  'github:deploy-workflows': [
    { label: 'Actions', hrefTemplate: '{upstream.github_repo_url}/actions' },
  ],
  'user:provide-github-pat': [{ label: 'GitHub token settings', href: 'https://github.com/settings/tokens' }],
  'user:provide-expo-token': [{ label: 'Expo access tokens', href: 'https://expo.dev/settings/access-tokens' }],
  'user:install-expo-github-app': [
    { label: 'Expo GitHub integration docs', href: 'https://docs.expo.dev/eas-update/github-integration/' },
    { label: 'GitHub repository', hrefTemplate: '{upstream.github_repo_url}' },
    { label: 'Expo account settings', href: 'https://expo.dev/settings' },
  ],
  'user:setup-gcp-billing': [{ label: 'Google Cloud billing', href: 'https://console.cloud.google.com/billing' }],
  'user:enroll-apple-developer': [{ label: 'Apple Developer Program', href: 'https://developer.apple.com/programs/enroll/' }],
  'user:enroll-google-play': [{ label: 'Play Console signup', href: 'https://play.google.com/console/signup' }],
};

function deepMergePresentation(
  base: ResourceOutputPresentation,
  override?: ResourceOutputPresentation,
): ResourceOutputPresentation {
  if (!override) return base;
  return {
    sensitive: override.sensitive ?? base.sensitive,
    primaryLinkFromValue: override.primaryLinkFromValue ?? base.primaryLinkFromValue,
    primaryHrefTemplate: override.primaryHrefTemplate ?? base.primaryHrefTemplate,
    relatedLinks: [...(base.relatedLinks ?? []), ...(override.relatedLinks ?? [])],
  };
}

export function mergeResourcePresentation(resource: ResourceOutput): ResourceOutputPresentation {
  const reg = RESOURCE_DISPLAY_BY_KEY[resource.key] ?? {};
  const graph = resource.presentation ?? {};
  const merged = deepMergePresentation(reg, graph);
  const sensitiveDefault = DEFAULT_SENSITIVE_KEYS.has(resource.key);
  return {
    ...merged,
    sensitive: merged.sensitive ?? sensitiveDefault,
  };
}

/** Substitute `{value}` and `{upstream.some_key}`; returns null if an upstream key is missing. */
export function resolveHrefTemplate(
  template: string,
  ctx: { value: string; upstream: Record<string, string> },
): string | null {
  const upstreamKeys = new Set<string>();
  const reUp = /\{upstream\.([a-z0-9_]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = reUp.exec(template)) !== null) upstreamKeys.add(m[1]!);
  for (const k of upstreamKeys) {
    if (!ctx.upstream[k]) return null;
  }
  let out = template.replace(/\{value\}/g, ctx.value);
  out = out.replace(/\{upstream\.([a-z0-9_]+)\}/g, (_, k: string) => ctx.upstream[k] ?? '');
  return out;
}

export function resolvePortalLink(
  link: CompletionPortalLink,
  upstream: Record<string, string>,
): { label: string; href: string } | null {
  if (link.href) return { label: link.label, href: link.href };
  if (link.hrefTemplate) {
    const href = resolveHrefTemplate(link.hrefTemplate, { value: '', upstream });
    if (!href) return null;
    return { label: link.label, href };
  }
  return null;
}

export function collectUpstreamResources(nodeStates: Record<string, NodeState>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const st of Object.values(nodeStates)) {
    if (st.resourcesProduced) Object.assign(out, st.resourcesProduced);
  }
  return out;
}

export function mergeNodePortalLinks(node: ProvisioningGraphNode): CompletionPortalLink[] {
  const fromNode = node.type === 'step' || node.type === 'user-action' ? node.completionPortalLinks ?? [] : [];
  const fromRegistry = NODE_PORTAL_LINKS_BY_NODE_KEY[node.key] ?? [];
  return [...fromRegistry, ...fromNode];
}

function resolveRelatedLink(
  link: CompletionRelatedLink,
  ctx: { value: string; upstream: Record<string, string> },
): { label: string; href: string } | null {
  if (link.href) return { label: link.label, href: link.href };
  if (link.hrefTemplate) {
    const href = resolveHrefTemplate(link.hrefTemplate, ctx);
    if (!href) return null;
    return { label: link.label, href };
  }
  return null;
}

export function getPrimaryHref(
  presentation: ResourceOutputPresentation,
  value: string,
  upstream: Record<string, string>,
): string | null {
  if (presentation.sensitive) return null;
  if (presentation.primaryLinkFromValue && (value.startsWith('https://') || value.startsWith('http://'))) {
    return value;
  }
  if (presentation.primaryHrefTemplate) {
    return resolveHrefTemplate(presentation.primaryHrefTemplate, { value, upstream });
  }
  return null;
}

export function getResolvedRelatedLinks(
  presentation: ResourceOutputPresentation,
  value: string,
  upstream: Record<string, string>,
): Array<{ label: string; href: string }> {
  const links = presentation.relatedLinks ?? [];
  const out: Array<{ label: string; href: string }> = [];
  for (const link of links) {
    const r = resolveRelatedLink(link, { value, upstream });
    if (r) out.push(r);
  }
  return out;
}

export function resolvedNodePortalLinks(
  node: ProvisioningGraphNode,
  upstream: Record<string, string>,
): Array<{ label: string; href: string }> {
  const merged = mergeNodePortalLinks(node);
  const out: Array<{ label: string; href: string }> = [];
  for (const link of merged) {
    const r = resolvePortalLink(link, upstream);
    if (r) out.push(r);
  }
  return dedupeLinks(out);
}

function dedupeLinks(links: Array<{ label: string; href: string }>): Array<{ label: string; href: string }> {
  const seen = new Set<string>();
  return links.filter((l) => {
    const k = `${l.label}\0${l.href}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
