/**
 * GCP OAuth client credentials.
 *
 * This file is overwritten by the release workflow before pkg bundles the binary so the
 * official GitHub Releases binary ships with credentials pre-embedded. For local/source
 * builds the values fall back to env vars — see BUILDING.md.
 */
export const BUNDLED_GCP_CLIENT_ID = process.env['PLATFORM_GCP_OAUTH_CLIENT_ID'] ?? '';
export const BUNDLED_GCP_CLIENT_SECRET = process.env['PLATFORM_GCP_OAUTH_CLIENT_SECRET'] ?? '';
