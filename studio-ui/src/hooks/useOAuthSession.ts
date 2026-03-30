/**
 * useOAuthSession — unified OAuth polling hook.
 *
 * Replaces three inline for-loop implementations that previously lived in
 * SetupWizard, ProvisioningGraphView, and OAuthFlowPanel. Each called a
 * different (now-removed) firebase-specific endpoint. This hook talks to the
 * provider-agnostic unified API routes:
 *
 *   POST   /api/projects/:projectId/oauth/:providerId/start
 *   GET    /api/projects/:projectId/oauth/:providerId/sessions/:sessionId
 */

import { useCallback, useRef, useState } from 'react';
import { api } from '../components/studio/helpers';

// ---------------------------------------------------------------------------
// Types mirrored from the backend OAuthManager
// ---------------------------------------------------------------------------

export interface OAuthSessionStartResponse {
  sessionId: string;
  authUrl: string;
  state: string;
  phase: 'awaiting_user';
}

export interface OAuthSessionStatusResponse {
  sessionId: string;
  phase: 'awaiting_user' | 'processing' | 'completed' | 'failed' | 'expired';
  connected: boolean;
  error?: string;
  /** Provider-specific extras forwarded verbatim from the server. */
  [key: string]: unknown;
}

export type OAuthSessionPhase =
  | 'idle'
  | 'starting'
  | 'awaiting_user'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'expired';

export interface UseOAuthSessionOptions {
  projectId: string;
  /** Provider identifier, e.g. 'gcp' or 'github'. */
  providerId: string;
  /** Max polling attempts before giving up (default: 300 × 1500 ms ≈ 7.5 min). */
  maxAttempts?: number;
  /** Interval between polls in ms (default: 1500). */
  pollIntervalMs?: number;
  /**
   * Called when the OAuth session completes successfully.
   * Receives the full final status payload.
   */
  onComplete?: (status: OAuthSessionStatusResponse) => Promise<void> | void;
  /** Called when the session fails or expires. */
  onError?: (message: string) => void;
}

export interface UseOAuthSessionReturn {
  phase: OAuthSessionPhase;
  error: string | null;
  /** Current session ID while a session is in flight; null otherwise. */
  sessionId: string | null;
  /**
   * Start a new OAuth session. Opens the auth URL in a new tab and begins
   * polling automatically. Resolves when the session reaches a terminal state
   * (completed, failed, or expired) or the max attempt limit is reached.
   */
  start: () => Promise<void>;
  /**
   * Poll a session that was started externally (e.g. triggered server-side
   * by plan/sync needsReauth). Opens the provided authUrl in a new tab and
   * polls until terminal.
   */
  pollExternal: (sessionId: string, authUrl: string) => Promise<OAuthSessionStatusResponse | null>;
  reset: () => void;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useOAuthSession({
  projectId,
  providerId,
  maxAttempts = 300,
  pollIntervalMs = 1500,
  onComplete,
  onError,
}: UseOAuthSessionOptions): UseOAuthSessionReturn {
  const [phase, setPhase] = useState<OAuthSessionPhase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);

  // Let callers cancel an in-flight poll by flipping this ref.
  const cancelRef = useRef(false);

  const reset = useCallback(() => {
    cancelRef.current = true;
    setPhase('idle');
    setError(null);
    setSessionId(null);
  }, []);

  /** Core polling loop shared by start() and pollExternal(). */
  const poll = useCallback(
    async (sid: string): Promise<OAuthSessionStatusResponse | null> => {
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (cancelRef.current) return null;
        await new Promise<void>((r) => setTimeout(r, pollIntervalMs));
        if (cancelRef.current) return null;

        try {
          const status = await api<OAuthSessionStatusResponse>(
            `/api/projects/${encodeURIComponent(projectId)}/oauth/${encodeURIComponent(providerId)}/sessions/${encodeURIComponent(sid)}`,
          );

          if (status.phase === 'processing') {
            setPhase('processing');
          }

          if (status.phase === 'completed' && status.connected) {
            if (!cancelRef.current) {
              setPhase('completed');
              await onComplete?.(status);
            }
            return status;
          }

          if (status.phase === 'failed' || status.phase === 'expired') {
            const msg = (status.error as string | undefined) ?? `OAuth session ${status.phase}.`;
            if (!cancelRef.current) {
              setPhase(status.phase);
              setError(msg);
              onError?.(msg);
            }
            return status;
          }
        } catch {
          // transient poll error — keep trying
        }
      }

      const timeoutMsg = 'Re-authentication timed out. Please try again.';
      if (!cancelRef.current) {
        setPhase('failed');
        setError(timeoutMsg);
        onError?.(timeoutMsg);
      }
      return null;
    },
    [projectId, providerId, maxAttempts, pollIntervalMs, onComplete, onError],
  );

  const start = useCallback(async () => {
    cancelRef.current = false;
    setPhase('starting');
    setError(null);
    setSessionId(null);

    try {
      const session = await api<OAuthSessionStartResponse>(
        `/api/projects/${encodeURIComponent(projectId)}/oauth/${encodeURIComponent(providerId)}/start`,
        { method: 'POST' },
      );

      setSessionId(session.sessionId);
      setPhase('awaiting_user');
      window.open(session.authUrl, '_blank', 'noopener,noreferrer');

      await poll(session.sessionId);
    } catch (err) {
      const msg = (err as Error).message;
      setPhase('failed');
      setError(msg);
      onError?.(msg);
    }
  }, [projectId, providerId, poll, onError]);

  const pollExternal = useCallback(
    async (sid: string, authUrl: string): Promise<OAuthSessionStatusResponse | null> => {
      cancelRef.current = false;
      setPhase('awaiting_user');
      setError(null);
      setSessionId(sid);

      window.open(authUrl, '_blank', 'noopener,noreferrer');
      return poll(sid);
    },
    [poll],
  );

  return { phase, error, sessionId, start, pollExternal, reset };
}
