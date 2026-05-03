/**
 * Auth middleware for the Studio HTTP API — session cookies + legacy bearer token.
 *
 * Production UI authenticates via HttpOnly `studio_session` cookie (60m idle).
 * One-shot CLI handoff tokens mint a session. Legacy per-install bearer token
 * (`api-token` file) remains accepted for tests and automation.
 *
 * WebAuthn routes bypass session until registration completes; see auth-webauthn-router.
 */

import { RequestHandler } from 'express';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { getVaultSession } from './vault-session.js';
import {
  canUseDevAutoUnlockForStore,
  deriveDevVaultDek,
  ensureDevVaultMeta,
  isDevVaultAutoUnlockEnabled,
} from './dev-vault.js';

const TOKEN_FILE_NAME = 'api-token';
const TOKEN_BYTES = 32;
export const SESSION_COOKIE_NAME = 'studio_session';
const SESSION_IDLE_MS = 60 * 60 * 1000;
export const SESSION_COOKIE_MAX_AGE_SEC = Math.floor(SESSION_IDLE_MS / 1000);

export interface SessionRecord {
  createdAt: number;
  lastUsedAt: number;
}

const sessions = new Map<string, SessionRecord>();
const pendingHandoffs = new Map<string, number>();
const wsEphemeralTokens = new Map<string, { sessionId: string; expiresAt: number }>();

function sweepExpired(): void {
  const now = Date.now();
  for (const [tok, exp] of pendingHandoffs) {
    if (exp <= now) pendingHandoffs.delete(tok);
  }
  for (const [id, rec] of sessions) {
    if (now - rec.lastUsedAt > SESSION_IDLE_MS) sessions.delete(id);
  }
  for (const [t, v] of wsEphemeralTokens) {
    if (v.expiresAt <= now) wsEphemeralTokens.delete(t);
  }
}

setInterval(sweepExpired, 60_000).unref();

export function registerPendingHandoffToken(token: string, ttlMs = 120_000): void {
  pendingHandoffs.set(token, Date.now() + ttlMs);
}

export function mintSession(): string {
  const id = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  sessions.set(id, { createdAt: now, lastUsedAt: now });
  return id;
}

function touchSession(sessionId: string): boolean {
  const rec = sessions.get(sessionId);
  if (!rec) return false;
  const now = Date.now();
  if (now - rec.lastUsedAt > SESSION_IDLE_MS) {
    sessions.delete(sessionId);
    return false;
  }
  rec.lastUsedAt = now;
  return true;
}

export function resolveSession(sessionId: string): SessionRecord | undefined {
  if (!touchSession(sessionId)) return undefined;
  return sessions.get(sessionId);
}

export function revokeSession(sessionId: string): void {
  sessions.delete(sessionId);
}

const SESSION_BYPASS_PATHS = new Set<string>([
  '/health',
  '/version',
  '/auth/handoff',
  '/auth/create-handoff',
  '/auth/dev-session',
  '/auth/session',
  '/auth/ws-token',
  '/auth/register/options',
  '/auth/register/verify',
  '/auth/assert/options',
  '/auth/assert/verify',
  // Vault destroy is used from the auth gate when the user has lost their
  // passkey and needs to wipe local data without an active session.
  '/vault/destroy',
]);

export interface AuthOptions {
  storeDir: string;
  allowedOrigins?: string[];
  allowMissingOrigin?: boolean;
}

const DEFAULT_ALLOWED_ORIGINS = [
  'tauri://localhost',
  'https://tauri.localhost',
  'http://tauri.localhost',
];

export function ensureApiToken(storeDir: string): string {
  fs.mkdirSync(storeDir, { recursive: true, mode: 0o700 });
  const tokenPath = path.join(storeDir, TOKEN_FILE_NAME);

  if (fs.existsSync(tokenPath)) {
    const existing = fs.readFileSync(tokenPath, 'utf8').trim();
    if (existing.length >= 32) {
      enforceFileMode(tokenPath, 0o600);
      return existing;
    }
  }

  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

function enforceFileMode(filePath: string, mode: number): void {
  try {
    fs.chmodSync(filePath, mode);
  } catch {
    /* ignore */
  }
}

function safeEqualString(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function isLoopbackHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.toLowerCase().split(':')[0] ?? '';
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};
  const out: Record<string, string> = {};
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  }
  return out;
}

function appendCookie(res: import('express').Response, name: string, value: string, maxAgeSec: number): void {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSec}`,
  ];
  res.append('Set-Cookie', parts.join('; '));
}

function clearCookie(res: import('express').Response, name: string): void {
  res.append('Set-Cookie', `${name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

export function createAuthMiddlewares(opts: AuthOptions): {
  token: string;
  originGuard: RequestHandler;
  sessionGuard: RequestHandler;
  sessionHandler: RequestHandler;
  handoffHandler: RequestHandler;
  createHandoffHandler: RequestHandler;
  devSessionHandler: RequestHandler;
  wsTokenHandler: RequestHandler;
} {
  const token = ensureApiToken(opts.storeDir);
  const allowedOrigins = new Set([...DEFAULT_ALLOWED_ORIGINS, ...(opts.allowedOrigins ?? [])]);
  const allowMissingOrigin = opts.allowMissingOrigin ?? true;

  const originGuard: RequestHandler = (req, res, next) => {
    if (!isLoopbackHost(req.headers.host)) {
      res.status(421).json({ error: 'Misdirected request: daemon serves loopback only.' });
      return;
    }

    const origin = req.headers.origin;
    if (!origin) {
      if (allowMissingOrigin) return next();
      res.status(403).json({ error: 'Origin header required.' });
      return;
    }

    if (allowedOrigins.has(origin)) return next();

    try {
      const u = new URL(origin);
      const originHost = `${u.hostname}${u.port ? ':' + u.port : ''}`;
      if (originHost === req.headers.host) return next();
    } catch {
      /* ignore */
    }

    res.status(403).json({ error: 'Origin not allowed.' });
  };

  const sessionGuard: RequestHandler = (req, res, next) => {
    const subPath = req.path;
    if (SESSION_BYPASS_PATHS.has(subPath)) return next();

    const cookies = parseCookies(req.headers.cookie);
    const sid = cookies[SESSION_COOKIE_NAME];
    if (sid && touchSession(sid)) {
      (req as import('express').Request & { studioSessionId?: string }).studioSessionId = sid;
      return next();
    }

    const header = req.headers.authorization;
    const presented =
      typeof header === 'string' && header.toLowerCase().startsWith('bearer ')
        ? header.slice(7).trim()
        : '';

    if (presented && safeEqualString(presented, token)) {
      return next();
    }

    res.status(401).json({ error: 'Unauthorized — missing session or invalid API token.' });
  };

  const sessionHandler: RequestHandler = (_req, res) => {
    const cookies = parseCookies(_req.headers.cookie);
    const sid = cookies[SESSION_COOKIE_NAME];
    const ok = !!(sid && touchSession(sid));
    res.json({ authenticated: ok });
  };

  const handoffHandler: RequestHandler = (req, res) => {
    const body = req.body as { token?: string } | undefined;
    const handoffTok = typeof body?.token === 'string' ? body.token.trim() : '';
    if (!handoffTok) {
      res.status(400).json({ error: 'Missing token.' });
      return;
    }
    const exp = pendingHandoffs.get(handoffTok);
    if (!exp || exp < Date.now()) {
      res.status(401).json({ error: 'Invalid or expired handoff token.' });
      return;
    }
    pendingHandoffs.delete(handoffTok);
    const sid = mintSession();
    appendCookie(res, SESSION_COOKIE_NAME, sid, SESSION_COOKIE_MAX_AGE_SEC);
    res.json({
      ok: true,
      sessionExpiresAt: Date.now() + SESSION_COOKIE_MAX_AGE_SEC * 1000,
    });
  };

  const createHandoffHandler: RequestHandler = (_req, res) => {
    const tok = crypto.randomBytes(24).toString('base64url');
    registerPendingHandoffToken(tok);
    res.json({ handoffToken: tok, expiresInSec: 120 });
  };

  const devSessionHandler: RequestHandler = (req, res) => {
    // Dev-only loopback shortcut so local workflows avoid passkey on every tab reload.
    // Disabled in production builds: the bundled binary does NOT serve UI from source,
    // so a packaged Studio Pro will always return 404 here.
    const isTest = process.env['NODE_ENV'] === 'test';
    const isProd = process.env['NODE_ENV'] === 'production';
    const serveUiFromSource = process.env['STUDIO_SERVE_UI_FROM_SOURCE'] === '1';
    if (!isTest && (isProd || !serveUiFromSource)) {
      res.status(404).json({ error: 'Not found.' });
      return;
    }
    if (!isTest && !isLoopbackHost(req.headers.host)) {
      res.status(404).json({ error: 'Not found.' });
      return;
    }

    if (
      !isTest &&
      isDevVaultAutoUnlockEnabled(process.env) &&
      canUseDevAutoUnlockForStore(opts.storeDir)
    ) {
      // Keep vault encrypted at rest in dev, but auto-install a deterministic
      // DEK so local workflows do not require passkey unlock ceremonies.
      ensureDevVaultMeta(opts.storeDir);
      getVaultSession().setVaultDEK(deriveDevVaultDek(opts.storeDir));
    }

    const sid = mintSession();
    appendCookie(res, SESSION_COOKIE_NAME, sid, SESSION_COOKIE_MAX_AGE_SEC);
    res.json({ ok: true });
  };

  const wsTokenHandler: RequestHandler = (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    const sid = cookies[SESSION_COOKIE_NAME];
    if (!sid || !touchSession(sid)) {
      res.status(401).json({ error: 'Unauthorized.' });
      return;
    }
    const wsTok = crypto.randomBytes(24).toString('base64url');
    wsEphemeralTokens.set(wsTok, { sessionId: sid, expiresAt: Date.now() + 120_000 });
    res.json({ token: wsTok, expiresInSec: 120 });
  };

  return {
    token,
    originGuard,
    sessionGuard,
    sessionHandler,
    handoffHandler,
    createHandoffHandler,
    devSessionHandler,
    wsTokenHandler,
  };
}

export function validateWsEphemeralToken(presented: string): boolean {
  const row = wsEphemeralTokens.get(presented);
  if (!row || row.expiresAt < Date.now()) {
    wsEphemeralTokens.delete(presented);
    return false;
  }
  wsEphemeralTokens.delete(presented);
  return touchSession(row.sessionId);
}

export function logoutHandler(): RequestHandler {
  return (req, res) => {
    getVaultSession().seal();
    const cookies = parseCookies(req.headers.cookie);
    const sid = cookies[SESSION_COOKIE_NAME];
    if (sid) revokeSession(sid);
    clearCookie(res as import('express').Response, SESSION_COOKIE_NAME);
    res.status(204).end();
  };
}
