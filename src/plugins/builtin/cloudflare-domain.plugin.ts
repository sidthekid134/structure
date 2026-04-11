import type { PluginDefinition } from '../plugin-types.js';
import {
  CLOUDFLARE_STEPS,
  CLOUDFLARE_TEARDOWN_STEPS,
  USER_ACTIONS,
} from '../../provisioning/step-registry.js';

export const cloudflareDomainPlugin: PluginDefinition = {
  id: 'cloudflare-domain',
  version: '1.0.0',
  label: 'Domain & SSL',
  description: 'DNS management, SSL, deep link routing, and AASA/asset-links hosting.',
  provider: 'cloudflare',
  providerMeta: {
    label: 'Cloudflare',
    scope: 'project',
    secretKeys: ['api_token', 'zone_id'],
    dependsOnProviders: [],
    displayMeta: {
      label: 'Cloudflare',
      color: 'text-amber-600',
      bg: 'bg-amber-500/10',
      border: 'border-amber-500/30',
    },
  },
  requiredModules: [],
  optionalModules: ['oauth-social', 'apple-signing', 'google-play-publishing'],
  includedInTemplates: ['mobile-app', 'web-app'],
  steps: [
    CLOUDFLARE_STEPS.find((s) => s.key === 'cloudflare:add-domain-zone')!,
    CLOUDFLARE_STEPS.find((s) => s.key === 'cloudflare:configure-dns')!,
    CLOUDFLARE_STEPS.find((s) => s.key === 'cloudflare:configure-ssl')!,
    CLOUDFLARE_STEPS.find((s) => s.key === 'cloudflare:setup-apple-app-site-association')!,
    CLOUDFLARE_STEPS.find((s) => s.key === 'cloudflare:setup-android-asset-links')!,
    CLOUDFLARE_STEPS.find((s) => s.key === 'cloudflare:configure-deep-link-routes')!,
  ],
  teardownSteps: [
    CLOUDFLARE_TEARDOWN_STEPS.find((s) => s.key === 'cloudflare:remove-domain-zone')!,
  ],
  userActions: [
    USER_ACTIONS.find((a) => a.key === 'user:confirm-dns-nameservers')!,
  ],
  displayMeta: {
    icon: 'Globe',
    colors: {
      primary: 'amber-500',
      text: 'text-amber-700 dark:text-amber-300',
      bg: 'bg-amber-500/10',
      border: 'border-amber-500/25',
    },
  },
  defaultJourneyPhase: 'domain_dns',
  journeyPhaseOverrides: {
    'cloudflare:configure-deep-link-routes': 'deep_links',
    'cloudflare:setup-apple-app-site-association': 'deep_links',
    'cloudflare:setup-android-asset-links': 'deep_links',
    'cloudflare:configure-ssl': 'edge_ssl',
  },
  resourceDisplay: {
    cloudflare_zone_id: {
      primaryHrefTemplate: 'https://dash.cloudflare.com/?zoneId={value}',
      relatedLinks: [
        { label: 'Cloudflare dashboard', href: 'https://dash.cloudflare.com/' },
        { label: 'DNS docs', href: 'https://developers.cloudflare.com/dns/' },
      ],
    },
    deep_link_base_url: {
      primaryLinkFromValue: true,
    },
    domain_name: {
      relatedLinks: [
        { label: 'WHOIS / registrar', hrefTemplate: 'https://www.whois.com/whois/{value}' },
      ],
    },
  },
  functionGroup: {
    id: 'infrastructure',
    label: 'Infrastructure',
    description: 'Domain, SSL, and edge network configuration',
    order: 4,
  },
};
