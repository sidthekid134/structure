/**
 * CredentialCollectionModal
 *
 * Displays a modal for collecting missing credentials for a project.
 * Supports text, password, and file upload inputs per credential type.
 * Shows real-time validation status and retry flows for invalid credentials.
 */

import { useCallback, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  FileText,
  KeyRound,
  Loader2,
  Upload,
  X,
} from 'lucide-react';
import {
  useCredentialCollection,
  type CredentialType,
  type MissingCredentialInfo,
  type ValidationStatus,
} from '../../hooks/useCredentialCollection';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CredentialCollectionModalProps {
  projectId: string;
  missingCredentials: MissingCredentialInfo[];
  onAllCollected: () => void;
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Single credential field
// ---------------------------------------------------------------------------

interface CredentialFieldProps {
  info: MissingCredentialInfo;
  projectId: string;
  onCollected: (type: CredentialType) => void;
}

function CredentialField({ info, projectId, onCollected }: CredentialFieldProps) {
  const { submitCredential, submitFileCredential, retryCredential, retryFileCredential, getValidationStatus } =
    useCredentialCollection(projectId);

  const [value, setValue] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [collected, setCollected] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const status: ValidationStatus = getValidationStatus(info.type);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) setSelectedFile(file);
  };

  const handleSubmit = useCallback(async () => {
    setFieldError(null);
    let result: { credential_id: string } | null = null;

    if (info.input_type === 'file') {
      if (!selectedFile) {
        setFieldError('Please select a file.');
        return;
      }
      if (collected) {
        result = await retryFileCredential(info.type, selectedFile);
      } else {
        result = await submitFileCredential(info.type, selectedFile);
      }
    } else {
      if (!value.trim()) {
        setFieldError('This field is required.');
        return;
      }
      if (collected) {
        result = await retryCredential(info.type, value.trim());
      } else {
        result = await submitCredential(info.type, value.trim());
      }
    }

    if (result) {
      setCollected(true);
      onCollected(info.type);
    } else {
      setFieldError('Validation failed. Check the value and try again.');
    }
  }, [
    info,
    value,
    selectedFile,
    collected,
    submitCredential,
    submitFileCredential,
    retryCredential,
    retryFileCredential,
    onCollected,
  ]);

  const inputIcon =
    info.input_type === 'file' ? (
      <FileText className="h-4 w-4 text-gray-400" />
    ) : info.input_type === 'password' ? (
      <KeyRound className="h-4 w-4 text-gray-400" />
    ) : null;

  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            {inputIcon}
            <span className="text-sm font-medium text-gray-900">{info.label}</span>
            {collected && <CheckCircle2 className="h-4 w-4 text-green-500" />}
          </div>
          <p className="mt-1 text-xs text-gray-500">{info.description}</p>
          {info.help_url && (
            <a
              href={info.help_url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 flex items-center gap-1 text-xs text-blue-600 hover:underline"
            >
              <ExternalLink className="h-3 w-3" />
              How to get this
            </a>
          )}
        </div>
        {status === 'validating' && <Loader2 className="h-4 w-4 animate-spin text-blue-500" />}
        {status === 'valid' && <CheckCircle2 className="h-4 w-4 text-green-500" />}
        {status === 'invalid' && <AlertCircle className="h-4 w-4 text-red-500" />}
      </div>

      {!collected && (
        <div className="space-y-2">
          {info.input_type === 'file' ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-2 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
              >
                <Upload className="h-4 w-4" />
                {selectedFile ? selectedFile.name : 'Choose file'}
              </button>
              {info.file_types && (
                <span className="text-xs text-gray-400">
                  Accepted: {info.file_types.join(', ')}
                </span>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept={info.file_types?.join(',')}
                onChange={handleFileSelect}
                className="hidden"
              />
            </div>
          ) : (
            <input
              type={info.input_type === 'password' ? 'password' : 'text'}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={`Enter ${info.label.toLowerCase()}...`}
              className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          )}

          {fieldError && (
            <p className="flex items-center gap-1 text-xs text-red-600">
              <AlertCircle className="h-3 w-3" />
              {fieldError}
            </p>
          )}

          <button
            type="button"
            onClick={handleSubmit}
            disabled={status === 'validating'}
            className="flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {status === 'validating' ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Validating...
              </>
            ) : (
              <>
                <CheckCircle2 className="h-4 w-4" />
                Save
              </>
            )}
          </button>
        </div>
      )}

      {collected && status === 'invalid' && (
        <button
          type="button"
          onClick={() => {
            setCollected(false);
            setValue('');
            setSelectedFile(null);
            setFieldError(null);
          }}
          className="text-xs text-blue-600 hover:underline"
        >
          Re-enter this credential
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

export function CredentialCollectionModal({
  projectId,
  missingCredentials,
  onAllCollected,
  onClose,
}: CredentialCollectionModalProps) {
  const [collectedTypes, setCollectedTypes] = useState<Set<CredentialType>>(new Set());

  const handleCollected = useCallback(
    (type: CredentialType) => {
      setCollectedTypes((prev) => {
        const next = new Set(prev);
        next.add(type);
        if (next.size === missingCredentials.length) {
          onAllCollected();
        }
        return next;
      });
    },
    [missingCredentials.length, onAllCollected],
  );

  const allCollected = collectedTypes.size >= missingCredentials.length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="relative w-full max-w-lg rounded-xl border border-gray-200 bg-white shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
          <div>
            <h2 className="text-base font-semibold text-gray-900">
              Missing Credentials
            </h2>
            <p className="mt-0.5 text-sm text-gray-500">
              {missingCredentials.length} credential{missingCredentials.length !== 1 ? 's' : ''} required before provisioning can continue.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Progress bar */}
        <div className="h-1 bg-gray-100">
          <div
            className="h-1 bg-blue-500 transition-all duration-300"
            style={{
              width: `${(collectedTypes.size / Math.max(missingCredentials.length, 1)) * 100}%`,
            }}
          />
        </div>

        {/* Credential fields */}
        <div className="max-h-[60vh] overflow-y-auto px-6 py-4 space-y-3">
          {missingCredentials.map((info) => (
            <CredentialField
              key={info.type}
              info={info}
              projectId={projectId}
              onCollected={handleCollected}
            />
          ))}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-gray-200 px-6 py-4">
          <span className="text-sm text-gray-500">
            {collectedTypes.size} of {missingCredentials.length} collected
          </span>
          {allCollected ? (
            <button
              type="button"
              onClick={onAllCollected}
              className="flex items-center gap-2 rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700"
            >
              <CheckCircle2 className="h-4 w-4" />
              Continue provisioning
            </button>
          ) : (
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
