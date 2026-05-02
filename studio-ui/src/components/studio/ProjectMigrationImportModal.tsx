import { useState } from 'react';
import type { ProjectMigrationBundle } from './types';

export function ProjectMigrationImportModal({
  show,
  isImporting,
  onClose,
  onImport,
}: {
  show: boolean;
  isImporting: boolean;
  onClose: () => void;
  onImport: (bundle: ProjectMigrationBundle, passphrase?: string) => Promise<void>;
}) {
  const [bundle, setBundle] = useState<ProjectMigrationBundle | null>(null);
  const [fileName, setFileName] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (!show) {
    return null;
  }

  const reset = () => {
    setBundle(null);
    setFileName('');
    setPassphrase('');
    setError(null);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6">
      <div className="w-full max-w-lg rounded-xl border border-border bg-card p-5 space-y-4 shadow-lg">
        <div>
          <h2 className="text-lg font-semibold">Import Project Migration</h2>
          <p className="text-xs text-muted-foreground mt-1">
            Restore a project from an encrypted migration file. If the bundle was exported with a passphrase, enter it
            below — credentials will be re-encrypted into your current vault on import.
          </p>
        </div>

        <label className="block text-xs font-semibold text-muted-foreground">
          Migration File
          <input
            type="file"
            accept="application/json,.json"
            className="mt-1 block w-full text-sm file:mr-3 file:rounded-md file:border file:border-border file:bg-background file:px-3 file:py-1.5 file:text-xs file:font-semibold hover:file:bg-accent"
            onChange={(event) => {
              const file = event.target.files?.[0];
              setError(null);
              setBundle(null);
              if (!file) {
                setFileName('');
                return;
              }
              setFileName(file.name);
              void file
                .text()
                .then((text) => {
                  const parsed = JSON.parse(text) as ProjectMigrationBundle;
                  if (
                    parsed.format !== 'studio-project-migration' ||
                    parsed.version !== 1 ||
                    typeof parsed.projectId !== 'string' ||
                    typeof parsed.encryptedPayload !== 'string'
                  ) {
                    throw new Error('This file is not a valid Studio migration bundle.');
                  }
                  setBundle(parsed);
                })
                .catch((parseError: Error) => {
                  setBundle(null);
                  setError(parseError.message || 'Failed to parse migration bundle.');
                });
            }}
          />
          {fileName ? <span className="mt-1 block text-[11px] text-muted-foreground">{fileName}</span> : null}
        </label>

        <label className="block text-xs font-semibold text-muted-foreground">
          Bundle Passphrase{' '}
          <span className="font-normal text-muted-foreground">(optional — only if the file was passphrase-protected)</span>
          <input
            type="password"
            className="mt-1 block w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            placeholder="Leave blank if not passphrase-protected"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
          />
        </label>

        {error ? (
          <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-400">
            {error}
          </div>
        ) : null}

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => {
              reset();
              onClose();
            }}
            className="rounded-md border border-border px-3 py-2 text-xs font-semibold hover:bg-accent"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={isImporting || !bundle}
            onClick={() => {
              if (!bundle) {
                setError('Select a migration file first.');
                return;
              }
              setError(null);
              void onImport(bundle, passphrase.trim() || undefined)
                .then(() => {
                  reset();
                })
                .catch((importError: Error) => {
                  setError(importError.message || 'Import failed.');
                });
            }}
            className="rounded-md bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-50"
          >
            {isImporting ? 'Importing...' : 'Import Project'}
          </button>
        </div>
      </div>
    </div>
  );
}
