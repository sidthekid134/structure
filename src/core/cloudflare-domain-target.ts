export type CloudflareDomainMode = 'zone-root' | 'subdomain';

export interface CloudflareDomainTarget {
  appDomain: string;
  zoneDomain: string;
  mode: CloudflareDomainMode;
  dnsRecordName: string;
}

const HOSTNAME_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

function normalizeHost(raw: string): string {
  return raw.trim().toLowerCase().replace(/\.$/, '');
}

/**
 * Resolve a Cloudflare DNS target from an app host.
 *
 * - `appDomain`: the exact host users hit for auth/deep links.
 * - `zoneDomain`: the managed Cloudflare zone (root/apex domain).
 * - `dnsRecordName`: record name inside the zone (`@` for apex).
 *
 * Note: this uses a pragmatic apex heuristic (last two labels), which matches
 * common app domains like example.com and app.example.com.
 */
export function resolveCloudflareDomainTarget(rawDomain: string): CloudflareDomainTarget {
  const appDomain = normalizeHost(rawDomain);
  if (!HOSTNAME_RE.test(appDomain)) {
    throw new Error(`Invalid Cloudflare domain "${rawDomain}". Expected a valid hostname.`);
  }

  const labels = appDomain.split('.');
  if (labels.length < 2) {
    throw new Error(`Invalid Cloudflare domain "${rawDomain}". Hostname must include a TLD.`);
  }

  const zoneDomain = labels.slice(-2).join('.');
  if (labels.length === 2) {
    return {
      appDomain,
      zoneDomain,
      mode: 'zone-root',
      dnsRecordName: '@',
    };
  }

  return {
    appDomain,
    zoneDomain,
    mode: 'subdomain',
    dnsRecordName: labels.slice(0, -2).join('.'),
  };
}
