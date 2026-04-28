/**
 * Google Play / Android SHA-1 Fingerprint Validator
 *
 * Validates SHA-1 certificate fingerprints used to link Android app signing
 * certificates to Firebase and Google Play.
 *
 * Accepted formats:
 *   - Colon-separated hex pairs: AA:BB:CC:... (40 hex chars + 19 colons = 59 chars)
 *   - Raw hex string: AABBCC... (40 hex chars)
 */

import { CredentialError } from '../types.js';

export interface FingerprintValidationResult {
  valid: boolean;
  normalized: string;
  raw_hex: string;
}

const SHA1_RAW_REGEX = /^[0-9a-f]{40}$/i;
const SHA1_COLON_REGEX = /^([0-9a-f]{2}:){19}[0-9a-f]{2}$/i;

/**
 * Validates and normalizes a SHA-1 fingerprint string.
 *
 * Returns the normalized uppercase colon-separated form (AA:BB:CC:...)
 * and the raw lowercase hex form for API submissions.
 *
 * Throws CredentialError with actionable guidance if invalid.
 */
export function validatePlayFingerprint(fingerprint: string): FingerprintValidationResult {
  const cleaned = fingerprint.trim();

  if (!cleaned) {
    throw new CredentialError(
      'SHA-1 fingerprint must not be empty. ' +
        'Find your SHA-1 fingerprint in Google Play Console → App signing → App signing key certificate.',
      'validatePlayFingerprint',
    );
  }

  let rawHex: string;

  if (SHA1_COLON_REGEX.test(cleaned)) {
    rawHex = cleaned.replace(/:/g, '').toLowerCase();
  } else if (SHA1_RAW_REGEX.test(cleaned)) {
    rawHex = cleaned.toLowerCase();
  } else {
    throw new CredentialError(
      `Invalid SHA-1 fingerprint: "${cleaned}". ` +
        'Must be 40 hex characters (e.g. "aabbccddeeff...") or colon-separated pairs ' +
        '(e.g. "AA:BB:CC:..."). ' +
        'Copy the SHA-1 certificate fingerprint from: ' +
        'Google Play Console → Setup → App signing → App signing key certificate.',
      'validatePlayFingerprint',
    );
  }

  const normalized = rawHex
    .match(/.{2}/g)!
    .map((b) => b.toUpperCase())
    .join(':');

  return {
    valid: true,
    normalized,
    raw_hex: rawHex,
  };
}
