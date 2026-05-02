import { useEffect, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { api } from './helpers';

const HOLD_MS = 5000;

export function VaultDangerZone() {
  const [holding, setHolding] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const holdTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const startRef = useRef<number>(0);

  useEffect(() => {
    return () => {
      if (holdTimer.current) clearInterval(holdTimer.current);
    };
  }, []);

  function clearHold(): void {
    if (holdTimer.current) {
      clearInterval(holdTimer.current);
      holdTimer.current = null;
    }
    setHolding(false);
    setProgress(0);
  }

  async function finishDestroy(): Promise<void> {
    await api('/api/vault/destroy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'DESTROY_ALL_STUDIO_DATA' }),
    });
    window.location.href = '/';
  }

  return (
    <div className="rounded-xl border border-red-500/40 bg-red-500/5 p-4 space-y-3">
      <div className="flex items-start gap-2">
        <AlertTriangle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
        <div>
          <p className="text-sm font-semibold text-red-700 dark:text-red-400">Destroy local Studio data</p>
          <p className="text-xs text-muted-foreground mt-1">
            Deletes vault, passkey registry, key wrappers, and lockfile for this install. Hold for {HOLD_MS / 1000}{' '}
            seconds to confirm.
          </p>
        </div>
      </div>
      {error ? <p className="text-xs text-red-600">{error}</p> : null}
      <button
        type="button"
        className="relative w-full overflow-hidden rounded-lg border border-red-500/50 bg-red-500/10 px-3 py-2 text-xs font-bold text-red-700 dark:text-red-400 select-none"
        onPointerDown={() => {
          setError(null);
          setHolding(true);
          startRef.current = Date.now();
          holdTimer.current = setInterval(() => {
            const elapsed = Date.now() - startRef.current;
            setProgress(Math.min(1, elapsed / HOLD_MS));
            if (elapsed >= HOLD_MS) {
              clearHold();
              void finishDestroy().catch((e: Error) => setError(e.message));
            }
          }, 50);
        }}
        onPointerUp={clearHold}
        onPointerLeave={clearHold}
        onPointerCancel={clearHold}
      >
        <span className="relative z-[1]">
          {holding ? `Hold… ${Math.ceil((1 - progress) * (HOLD_MS / 1000))}s` : 'Hold to destroy all Studio data'}
        </span>
        {holding ? (
          <span
            className="absolute inset-0 bg-red-500/20 origin-left"
            style={{ transform: `scaleX(${progress})` }}
          />
        ) : null}
      </button>
    </div>
  );
}
