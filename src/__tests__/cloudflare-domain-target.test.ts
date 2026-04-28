import { resolveCloudflareDomainTarget } from '../core/cloudflare-domain-target.js';

describe('resolveCloudflareDomainTarget', () => {
  it('treats apex domains as zone-root mode', () => {
    const target = resolveCloudflareDomainTarget('third-brain.net');
    expect(target).toEqual({
      appDomain: 'third-brain.net',
      zoneDomain: 'third-brain.net',
      mode: 'zone-root',
      dnsRecordName: '@',
    });
  });

  it('treats prefixed hosts as subdomain mode', () => {
    const target = resolveCloudflareDomainTarget('flow.third-brain.net');
    expect(target).toEqual({
      appDomain: 'flow.third-brain.net',
      zoneDomain: 'third-brain.net',
      mode: 'subdomain',
      dnsRecordName: 'flow',
    });
  });

  it('throws for invalid hosts', () => {
    expect(() => resolveCloudflareDomainTarget('not_a_domain')).toThrow('Invalid Cloudflare domain');
  });
});
