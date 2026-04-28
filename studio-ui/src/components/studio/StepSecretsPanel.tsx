import { useEffect, useState } from 'react';
import { AlertTriangle, Copy, KeyRound, Loader2, ShieldCheck } from 'lucide-react';
import { api } from './helpers';

/**
 * Step keys that publish vault-stored secrets to a third-party. Mirror of
 * `STEP_SECRETS` in `src/studio/step-vault-secrets.ts`. Used to gate the
 * panel client-side so we don't fire metadata fetches for every expanded
 * step.
 */
const STEPS_WITH_VAULT_SECRETS = new Set<string>([
  'eas:store-token-in-github',
  'github:inject-secrets',
]);

export function stepHasVaultSecrets(stepKey: string): boolean {
  return STEPS_WITH_VAULT_SECRETS.has(stepKey);
}

interface SecretStatus {
  name: string;
  label: string;
  description: string;
  destination: string;
  vaultProvider: string;
  vaultKey: string;
  contentType: 'text' | 'json';
  present: boolean;
  length: number;
}

interface SecretsResponse {
  stepKey: string;
  secrets: SecretStatus[];
}

interface RevealResponse {
  stepKey: string;
  name: string;
  label: string;
  contentType: 'text' | 'json';
  destination: string;
  value: string;
  length: number;
}

function prettyForCopy(value: string, contentType: 'text' | 'json'): string {
  if (contentType !== 'json') return value;
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

interface CopySecretButtonProps {
  projectId: string;
  stepKey: string;
  secret: SecretStatus;
}

function CopySecretButton({ projectId, stepKey, secret }: CopySecretButtonProps) {
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCopy = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api<RevealResponse>(
        `/api/projects/${encodeURIComponent(projectId)}/provisioning/steps/${encodeURIComponent(
          stepKey,
        )}/secrets/${encodeURIComponent(secret.name)}/reveal`,
        { method: 'POST' },
      );
      const formatted = prettyForCopy(result.value, result.contentType);
      await navigator.clipboard.writeText(formatted);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch (err) {
      setError((err as Error).message || 'Failed to read secret from vault.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          void handleCopy();
        }}
        disabled={busy || !secret.present}
        title={
          secret.present
            ? `Copy plaintext ${secret.label} from the vault`
            : 'No value stored in the vault for this secret yet.'
        }
        className="inline-flex items-center gap-1.5 text-[10px] font-bold px-2 py-1 rounded border text-primary bg-primary/10 border-primary/30 hover:bg-primary/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {busy ? (
          <Loader2 size={10} className="animate-spin" />
        ) : copied ? (
          <ShieldCheck size={10} />
        ) : (
          <Copy size={10} />
        )}
        {copied ? 'COPIED' : 'COPY'}
      </button>
      {error ? (
        <span className="text-[10px] text-red-500 dark:text-red-400 max-w-[180px] text-right leading-tight">
          {error}
        </span>
      ) : null}
    </div>
  );
}

interface StepSecretsPanelProps {
  projectId: string;
  stepKey: string;
}

export function StepSecretsPanel({ projectId, stepKey }: StepSecretsPanelProps) {
  const [loading, setLoading] = useState(true);
  const [secrets, setSecrets] = useState<SecretStatus[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void api<SecretsResponse>(
      `/api/projects/${encodeURIComponent(projectId)}/provisioning/steps/${encodeURIComponent(
        stepKey,
      )}/secrets`,
    )
      .then((result) => {
        if (cancelled) return;
        setSecrets(result.secrets ?? []);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err.message || 'Failed to load step secrets.');
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, stepKey]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <Loader2 size={11} className="animate-spin" />
        Checking vault for uploaded secrets…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/30 rounded-lg p-2.5">
        <AlertTriangle size={12} className="text-red-500 shrink-0 mt-0.5" />
        <p className="text-[11px] text-red-600 dark:text-red-400 leading-relaxed">{error}</p>
      </div>
    );
  }

  if (secrets.length === 0) return null;

  return (
    <div className="space-y-2 pt-1 border-t border-border">
      <div className="flex items-center gap-1.5">
        <KeyRound size={11} className="text-muted-foreground" />
        <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
          Vault secrets uploaded by this step
        </p>
      </div>
      <p className="text-[10px] text-muted-foreground leading-snug">
        Use the step's RUN button to (re-)push these to their destination, and REVERT to remove
        them. COPY here reveals the current vault value so you can verify what would be uploaded
        (or paste it into a debug command).
      </p>
      <div className="space-y-2">
        {secrets.map((secret) => (
          <div
            key={secret.name}
            className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-border bg-muted/30 p-2.5"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-xs font-mono font-bold text-foreground">
                  {secret.label}
                </span>
                <span className="text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded border border-border bg-background text-muted-foreground">
                  {secret.destination}
                </span>
                {secret.present ? (
                  <span className="text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded border border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">
                    in vault · {secret.length} chars
                  </span>
                ) : (
                  <span className="text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded border border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400">
                    not in vault
                  </span>
                )}
              </div>
              <p className="text-[10px] text-muted-foreground leading-snug mt-1">
                {secret.description}
              </p>
              <p className="text-[10px] font-mono text-muted-foreground/70 mt-1">
                vault: {secret.vaultProvider}/{secret.vaultKey}
              </p>
            </div>
            <CopySecretButton projectId={projectId} stepKey={stepKey} secret={secret} />
          </div>
        ))}
      </div>
    </div>
  );
}
