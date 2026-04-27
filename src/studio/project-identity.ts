/**
 * Canonical naming for Studio projects: the UI "domain" is the app hostname;
 * slug (and project id) back APIs that do not allow DNS-style names.
 */

import type { OrganizationProfile, ProjectInfo } from './project-manager.js';

const HOSTNAME_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

export function normalizeProjectDomain(domain: string): string {
  return domain.trim().toLowerCase();
}

export function isValidProjectDomain(domain: string): boolean {
  const d = normalizeProjectDomain(domain);
  return d.length > 0 && HOSTNAME_RE.test(d);
}

/** Registered app domain from project settings (empty if unset). */
export function projectPrimaryDomain(project: Pick<ProjectInfo, 'domain'>): string {
  return normalizeProjectDomain(project.domain ?? '');
}

/** Fresh record with `domain_name` when the project has an app domain (else empty). */
export function projectDomainUpstreamSeed(project: Pick<ProjectInfo, 'domain'>): Record<string, string> {
  const d = projectPrimaryDomain(project);
  return d ? { domain_name: d } : {};
}

/** Merges project app domain into an existing upstream artifact map. */
export function applyProjectDomainToUpstreamArtifacts(
  upstream: Record<string, string>,
  project: Pick<ProjectInfo, 'domain'>,
): void {
  Object.assign(upstream, projectDomainUpstreamSeed(project));
}

/** Identifier for GitHub repos, EAS project names, GCP-style ids, etc. */
export function projectResourceSlug(project: Pick<ProjectInfo, 'slug' | 'id'>): string {
  const s = project.slug?.trim();
  if (s) return s;
  return project.id?.trim() || '';
}

/**
 * Seeds upstream artifacts that come from organization-level integrations.
 *
 * These are configured once per Studio installation (e.g. the org-level Apple
 * Developer connection captures `team_id`) and must be available to every
 * provisioning step that needs them, without forcing each step's adapter to
 * re-read the integration store.
 */
export function organizationUpstreamSeed(
  organization: Pick<OrganizationProfile, 'integrations'>,
): Record<string, string> {
  const seed: Record<string, string> = {};
  const appleTeamId = organization.integrations.apple?.config?.['team_id']?.trim();
  if (appleTeamId) {
    seed['apple_team_id'] = appleTeamId;
  }
  const ascIssuerId = organization.integrations.apple?.config?.['asc_issuer_id']?.trim();
  if (ascIssuerId) {
    seed['asc_issuer_id'] = ascIssuerId;
  }
  const ascApiKeyId = organization.integrations.apple?.config?.['asc_api_key_id']?.trim();
  if (ascApiKeyId) {
    seed['asc_api_key_id'] = ascApiKeyId;
  }
  return seed;
}

/**
 * Combined initial upstream seed for orchestrator runs: project-level
 * (`domain_name`) plus organization-level (`apple_team_id`, ASC identifiers).
 */
export function buildInitialUpstreamSeed(
  project: Pick<ProjectInfo, 'domain'>,
  organization: Pick<OrganizationProfile, 'integrations'>,
): Record<string, string> {
  return {
    ...projectDomainUpstreamSeed(project),
    ...organizationUpstreamSeed(organization),
  };
}
