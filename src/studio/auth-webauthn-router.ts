/**
 * WebAuthn vault setup and unlock — `/api/auth/register/*`, `/api/auth/assert/*`.
 * First-time flow creates encrypted vault material; unlock proves the authenticator decrypts it.
 */

import * as crypto from 'crypto';
import { Router, Request, Response } from 'express';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  supportedCOSEAlgorithmIdentifiers,
} from '@simplewebauthn/server';

import { VaultManager } from '../vault.js';
import { getVaultSession } from './vault-session.js';
import {
  loadUsers,
  saveUsers,
  type StoredCredential,
  type UsersFile,
} from './users-store.js';
import {
  upsertWrappedDek,
  unwrapDekWithPrf,
  getWrappedDekForCredential,
} from './key-wrappers.js';
import { writeVaultMeta } from './vault-meta.js';
import { SESSION_COOKIE_NAME, SESSION_COOKIE_MAX_AGE_SEC, mintSession, revokeSession } from './auth.js';
import { destroyLocalStudioInstall } from './studio-local-data-destroy.js';

const RP_NAME = 'Studio Pro';

/** Body.confirm for `POST /api/auth/reset-local-data` (must match client). */
const RESET_LOCAL_STUDIO_INSTALL_CONFIRM = 'RESET_LOCAL_STUDIO_INSTALL_FOR_NEW_PASSKEY';

/**
 * WebAuthn rpID must equal the registration/authentication origin's host (see WebAuthn § RP ID).
 * Defaults and docs use http://localhost — use that hostname in the browser so @simplewebauthn
 * error helpers and WebAuthn rpID line up; the daemon may still bind 127.0.0.1.
 */
function hostnameFromRequest(req: Request): string | null {
  const origin = req.get('origin');
  if (origin) {
    try {
      return new URL(origin).hostname;
    } catch {
      return null;
    }
  }
  const host = req.get('host');
  if (!host) return null;
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return null;
  }
}

/** Allowed Studio hosts for rpID (loopback + Tauri embedded UI). */
function rpIdFromRequest(req: Request): string | null {
  const hostname = hostnameFromRequest(req);
  if (!hostname) return null;
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return h;
  if (h === 'tauri.localhost') return 'tauri.localhost';
  return null;
}

/**
 * Advertise the same broad COSE algorithm set SimpleWebAuthn uses for verification defaults (minus
 * deprecated RS1). A narrow list (-7/-8/-257) makes Chrome report "No available authenticator
 * supported any of the specified pubKeyCredParams algorithms" on some platform/security-key combos.
 */
const REGISTRATION_SUPPORTED_ALGORITHM_IDS = supportedCOSEAlgorithmIdentifiers.filter((id) => id !== -65535);

interface RegTokenState {
  challenge: string;
  prfSaltB64: string;
  label: string;
  userIDB64: string;
  expiresAt: number;
}

interface AssertTokenState {
  challenge: string;
  credentialIDs: string[];
  expiresAt: number;
}

/** Attestation verified but PRF bytes missing (e.g. 1Password) — finish via prf-bootstrap assertion. */
interface PendingPrfBootstrap {
  storeDir: string;
  dek: Buffer;
  credentialID: string;
  credentialPublicKeyB64: string;
  counter: number;
  transports?: string[];
  prfSaltB64: string;
  userIDB64: string;
  label: string;
  expiresAt: number;
}

interface PrfBootstrapAssertState {
  challenge: string;
  bindToken: string;
  expiresAt: number;
}

const registrationChallenges = new Map<string, RegTokenState>();
const assertionChallenges = new Map<string, AssertTokenState>();
const pendingPrfBootstraps = new Map<string, PendingPrfBootstrap>();
/** At most one in-flight deferred PRF registration per store directory. */
const pendingPrfBootstrapBindTokenByStoreDir = new Map<string, string>();
const prfBootstrapAssertionChallenges = new Map<string, PrfBootstrapAssertState>();

function clearPendingPrfBootstrapForStoreDir(storeDir: string): void {
  for (const [bindToken, v] of pendingPrfBootstraps) {
    if (v.storeDir === storeDir) pendingPrfBootstraps.delete(bindToken);
  }
  pendingPrfBootstrapBindTokenByStoreDir.delete(storeDir);
}

function sweepMaps(): void {
  const now = Date.now();
  for (const [k, v] of registrationChallenges) {
    if (v.expiresAt <= now) registrationChallenges.delete(k);
  }
  for (const [k, v] of assertionChallenges) {
    if (v.expiresAt <= now) assertionChallenges.delete(k);
  }
  for (const [k, v] of prfBootstrapAssertionChallenges) {
    if (v.expiresAt <= now) prfBootstrapAssertionChallenges.delete(k);
  }
  for (const [bindToken, v] of pendingPrfBootstraps) {
    if (v.expiresAt <= now) {
      pendingPrfBootstraps.delete(bindToken);
      if (pendingPrfBootstrapBindTokenByStoreDir.get(v.storeDir) === bindToken) {
        pendingPrfBootstrapBindTokenByStoreDir.delete(v.storeDir);
      }
    }
  }
}
setInterval(sweepMaps, 30_000).unref();

function appendCookie(res: Response, value: string): void {
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${SESSION_COOKIE_MAX_AGE_SEC}`,
  ];
  res.append('Set-Cookie', parts.join('; '));
}

function mintCookie(res: Response): string {
  const sid = mintSession();
  appendCookie(res, sid);
  return sid;
}

function expectedOrigin(req: Request): string {
  const o = req.get('origin');
  if (o) return o;
  const host = req.get('host') ?? '127.0.0.1:3737';
  return `http://${host}`;
}

/** PRF `first` / `second` as base64url string, or a JSON array of byte values after `JSON.stringify`/`parse`. */
function normalizePrfResultBytes(value: unknown): string | undefined {
  if (typeof value === 'string' && value) return value;
  if (!Array.isArray(value) || value.length === 0) return undefined;
  for (const b of value) {
    if (typeof b !== 'number' || !Number.isInteger(b) || b < 0 || b > 255) return undefined;
  }
  return Buffer.from(value as number[]).toString('base64url');
}

/**
 * Read PRF extension output (`results.first`) from clientExtensionResults.
 * W3C WebAuthn uses lowercase `first`; some older builds used `FIRST`.
 * Browsers may send `first` as base64url or as a byte array once JSON-serialized.
 */
function prfFirstFromClientResults(clientExtensionResults: unknown): string | undefined {
  const ext = clientExtensionResults as
    | { prf?: { results?: { first?: unknown; FIRST?: unknown } } }
    | undefined;
  const r = ext?.prf?.results;
  if (!r || typeof r !== 'object') return undefined;
  const fromFirst = normalizePrfResultBytes((r as { first?: unknown }).first);
  if (fromFirst) return fromFirst;
  return normalizePrfResultBytes((r as { FIRST?: unknown }).FIRST);
}

function prfRegistrationOutput(res: { clientExtensionResults?: unknown }): string | undefined {
  return prfFirstFromClientResults(res.clientExtensionResults);
}

function prfAuthOutput(res: { clientExtensionResults?: unknown }): string | undefined {
  return prfFirstFromClientResults(res.clientExtensionResults);
}

export function createWebAuthnRouter(storeDir: string, vaultManager: VaultManager): Router {
  const router = Router();
  const session = getVaultSession();

  router.post('/auth/register/options', async (req: Request, res: Response) => {
    sweepMaps();
    const rpId = rpIdFromRequest(req);
    if (!rpId) {
      res.status(400).json({
        error:
          'Could not determine WebAuthn RP ID from Origin/Host. Open Studio at http://localhost:<port> (recommended) or ensure Origin matches the host (127.0.0.1 vs localhost are different origins).',
      });
      return;
    }

    const existing = loadUsers(storeDir);
    if (existing && existing.credentials.length > 0) {
      res.status(409).json({
        error:
          'This install already has vault unlock material on disk. Use “Unlock vault” with the passkey that decrypts this data, or erase local data to start over.',
      });
      return;
    }
    if (pendingPrfBootstrapBindTokenByStoreDir.has(storeDir)) {
      res.status(409).json({
        error:
          'Vault setup is waiting for a second WebAuthn step (PRF). Complete it or wait a few minutes.',
      });
      return;
    }

    const label = typeof req.body?.label === 'string' ? req.body.label.trim() || 'Passkey' : 'Passkey';
    const userIDbytes = crypto.randomBytes(16);
    const prfSalt = crypto.randomBytes(32);

    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: rpId,
      userName: 'studio-local-user',
      userDisplayName: 'Studio Pro User',
      userID: userIDbytes,
      authenticatorSelection: {
        // `required` is stricter than SimpleWebAuthn defaults and can exclude some platform
        // authenticators; PRF still comes from extension results when the authenticator supports it.
        residentKey: 'preferred',
        userVerification: 'preferred',
      },
      supportedAlgorithmIDs: [...REGISTRATION_SUPPORTED_ALGORITHM_IDS],
    });

    const registrationToken = crypto.randomBytes(24).toString('base64url');
    const optExt = options as unknown as Record<string, unknown>;
    // W3C §10.1.4: registration MUST use `prf.eval.first` (JSON: lowercase `first`). Including
    // `evalByCredential` (even empty) is a spec violation and makes Chromium reject the ceremony,
    // often surfacing as "No available authenticator supported any of the specified pubKeyCredParams algorithms".
    optExt.extensions = {
      prf: {
        eval: {
          first: prfSalt.toString('base64url'),
        },
      },
    };

    registrationChallenges.set(registrationToken, {
      challenge: options.challenge as string,
      prfSaltB64: prfSalt.toString('base64'),
      label,
      userIDB64: userIDbytes.toString('base64url'),
      expiresAt: Date.now() + 5 * 60_000,
    });

    res.json({ options: optExt, registrationToken });
  });

  router.post('/auth/register/verify', async (req: Request, res: Response) => {
    sweepMaps();
    const registrationToken = typeof req.body?.registrationToken === 'string' ? req.body.registrationToken : '';
    const response = req.body?.response;
    const label =
      typeof req.body?.label === 'string' ? req.body.label.trim() : undefined;

    if (!registrationToken || !response || typeof response !== 'object') {
      res.status(400).json({ error: 'registrationToken and response are required.' });
      return;
    }

    const state = registrationChallenges.get(registrationToken);
    if (!state || state.expiresAt < Date.now()) {
      res.status(404).json({ error: 'Unknown or expired registrationToken.' });
      return;
    }

    const prfOut = prfRegistrationOutput(response as { clientExtensionResults?: unknown });

    const rpId = rpIdFromRequest(req);
    if (!rpId) {
      res.status(400).json({ error: 'Could not determine WebAuthn RP ID from Origin/Host.' });
      return;
    }

    let verified;
    try {
      verified = await verifyRegistrationResponse({
        response,
        expectedChallenge: state.challenge,
        expectedOrigin: expectedOrigin(req),
        expectedRPID: rpId,
        supportedAlgorithmIDs: [...REGISTRATION_SUPPORTED_ALGORITHM_IDS],
      });
    } catch (e) {
      res.status(401).json({ error: (e as Error).message, code: 'WEBAUTHN_VERIFICATION_FAILED' });
      return;
    }

    if (!verified.verified || !verified.registrationInfo) {
      res.status(401).json({ error: 'Registration verification failed.' });
      return;
    }

    const cred = verified.registrationInfo.credential;
    const credentialID = cred.id;
    const pubB64 = Buffer.from(cred.publicKey).toString('base64');
    const dek = crypto.randomBytes(32);

    if (prfOut) {
      upsertWrappedDek(storeDir, credentialID, prfOut, dek);

      const data = vaultManager.loadVaultFromMasterKey(dek);
      vaultManager.saveVaultFromMasterKey(dek, data);

      writeVaultMeta(storeDir, { vaultKeyMode: 'dek-v1' });
      session.setVaultDEK(dek);

      const stored: StoredCredential = {
        credentialID,
        credentialPublicKeyB64: pubB64,
        counter: cred.counter,
        transports: cred.transports as string[] | undefined,
        label: label ?? state.label,
        prfSaltB64: state.prfSaltB64,
        createdAt: Date.now(),
      };

      const users: UsersFile = {
        version: 1,
        userID: state.userIDB64,
        userName: 'studio-local-user',
        credentials: [stored],
      };
      saveUsers(storeDir, users);

      registrationChallenges.delete(registrationToken);

      const expires = Date.now() + SESSION_COOKIE_MAX_AGE_SEC * 1000;
      mintCookie(res);
      res.json({
        ok: true,
        credentialId: credentialID,
        sessionExpiresAt: expires,
      });
      return;
    }

    const bindToken = crypto.randomBytes(24).toString('base64url');
    pendingPrfBootstraps.set(bindToken, {
      storeDir,
      dek,
      credentialID,
      credentialPublicKeyB64: pubB64,
      counter: cred.counter,
      transports: cred.transports as string[] | undefined,
      prfSaltB64: state.prfSaltB64,
      userIDB64: state.userIDB64,
      label: label ?? state.label,
      expiresAt: Date.now() + 5 * 60_000,
    });
    pendingPrfBootstrapBindTokenByStoreDir.set(storeDir, bindToken);
    registrationChallenges.delete(registrationToken);

    res.status(200).json({
      ok: false,
      code: 'PRF_BOOTSTRAP_REQUIRED',
      bindToken,
      error:
        'PRF output was not returned during registration (common with password managers). Approve one more WebAuthn prompt to finish.',
    });
  });

  router.post('/auth/register/prf-bootstrap/options', async (req: Request, res: Response) => {
    sweepMaps();
    const bindToken = typeof req.body?.bindToken === 'string' ? req.body.bindToken.trim() : '';
    const pending = bindToken ? pendingPrfBootstraps.get(bindToken) : undefined;
    if (!pending || pending.expiresAt < Date.now()) {
      res.status(404).json({ error: 'Unknown or expired bindToken.' });
      return;
    }

    const rpId = rpIdFromRequest(req);
    if (!rpId) {
      res.status(400).json({ error: 'Could not determine WebAuthn RP ID from Origin/Host.' });
      return;
    }

    const assertionToken = crypto.randomBytes(24).toString('base64url');

    const opts = await generateAuthenticationOptions({
      rpID: rpId,
      allowCredentials: [
        {
          id: pending.credentialID,
          transports: pending.transports as ('internal' | 'hybrid' | 'usb' | 'ble' | 'nfc')[] | undefined,
        },
      ],
      userVerification: 'required',
    });

    const saltBuf = Buffer.from(pending.prfSaltB64, 'base64');
    const optExt = opts as unknown as Record<string, unknown>;
    optExt.extensions = {
      prf: {
        eval: {
          first: saltBuf.toString('base64url'),
        },
      },
    };

    prfBootstrapAssertionChallenges.set(assertionToken, {
      challenge: opts.challenge as string,
      bindToken,
      expiresAt: Date.now() + 5 * 60_000,
    });

    res.json({ options: optExt, assertionToken });
  });

  router.post('/auth/register/prf-bootstrap/verify', async (req: Request, res: Response) => {
    sweepMaps();
    const bindToken = typeof req.body?.bindToken === 'string' ? req.body.bindToken.trim() : '';
    const assertionToken = typeof req.body?.assertionToken === 'string' ? req.body.assertionToken.trim() : '';
    const response = req.body?.response;

    if (!bindToken || !assertionToken || !response || typeof response !== 'object') {
      res.status(400).json({ error: 'bindToken, assertionToken, and response are required.' });
      return;
    }

    const pending = pendingPrfBootstraps.get(bindToken);
    if (!pending || pending.expiresAt < Date.now()) {
      res.status(404).json({ error: 'Unknown or expired bindToken.' });
      return;
    }

    const aState = prfBootstrapAssertionChallenges.get(assertionToken);
    if (!aState || aState.expiresAt < Date.now() || aState.bindToken !== bindToken) {
      res.status(404).json({ error: 'Unknown or expired assertionToken.' });
      return;
    }

    const rid = (response as { id?: string }).id;
    if (!rid || rid !== pending.credentialID) {
      res.status(400).json({ error: 'Credential mismatch.' });
      return;
    }

    const prfOut = prfAuthOutput(response as { clientExtensionResults?: unknown });
    if (!prfOut) {
      res.status(401).json({ error: 'PRF extension results missing on bootstrap assertion.' });
      return;
    }

    const rpId = rpIdFromRequest(req);
    if (!rpId) {
      res.status(400).json({ error: 'Could not determine WebAuthn RP ID from Origin/Host.' });
      return;
    }

    const credentialPub = Buffer.from(pending.credentialPublicKeyB64, 'base64');

    let auth;
    try {
      auth = await verifyAuthenticationResponse({
        response: response as import('@simplewebauthn/server').AuthenticationResponseJSON,
        expectedChallenge: aState.challenge,
        expectedOrigin: expectedOrigin(req),
        expectedRPID: rpId,
        credential: {
          id: pending.credentialID,
          publicKey: credentialPub,
          counter: pending.counter,
          transports: pending.transports as ('internal' | 'hybrid' | 'usb' | 'ble' | 'nfc')[] | undefined,
        },
      });
    } catch (e) {
      res.status(401).json({ error: (e as Error).message });
      return;
    }

    if (!auth.verified) {
      res.status(401).json({ error: 'Assertion not verified.' });
      return;
    }

    try {
      upsertWrappedDek(pending.storeDir, pending.credentialID, prfOut, pending.dek);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
      return;
    }

    const data = vaultManager.loadVaultFromMasterKey(pending.dek);
    vaultManager.saveVaultFromMasterKey(pending.dek, data);

    writeVaultMeta(pending.storeDir, { vaultKeyMode: 'dek-v1' });
    session.setVaultDEK(pending.dek);

    const stored: StoredCredential = {
      credentialID: pending.credentialID,
      credentialPublicKeyB64: pending.credentialPublicKeyB64,
      counter: auth.authenticationInfo.newCounter,
      transports: pending.transports,
      label: pending.label,
      prfSaltB64: pending.prfSaltB64,
      createdAt: Date.now(),
    };

    const users: UsersFile = {
      version: 1,
      userID: pending.userIDB64,
      userName: 'studio-local-user',
      credentials: [stored],
    };
    saveUsers(pending.storeDir, users);

    pendingPrfBootstraps.delete(bindToken);
    pendingPrfBootstrapBindTokenByStoreDir.delete(pending.storeDir);
    prfBootstrapAssertionChallenges.delete(assertionToken);

    const expires = Date.now() + SESSION_COOKIE_MAX_AGE_SEC * 1000;
    mintCookie(res);
    res.json({
      ok: true,
      credentialId: pending.credentialID,
      sessionExpiresAt: expires,
    });
  });

  router.post('/auth/assert/options', async (req: Request, res: Response) => {
    sweepMaps();
    const rpId = rpIdFromRequest(req);
    if (!rpId) {
      res.status(400).json({ error: 'Could not determine WebAuthn RP ID from Origin/Host.' });
      return;
    }

    const users = loadUsers(storeDir);
    if (!users || users.credentials.length === 0) {
      res.status(404).json({
        code: 'NO_PASSKEY_ON_SERVER',
        error:
          'This install cannot unlock the vault from server state (missing vault file, key wrappers, or WebAuthn metadata). A password manager may still offer a passkey for this URL from another copy of the data folder.',
      });
      return;
    }

    const singleRegisteredCred = users.credentials.length === 1;
    const allowCredentials = users.credentials.map((c) => ({
      id: c.credentialID,
      transports: c.transports as ('internal' | 'hybrid' | 'usb' | 'ble' | 'nfc')[] | undefined,
    }));

    const assertionToken = crypto.randomBytes(24).toString('base64url');

    const opts = await generateAuthenticationOptions({
      rpID: rpId,
      ...(singleRegisteredCred ? {} : { allowCredentials }),
      userVerification: 'required',
    });

    const firstCred = users.credentials[0];
    const saltBuf = Buffer.from(firstCred.prfSaltB64, 'base64');

    const optExt = opts as unknown as Record<string, unknown>;
    optExt.extensions = {
      prf: {
        eval: {
          first: saltBuf.toString('base64url'),
        },
      },
    };

    assertionChallenges.set(assertionToken, {
      challenge: opts.challenge as string,
      credentialIDs: users.credentials.map((c) => c.credentialID),
      expiresAt: Date.now() + 5 * 60_000,
    });

    res.json({ options: optExt, assertionToken });
  });

  router.post('/auth/assert/verify', async (req: Request, res: Response) => {
    sweepMaps();
    const assertionToken = typeof req.body?.assertionToken === 'string' ? req.body.assertionToken : '';
    const response = req.body?.response;

    if (!assertionToken || !response || typeof response !== 'object') {
      res.status(400).json({ error: 'assertionToken and response are required.' });
      return;
    }

    const state = assertionChallenges.get(assertionToken);
    if (!state || state.expiresAt < Date.now()) {
      res.status(404).json({ error: 'Unknown or expired assertionToken.' });
      return;
    }

    const users = loadUsers(storeDir);
    if (!users) {
      res.status(404).json({ error: 'No credentials.' });
      return;
    }

    const rid = (response as { id?: string }).id;
    if (!rid) {
      res.status(400).json({ error: 'Missing credential id in response.' });
      return;
    }

    const stored = users.credentials.find((c) => c.credentialID === rid);
    if (!stored) {
      res.status(409).json({
        code: 'PASSKEY_NOT_REGISTERED',
        error:
          'This WebAuthn credential is not the one bound to this vault on disk. Try another passkey, or reset local data and set up the vault again.',
      });
      return;
    }

    const wrapped = getWrappedDekForCredential(storeDir, stored.credentialID);
    if (!wrapped) {
      res.status(500).json({ error: 'Missing DEK wrapper for credential.' });
      return;
    }

    const prfOut = prfAuthOutput(response as { clientExtensionResults?: unknown });
    if (!prfOut) {
      res.status(401).json({
        code: 'PASSKEY_PRF_MISSING',
        error: 'PRF extension results missing on this sign-in attempt.',
      });
      return;
    }

    let dek: Buffer;
    try {
      dek = unwrapDekWithPrf(prfOut, wrapped);
    } catch {
      res.status(409).json({
        code: 'PASSKEY_VAULT_KEY_MISMATCH',
        error:
          'This passkey does not decrypt this vault (PRF output does not unwrap the stored key). Try another passkey, or reset local data and set up the vault again.',
      });
      return;
    }

    const credentialPub = Buffer.from(stored.credentialPublicKeyB64, 'base64');

    const rpId = rpIdFromRequest(req);
    if (!rpId) {
      res.status(400).json({ error: 'Could not determine WebAuthn RP ID from Origin/Host.' });
      return;
    }

    let auth;
    try {
      auth = await verifyAuthenticationResponse({
        response: response as import('@simplewebauthn/server').AuthenticationResponseJSON,
        expectedChallenge: state.challenge,
        expectedOrigin: expectedOrigin(req),
        expectedRPID: rpId,
        credential: {
          id: stored.credentialID,
          publicKey: credentialPub,
          counter: stored.counter,
          transports: stored.transports as ('internal' | 'hybrid' | 'usb' | 'ble' | 'nfc')[] | undefined,
        },
      });
    } catch (e) {
      res.status(401).json({
        code: 'PASSKEY_VERIFY_FAILED',
        error: (e as Error).message,
      });
      return;
    }

    if (!auth.verified) {
      res.status(401).json({
        code: 'PASSKEY_VERIFY_FAILED',
        error: 'Assertion not verified.',
      });
      return;
    }

    stored.counter = auth.authenticationInfo.newCounter;
    saveUsers(storeDir, users);

    assertionChallenges.delete(assertionToken);

    vaultManager.loadVaultFromMasterKey(dek);
    session.setVaultDEK(dek);

    const expires = Date.now() + SESSION_COOKIE_MAX_AGE_SEC * 1000;
    mintCookie(res);
    res.json({ ok: true, credentialId: stored.credentialID, sessionExpiresAt: expires });
  });

  router.post('/auth/reset-local-data', (req: Request, res: Response) => {
    const confirm = typeof req.body?.confirm === 'string' ? req.body.confirm : '';
    if (confirm !== RESET_LOCAL_STUDIO_INSTALL_CONFIRM) {
      res.status(400).json({ error: 'Invalid confirmation.' });
      return;
    }
    try {
      destroyLocalStudioInstall(storeDir);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
      return;
    }
    clearPendingPrfBootstrapForStoreDir(storeDir);
    session.seal();
    const sid = (req as Request & { cookies?: Record<string, string> }).cookies?.[SESSION_COOKIE_NAME];
    if (sid) revokeSession(sid);
    res.clearCookie(SESSION_COOKIE_NAME, { path: '/', httpOnly: true, sameSite: 'strict' });
    res.json({ ok: true });
  });

  return router;
}
