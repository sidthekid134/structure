import { useCallback, useEffect, useRef, useState } from 'react';
import {
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { KeyRound, Loader2 } from 'lucide-react';
import { materializePrfEvalBinaryBuffers, encodePrfClientExtensionResultsForTransport } from './helpers';

/** Must match `RESET_LOCAL_STUDIO_INSTALL_CONFIRM` in `src/studio/auth-webauthn-router.ts`. */
const RESET_LOCAL_STUDIO_INSTALL_CONFIRM = 'RESET_LOCAL_STUDIO_INSTALL_FOR_NEW_PASSKEY';

const ERASE_HOLD_MS = 5000;

const PASSKEY_RECOVERY_CODES = new Set([
  'PASSKEY_NOT_REGISTERED',
  'PASSKEY_VAULT_KEY_MISMATCH',
  'PASSKEY_VERIFY_FAILED',
  'PASSKEY_PRF_MISSING',
]);

type GateMode = 'register' | 'unlock';

export function PasskeyAuthGate({
  mode,
  lockReason = 'default',
  allowAlternateFlow = true,
  onComplete,
  onInstallReset,
}: {
  mode: GateMode;
  /** `vault-sealed`: copy explains re-open after idle; no "register instead" affordance. */
  lockReason?: 'vault-sealed' | 'default';
  /** When false, hide switching to registration (e.g. vault is locked but passkey already exists). */
  allowAlternateFlow?: boolean;
  onComplete: () => void;
  /** After local data is wiped from the gate (passkey mismatch recovery), refresh parent auth barrier. */
  onInstallReset?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showErasePanel, setShowErasePanel] = useState(false);
  const [eraseHolding, setEraseHolding] = useState(false);
  const [eraseProgress, setEraseProgress] = useState(0);
  const eraseTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const eraseStartRef = useRef<number>(0);
  /** From `/api/version` — true when this data dir has vault + wrappers + WebAuthn metadata to attempt decrypt. */
  const [vaultDecryptable, setVaultDecryptable] = useState<boolean | null>(null);
  const [webauthnUserNameHint, setWebauthnUserNameHint] = useState<string | null>(null);
  /** User chose the opposite flow (e.g. "Sign in" while the server still reports no credentials). */
  const [manualOverride, setManualOverride] = useState<GateMode | null>(null);
  const [passkeyMismatch, setPasskeyMismatch] = useState<{ code: string; message: string } | null>(null);
  const [installFetchKey, setInstallFetchKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const ver = (await fetch('/api/version', { credentials: 'include' }).then((r) => r.json())) as {
          canDecryptVault?: boolean;
          hasCredentials?: boolean;
          webauthnUserName?: string | null;
        };
        if (!cancelled) {
          setVaultDecryptable(Boolean(ver.canDecryptVault ?? ver.hasCredentials));
          setWebauthnUserNameHint(typeof ver.webauthnUserName === 'string' ? ver.webauthnUserName : null);
        }
      } catch {
        if (!cancelled) {
          setVaultDecryptable(false);
          setWebauthnUserNameHint(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [installFetchKey]);

  const serverSuggestedMode: GateMode = vaultDecryptable ? 'unlock' : 'register';
  const activeMode: GateMode =
    manualOverride ?? (vaultDecryptable === null ? mode : serverSuggestedMode);

  useEffect(() => {
    return () => {
      if (eraseTimerRef.current) clearInterval(eraseTimerRef.current);
    };
  }, []);

  function clearEraseHold(): void {
    if (eraseTimerRef.current) {
      clearInterval(eraseTimerRef.current);
      eraseTimerRef.current = null;
    }
    setEraseHolding(false);
    setEraseProgress(0);
  }

  function startEraseHold(): void {
    setError(null);
    setEraseHolding(true);
    eraseStartRef.current = Date.now();
    eraseTimerRef.current = setInterval(() => {
      const elapsed = Date.now() - eraseStartRef.current;
      const progress = Math.min(1, elapsed / ERASE_HOLD_MS);
      setEraseProgress(progress);
      if (elapsed >= ERASE_HOLD_MS) {
        clearEraseHold();
        void (async () => {
          try {
            const res = await fetch('/api/vault/destroy', {
              method: 'POST',
              credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ confirm: 'DESTROY_ALL_STUDIO_DATA' }),
            });
            if (res.ok) {
              window.location.href = '/';
            } else {
              const body = (await res.json().catch(() => ({}))) as { error?: string };
              setError(body.error ?? `Erase failed (${res.status}).`);
            }
          } catch (e) {
            setError((e as Error).message);
          }
        })();
      }
    }, 50);
  }

  const runRegister = useCallback(async () => {
    setBusy(true);
    setError(null);
    setPasskeyMismatch(null);
    try {
      const optRes = await fetch('/api/auth/register/options', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'Studio Pro' }),
      });
      if (!optRes.ok) {
        const body = (await optRes.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `Vault setup failed (${optRes.status}).`);
      }
      const { options, registrationToken } = (await optRes.json()) as {
        options: Record<string, unknown>;
        registrationToken: string;
      };
      materializePrfEvalBinaryBuffers(options);
      const attResp = await startRegistration({
        optionsJSON: options as unknown as PublicKeyCredentialCreationOptionsJSON,
      });
      encodePrfClientExtensionResultsForTransport(
        attResp.clientExtensionResults as Record<string, unknown> | undefined,
      );
      const verRes = await fetch('/api/auth/register/verify', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          registrationToken,
          response: attResp,
          label: 'Studio Pro',
        }),
      });
      const verBody = (await verRes.json().catch(() => ({}))) as {
        ok?: boolean;
        code?: string;
        bindToken?: string;
        error?: string;
      };
      if (!verRes.ok) {
        throw new Error(verBody.error || `Vault setup failed (${verRes.status}).`);
      }
      if (verBody.ok === false && verBody.code === 'PRF_BOOTSTRAP_REQUIRED' && verBody.bindToken) {
        const bootOptRes = await fetch('/api/auth/register/prf-bootstrap/options', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bindToken: verBody.bindToken }),
        });
        if (!bootOptRes.ok) {
          const b = (await bootOptRes.json().catch(() => ({}))) as { error?: string };
          throw new Error(b.error || `PRF bootstrap options failed (${bootOptRes.status}).`);
        }
        const { options, assertionToken } = (await bootOptRes.json()) as {
          options: Record<string, unknown>;
          assertionToken: string;
        };
        materializePrfEvalBinaryBuffers(options);
        const authResp = await startAuthentication({
          optionsJSON: options as unknown as PublicKeyCredentialRequestOptionsJSON,
        });
        encodePrfClientExtensionResultsForTransport(
          authResp.clientExtensionResults as Record<string, unknown> | undefined,
        );
        const bootVerRes = await fetch('/api/auth/register/prf-bootstrap/verify', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            bindToken: verBody.bindToken,
            assertionToken,
            response: authResp,
          }),
        });
        if (!bootVerRes.ok) {
          const b = (await bootVerRes.json().catch(() => ({}))) as { error?: string };
          throw new Error(b.error || `PRF bootstrap verify failed (${bootVerRes.status}).`);
        }
        const bootVerBody = (await bootVerRes.json().catch(() => ({}))) as { ok?: boolean };
        if (bootVerBody.ok !== true) {
          throw new Error('PRF bootstrap did not complete.');
        }
        onComplete();
        return;
      }
      if (verBody.ok !== true) {
        throw new Error(verBody.error || 'Vault setup did not complete.');
      }
      onComplete();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [onComplete]);

  const runUnlock = useCallback(async () => {
    setBusy(true);
    setError(null);
    setPasskeyMismatch(null);
    try {
      const optRes = await fetch('/api/auth/assert/options', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!optRes.ok) {
        const body = (await optRes.json().catch(() => ({}))) as { error?: string; code?: string };
        if (optRes.status === 404 && body.code === 'NO_PASSKEY_ON_SERVER') {
          setManualOverride(null);
        }
        throw new Error(body.error || `Unlock options failed (${optRes.status}).`);
      }
      const { options, assertionToken } = (await optRes.json()) as {
        options: Record<string, unknown>;
        assertionToken: string;
      };
      materializePrfEvalBinaryBuffers(options);
      const authResp = await startAuthentication({
        optionsJSON: options as unknown as PublicKeyCredentialRequestOptionsJSON,
      });
      encodePrfClientExtensionResultsForTransport(
        authResp.clientExtensionResults as Record<string, unknown> | undefined,
      );
      const verRes = await fetch('/api/auth/assert/verify', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assertionToken, response: authResp }),
      });
      const verBody = (await verRes.json().catch(() => ({}))) as { error?: string; code?: string };
      if (!verRes.ok) {
        if (verBody.code && PASSKEY_RECOVERY_CODES.has(verBody.code)) {
          setPasskeyMismatch({
            code: verBody.code,
            message: verBody.error || 'This authenticator did not decrypt this vault.',
          });
          return;
        }
        throw new Error(verBody.error || `Unlock failed (${verRes.status}).`);
      }
      onComplete();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [onComplete]);

  const runResetLocalInstall = useCallback(async () => {
    const ok = window.confirm(
      'Erase all local Studio data on this machine (encrypted vault, projects, keys)? This cannot be undone. You can set up the vault again afterward.',
    );
    if (!ok) return;
    setBusy(true);
    setError(null);
    setPasskeyMismatch(null);
    try {
      const res = await fetch('/api/auth/reset-local-data', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: RESET_LOCAL_STUDIO_INSTALL_CONFIRM }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        throw new Error(body.error || `Reset failed (${res.status}).`);
      }
      setManualOverride(null);
      setInstallFetchKey((k) => k + 1);
      onInstallReset?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [onInstallReset]);

  const vaultReady = vaultDecryptable === true;
  const vaultNotReady = vaultDecryptable === false;

  const title =
    activeMode === 'register'
      ? 'Set up encrypted vault'
      : lockReason === 'vault-sealed'
        ? 'Unlock vault'
        : 'Decrypt vault';
  const subtitle =
    activeMode === 'register'
      ? 'This install has no decryptable vault yet. Create one WebAuthn credential to derive the vault key (PRF)—there are no recovery codes in v1.'
      : lockReason === 'vault-sealed'
        ? 'Your session is active but the vault key is not in memory. Use the authenticator that decrypts this vault.'
        : vaultReady
          ? `This folder has an encrypted vault and the keys to try decryption.${webauthnUserNameHint ? ` Password managers often show the user as “${webauthnUserNameHint}”.` : ''} Pick the passkey that belongs to this data directory.`
          : vaultNotReady
            ? 'This folder does not have a complete vault + key bundle yet. A password manager may still list a passkey for this site from another copy of the data—that will not decrypt anything here until you finish setup.'
            : 'Checking whether this folder can decrypt a vault…';
  const noPasswordNote =
    'There is no separate vault password: decryption uses your authenticator (WebAuthn PRF). Chrome or Edge with Touch ID / Windows Hello, or a modern security key, work best.';

  const resolvingInstall = vaultDecryptable === null;

  return (
    <div
      className="fixed inset-0 z-[70] bg-black/60 backdrop-blur-sm flex items-center justify-center p-6"
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-2xl space-y-4">
        <div className="flex items-start gap-3">
          <div className="p-2 rounded-xl bg-primary/10">
            <KeyRound className="w-6 h-6 text-primary" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">{title}</h2>
            <p className="text-xs text-muted-foreground mt-1">{subtitle}</p>
            <p className="text-[11px] text-muted-foreground/90 mt-2 leading-relaxed">{noPasswordNote}</p>
          </div>
        </div>
        {error ? (
          <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-400 whitespace-pre-wrap">
            {error}
          </div>
        ) : null}
        {passkeyMismatch && !busy ? (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-3 text-xs text-amber-950 dark:text-amber-100 space-y-3">
            <p className="font-medium">Could not decrypt the vault</p>
            <p className="text-muted-foreground leading-relaxed">{passkeyMismatch.message}</p>
            <div className="flex flex-col gap-2">
              <button
                type="button"
                className="rounded-lg border border-border bg-background px-3 py-2 text-xs font-medium hover:bg-muted/60"
                onClick={() => {
                  setPasskeyMismatch(null);
                  setError(null);
                }}
              >
                Try a different passkey
              </button>
              <button
                type="button"
                className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs font-semibold text-destructive hover:bg-destructive/15"
                onClick={() => void runResetLocalInstall()}
              >
                Erase local Studio data and start fresh…
              </button>
            </div>
          </div>
        ) : null}
        <button
          type="button"
          disabled={busy || resolvingInstall || !!passkeyMismatch}
          onClick={() => void (activeMode === 'register' ? runRegister() : runUnlock())}
          className="w-full rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground inline-flex items-center justify-center gap-2 disabled:opacity-50"
        >
          {busy || resolvingInstall ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
          {busy
            ? 'Waiting for authenticator…'
            : resolvingInstall
              ? 'Checking this install…'
              : activeMode === 'register'
                ? 'Create vault key'
                : lockReason === 'vault-sealed'
                  ? 'Load vault key'
                  : 'Decrypt vault'}
        </button>
        {allowAlternateFlow && !busy && !resolvingInstall && !passkeyMismatch ? (
          <div className="flex flex-col gap-2 pt-1 border-t border-border/60">
            {activeMode === 'register' ? (
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline text-center"
                onClick={() => {
                  setError(null);
                  setManualOverride('unlock');
                }}
              >
                Try decrypt anyway (only if this folder already has a vault + keys on disk)
              </button>
            ) : (
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline text-center"
                onClick={() => {
                  setError(null);
                  setManualOverride('register');
                }}
              >
                New folder — set up encrypted vault first
              </button>
            )}
          </div>
        ) : null}
        {activeMode === 'unlock' ? (
          <div className="pt-1 border-t border-border/40">
            <button
              type="button"
              className="text-xs text-muted-foreground/60 hover:text-muted-foreground transition-colors"
              onClick={() => {
                setShowErasePanel((v) => !v);
                setEraseProgress(0);
                setEraseHolding(false);
              }}
            >
              {showErasePanel ? 'Hide' : "Don't have your passkey anymore?"}
            </button>
            {showErasePanel ? (
              <div className="mt-3 rounded-lg border border-red-500/30 bg-red-500/5 p-4 space-y-3">
                <p className="text-xs text-red-600 dark:text-red-400 leading-relaxed">
                  <strong>Permanently erases</strong> your vault, credentials, and projects on this machine. Use this only
                  if you've lost your passkey and need to start fresh.
                </p>
                <button
                  type="button"
                  className="relative w-full overflow-hidden rounded-lg border border-red-500/50 bg-red-500/10 px-3 py-2 text-xs font-bold text-red-700 dark:text-red-400 select-none"
                  onPointerDown={startEraseHold}
                  onPointerUp={clearEraseHold}
                  onPointerLeave={clearEraseHold}
                  onPointerCancel={clearEraseHold}
                >
                  <span className="relative z-[1]">
                    {eraseHolding
                      ? `Hold… ${Math.ceil((1 - eraseProgress) * (ERASE_HOLD_MS / 1000))}s`
                      : 'Hold to erase vault'}
                  </span>
                  {eraseHolding ? (
                    <span
                      className="absolute inset-0 bg-red-500/20 origin-left"
                      style={{ transform: `scaleX(${eraseProgress})` }}
                    />
                  ) : null}
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
