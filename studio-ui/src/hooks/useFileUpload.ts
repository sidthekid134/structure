/**
 * useFileUpload — manages file upload to a guided flow step.
 *
 * Handles:
 *   - File selection and drag-and-drop
 *   - Uploading with progress tracking
 *   - Polling upload validation status
 *   - Retry flows for invalid uploads
 */

import { useCallback, useState } from 'react';
import { api } from '../components/studio/helpers';
import type { FileUpload } from './useGuidedFlow';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type UploadState = 'idle' | 'uploading' | 'validating' | 'valid' | 'invalid';

export interface FileUploadOptions {
  flowId: string;
  stepId: string;
  upload_type?: 'apple_p8' | 'google_play_service_account' | 'generic';
  key_id?: string;
  team_id?: string;
  project_id?: string;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useFileUpload(options: FileUploadOptions) {
  const [uploadState, setUploadState] = useState<UploadState>('idle');
  const [uploadedFile, setUploadedFile] = useState<FileUpload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  const uploadFile = useCallback(
    async (file: File): Promise<FileUpload | null> => {
      setUploadState('uploading');
      setError(null);
      setSelectedFile(file);

      try {
        const arrayBuffer = await file.arrayBuffer();
        const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));

        if (arrayBuffer.byteLength > 10 * 1024) {
          throw new Error('File size must not exceed 10KB.');
        }

        const body: Record<string, string | undefined> = {
          file_base64: base64,
          file_name: file.name,
          upload_type: options.upload_type,
          key_id: options.key_id,
          team_id: options.team_id,
          project_id: options.project_id,
        };

        // Remove undefined keys
        for (const key of Object.keys(body)) {
          if (body[key] === undefined) delete body[key];
        }

        setUploadState('validating');
        const result = await api<{ upload_id: string }>(
          `/guided-flows/${options.flowId}/steps/${options.stepId}/upload`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          },
        );

        const upload = await api<FileUpload>(
          `/guided-flows/${options.flowId}/steps/${options.stepId}/upload/${result.upload_id}`,
        );

        setUploadedFile(upload);
        setUploadState(upload.validation_status === 'valid' ? 'valid' : 'invalid');
        if (upload.validation_error) {
          setError(upload.validation_error);
        }
        return upload;
      } catch (err) {
        setError((err as Error).message);
        setUploadState('invalid');
        return null;
      }
    },
    [options],
  );

  const reset = useCallback(() => {
    setUploadState('idle');
    setUploadedFile(null);
    setError(null);
    setSelectedFile(null);
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return {
    uploadState,
    uploadedFile,
    error,
    selectedFile,
    uploadFile,
    reset,
    clearError,
  };
}
