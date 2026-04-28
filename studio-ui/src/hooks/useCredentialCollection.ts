/**
 * useCredentialCollection — manages credential collection state for a project.
 *
 * Handles:
 *   - Fetching what credentials are already collected
 *   - Submitting new credentials (text or file)
 *   - Showing real-time validation feedback
 *   - Retry flows for invalid credentials
 */

import { useCallback, useEffect, useState } from 'react';
import { api } from '../components/studio/helpers';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CredentialType =
  | 'github_pat'
  | 'cloudflare_token'
  | 'apple_p8'
  | 'apple_team_id'
  | 'google_play_key'
  | 'expo_token'
  | 'domain_name';

export interface CredentialSummary {
  id: string;
  project_id: string;
  credential_type: CredentialType;
  metadata: Record<string, unknown>;
  created_at: number;
  updated_at: number;
}

export interface MissingCredentialInfo {
  type: CredentialType;
  label: string;
  description: string;
  input_type: 'text' | 'file' | 'password';
  file_types?: string[];
  help_url?: string;
}

export type ValidationStatus = 'idle' | 'validating' | 'valid' | 'invalid';

interface CredentialState {
  [type: string]: ValidationStatus;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useCredentialCollection(projectId: string) {
  const [credentials, setCredentials] = useState<CredentialSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validationState, setValidationState] = useState<CredentialState>({});

  const fetchCredentials = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ credentials: CredentialSummary[] }>(
        `/projects/${projectId}/credentials`,
      );
      setCredentials(data.credentials);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (projectId) {
      fetchCredentials();
    }
  }, [projectId, fetchCredentials]);

  const submitCredential = useCallback(
    async (
      type: CredentialType,
      value: string,
      metadata?: Record<string, unknown>,
    ): Promise<{ credential_id: string } | null> => {
      setValidationState((prev) => ({ ...prev, [type]: 'validating' }));
      setError(null);
      try {
        const result = await api<{ credential_id: string; type: string; validated_at: string }>(
          `/projects/${projectId}/credentials/${type}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ value, metadata }),
          },
        );
        setValidationState((prev) => ({ ...prev, [type]: 'valid' }));
        await fetchCredentials();
        return { credential_id: result.credential_id };
      } catch (err) {
        setValidationState((prev) => ({ ...prev, [type]: 'invalid' }));
        setError((err as Error).message);
        return null;
      }
    },
    [projectId, fetchCredentials],
  );

  const submitFileCredential = useCallback(
    async (
      type: CredentialType,
      file: File,
      metadata?: Record<string, unknown>,
    ): Promise<{ credential_id: string } | null> => {
      setValidationState((prev) => ({ ...prev, [type]: 'validating' }));
      setError(null);
      try {
        const fileBuffer = await file.arrayBuffer();
        const base64 = btoa(String.fromCharCode(...new Uint8Array(fileBuffer)));

        if (fileBuffer.byteLength > 10 * 1024) {
          throw new Error('File size must not exceed 10KB.');
        }

        const result = await api<{ credential_id: string; type: string; validated_at: string }>(
          `/projects/${projectId}/credentials/${type}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file_base64: base64, metadata }),
          },
        );
        setValidationState((prev) => ({ ...prev, [type]: 'valid' }));
        await fetchCredentials();
        return { credential_id: result.credential_id };
      } catch (err) {
        setValidationState((prev) => ({ ...prev, [type]: 'invalid' }));
        setError((err as Error).message);
        return null;
      }
    },
    [projectId, fetchCredentials],
  );

  const retryCredential = useCallback(
    async (
      type: CredentialType,
      value: string,
    ): Promise<{ credential_id: string } | null> => {
      setValidationState((prev) => ({ ...prev, [type]: 'validating' }));
      setError(null);
      try {
        const result = await api<{ credential_id: string }>(
          `/projects/${projectId}/credentials/retry/${type}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ value }),
          },
        );
        setValidationState((prev) => ({ ...prev, [type]: 'valid' }));
        await fetchCredentials();
        return result;
      } catch (err) {
        setValidationState((prev) => ({ ...prev, [type]: 'invalid' }));
        setError((err as Error).message);
        return null;
      }
    },
    [projectId, fetchCredentials],
  );

  const retryFileCredential = useCallback(
    async (
      type: CredentialType,
      file: File,
    ): Promise<{ credential_id: string } | null> => {
      setValidationState((prev) => ({ ...prev, [type]: 'validating' }));
      setError(null);
      try {
        const fileBuffer = await file.arrayBuffer();
        const base64 = btoa(String.fromCharCode(...new Uint8Array(fileBuffer)));
        const result = await api<{ credential_id: string }>(
          `/projects/${projectId}/credentials/retry/${type}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file_base64: base64 }),
          },
        );
        setValidationState((prev) => ({ ...prev, [type]: 'valid' }));
        await fetchCredentials();
        return result;
      } catch (err) {
        setValidationState((prev) => ({ ...prev, [type]: 'invalid' }));
        setError((err as Error).message);
        return null;
      }
    },
    [projectId, fetchCredentials],
  );

  const deleteCredential = useCallback(
    async (credentialId: string): Promise<void> => {
      await api(`/projects/${projectId}/credentials/${credentialId}`, { method: 'DELETE' });
      await fetchCredentials();
    },
    [projectId, fetchCredentials],
  );

  const hasCredential = useCallback(
    (type: CredentialType) => credentials.some((c) => c.credential_type === type),
    [credentials],
  );

  const getValidationStatus = useCallback(
    (type: CredentialType): ValidationStatus => validationState[type] ?? 'idle',
    [validationState],
  );

  const clearError = useCallback(() => setError(null), []);

  return {
    credentials,
    loading,
    error,
    fetchCredentials,
    submitCredential,
    submitFileCredential,
    retryCredential,
    retryFileCredential,
    deleteCredential,
    hasCredential,
    getValidationStatus,
    clearError,
  };
}
