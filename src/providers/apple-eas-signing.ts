/**
 * Apple App-Store-distribution signing minter.
 *
 * Mints (or reuses) an iOS Distribution certificate + App Store provisioning
 * profile against Apple's App Store Connect API using `@expo/apple-utils`.
 * The resulting artifacts are returned in the exact shape the EAS GraphQL
 * `appleDistributionCertificate.createAppleDistributionCertificate` and
 * `appleProvisioningProfile.createAppleProvisioningProfile` mutations expect.
 *
 * Scope is intentionally restricted to App Store distribution (no dev/ad-hoc):
 *   - Dev profiles require registered device UDIDs that Studio doesn't
 *     collect today; see step-registry.ts comment near the removed
 *     apple:create-dev-provisioning-profile step.
 *   - Apple caps each team at 2 active iOS Distribution certificates.
 *     We surface that ceiling as a hard error rather than silently
 *     reusing or revoking an existing cert — picking the wrong one to
 *     reuse would invalidate any ad-hoc/in-house workflows the user
 *     also runs against the team.
 */

import {
  Certificate,
  CertificateType,
  BundleId,
  Profile,
  ProfileType,
  ProfileState,
  Token,
  createCertificateAndP12Async,
  type RequestContext,
} from '@expo/apple-utils';

import type { AppleAscAuth } from './apple.js';

const ASC_TOKEN_DURATION_SECONDS = 1200; // Apple max is 20 minutes.

export interface AppleAppStoreSigningAssets {
  /** App Store Connect certificate id (developer portal id, e.g. "ABC123XYZ"). */
  certDeveloperPortalId: string;
  /** Base64-encoded PKCS#12 bundle (cert + private key). NO line breaks. */
  certP12Base64: string;
  /** Random password used to protect the P12. */
  certPassword: string;
  /** Base64-encoded PEM private signing key (forge-generated). */
  certPrivateSigningKey: string;
  /** Cert serial number (hex string from Apple). */
  certSerialNumber: string;
  /** Cert expiration ISO timestamp from Apple. */
  certExpirationDate: string;
  /** App Store Connect profile id (developer portal id). */
  profileDeveloperPortalId: string;
  /** Base64-encoded `.mobileprovision` file. */
  profileContentBase64: string;
  /** Profile name as recorded in the Apple developer portal. */
  profileName: string;
  /** Profile expiration ISO timestamp from Apple. */
  profileExpirationDate: string;
}

function buildAscRequestContext(auth: AppleAscAuth): RequestContext {
  return {
    token: new Token({
      key: auth.privateKeyP8,
      issuerId: auth.issuerId,
      keyId: auth.keyId,
      duration: ASC_TOKEN_DURATION_SECONDS,
    }),
  };
}

async function findExistingDistributionCertificate(
  context: RequestContext,
  serialNumber?: string,
): Promise<Certificate | null> {
  const certs = await Certificate.getAsync(context, {
    query: {
      filter: {
        certificateType: [CertificateType.IOS_DISTRIBUTION, CertificateType.DISTRIBUTION],
      },
    },
  });
  if (serialNumber) {
    return certs.find((c) => c.attributes.serialNumber === serialNumber) ?? null;
  }
  return certs.find((c) => c.attributes.status === 'Issued') ?? null;
}

/**
 * Mint a brand-new iOS Distribution certificate via Apple ASC API.
 * Does NOT check for existing certs — call findExistingDistributionCertificate
 * first if you intend to reuse. Apple caps active dist certs at 2 per team;
 * this call will fail with a clear error if the cap is hit, which we
 * propagate per the project's no-fallback rule.
 */
async function mintDistributionCertificate(context: RequestContext): Promise<{
  certificate: Certificate;
  certificateP12: string;
  password: string;
  privateSigningKey: string;
}> {
  return await createCertificateAndP12Async(context, {
    certificateType: CertificateType.IOS_DISTRIBUTION,
  });
}

async function findOrCreateAppStoreProvisioningProfile(
  context: RequestContext,
  args: { bundleIdentifier: string; certificateId: string; profileName: string },
): Promise<Profile> {
  const bundleIdItem = await BundleId.findAsync(context, {
    identifier: args.bundleIdentifier,
  });
  if (!bundleIdItem) {
    throw new Error(
      `Apple bundle identifier "${args.bundleIdentifier}" was not found on the team. ` +
        'Run "Register App ID" first so the bundle exists in Apple Developer.',
    );
  }
  const existingProfiles = await Profile.getAsync(context, {
    query: {
      filter: {
        profileType: ProfileType.IOS_APP_STORE,
        profileState: ProfileState.ACTIVE,
      },
    },
  });
  for (const p of existingProfiles) {
    const associatedBundle = await p.getBundleIdAsync().catch(() => null);
    if (associatedBundle?.attributes.identifier !== args.bundleIdentifier) continue;
    const certs = await p.getCertificatesAsync().catch(() => []);
    if (certs.some((c) => c.id === args.certificateId)) {
      return p;
    }
  }
  return await Profile.createAsync(context, {
    bundleId: bundleIdItem.id,
    name: args.profileName,
    certificates: [args.certificateId],
    devices: [],
    profileType: ProfileType.IOS_APP_STORE,
  });
}

export interface MintInput {
  ascAuth: AppleAscAuth;
  bundleIdentifier: string;
  /** Appears in Apple Developer → Profiles. Keep deterministic so re-runs find the same one. */
  profileName: string;
  /** When set, Studio attempts to reuse the cert by serial. Otherwise reuses any Issued IOS_DISTRIBUTION cert. */
  reusableSerialNumber?: string;
}

/**
 * High-level orchestrator: produces a ready-to-upload App Store distribution
 * cert + provisioning profile pair, regardless of whether the cert already
 * existed in Apple's developer portal.
 *
 * Reuse semantics:
 *   - If `reusableSerialNumber` is supplied and matches an Issued cert, we
 *     reuse it BUT note that we cannot recover the private key (Apple only
 *     hands the private key out at creation). In that case we throw — caller
 *     must provide both the serial AND the matching P12 from the vault.
 *   - Otherwise we always mint a fresh cert. Callers should persist the
 *     returned cert/profile metadata so subsequent runs become no-ops via
 *     EAS-side idempotency rather than Apple-side.
 */
export async function mintAppleAppStoreSigningAssets(
  input: MintInput,
): Promise<AppleAppStoreSigningAssets> {
  const context = buildAscRequestContext(input.ascAuth);

  if (input.reusableSerialNumber) {
    const existing = await findExistingDistributionCertificate(
      context,
      input.reusableSerialNumber,
    );
    if (!existing) {
      throw new Error(
        `App Store Connect has no Issued IOS_DISTRIBUTION certificate with serial number ` +
          `"${input.reusableSerialNumber}". The cert was likely revoked. Remove the stale ` +
          'serial from the vault and re-run to mint a fresh cert.',
      );
    }
    throw new Error(
      'Reusing an existing Apple distribution certificate requires the original P12 + ' +
        'password from the issuance moment (Apple does not expose the private key after ' +
        'creation). The vault did not have the matching P12. Revoke the stale cert in ' +
        'Apple Developer (or free a slot) so Studio can mint a new one.',
    );
  }

  const minted = await mintDistributionCertificate(context);

  const profile = await findOrCreateAppStoreProvisioningProfile(context, {
    bundleIdentifier: input.bundleIdentifier,
    certificateId: minted.certificate.id,
    profileName: input.profileName,
  });

  if (!profile.attributes.profileContent) {
    throw new Error(
      `Apple returned an empty profileContent for provisioning profile "${profile.attributes.name}" ` +
        `(${profile.id}). The profile is most likely expired or in INVALID state — inspect it at ` +
        'https://developer.apple.com/account/resources/profiles/list and re-run.',
    );
  }

  return {
    certDeveloperPortalId: minted.certificate.id,
    certP12Base64: minted.certificateP12,
    certPassword: minted.password,
    certPrivateSigningKey: minted.privateSigningKey,
    certSerialNumber: minted.certificate.attributes.serialNumber,
    certExpirationDate: minted.certificate.attributes.expirationDate,
    profileDeveloperPortalId: profile.id,
    profileContentBase64: profile.attributes.profileContent,
    profileName: profile.attributes.name,
    profileExpirationDate: profile.attributes.expirationDate,
  };
}

/**
 * Revokes the distribution cert and the provisioning profile in Apple
 * Developer Portal. Safe to call when one or the other is already missing
 * (404s are swallowed).
 */
export async function revokeAppleAppStoreSigningAssets(
  ascAuth: AppleAscAuth,
  args: { certDeveloperPortalId?: string; profileDeveloperPortalId?: string },
): Promise<void> {
  const context = buildAscRequestContext(ascAuth);
  if (args.profileDeveloperPortalId) {
    try {
      await Profile.deleteAsync(context, { id: args.profileDeveloperPortalId });
    } catch (err) {
      if (!isAppleNotFound(err)) throw err;
    }
  }
  if (args.certDeveloperPortalId) {
    try {
      await Certificate.deleteAsync(context, { id: args.certDeveloperPortalId });
    } catch (err) {
      if (!isAppleNotFound(err)) throw err;
    }
  }
}

function isAppleNotFound(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b404\b|NOT_FOUND|does not exist/i.test(msg);
}
