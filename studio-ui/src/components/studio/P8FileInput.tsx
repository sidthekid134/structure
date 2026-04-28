/**
 * P8FileInput \u2014 drop-zone for Apple PEM-encoded `.p8` private keys.
 *
 * The file is read in-browser via `File.text()` and the resulting PEM string
 * is handed to the parent via `onChange`. Nothing is uploaded over the network
 * here; the parent persists the string through whatever endpoint it owns
 * (e.g. the provisioning step inputs PUT). When `value` is non-empty we render
 * a confirmation pill with a show/hide toggle and a Replace action.
 *
 * Shared with `apple:generate-apns-key` (provisioning step input) and any
 * future step that needs an in-browser PEM upload.
 */

import { useRef, useState } from 'react';
import { AlertCircle, Eye, EyeOff, FileCheck2, KeyRound, Trash2, Upload } from 'lucide-react';

const P8_BEGIN = '-----BEGIN PRIVATE KEY-----';
const P8_END = '-----END PRIVATE KEY-----';
const MAX_P8_BYTES = 10 * 1024;

/**
 * Apple downloads each Auth Key as `AuthKey_<10-char Key ID>.p8`. We rely on
 * that filename to derive the Key ID instead of asking the user to retype it
 * \u2014 the Key ID is part of the filename Apple chose, so any other source of
 * truth invites a typo. Keys are uppercase alphanumeric.
 */
const APPLE_AUTH_KEY_FILE_NAME_RE = /^AuthKey_([A-Z0-9]{10})\.p8$/i;

export function extractKeyIdFromP8FileName(name: string | undefined | null): string | null {
  if (!name) return null;
  const match = name.match(APPLE_AUTH_KEY_FILE_NAME_RE);
  return match ? match[1]!.toUpperCase() : null;
}

interface P8FileInputProps {
  value: string;
  onChange: (pem: string, fileName?: string) => void;
  fileName?: string;
  ariaLabel?: string;
  className?: string;
  /**
   * When true, the dropzone rejects any file whose name does not match the
   * `AuthKey_<10-char>.p8` pattern. Used by the Apple Auth Key steps so the
   * Key ID can be derived directly from the filename Apple set on download.
   */
  requireAppleAuthKeyFileName?: boolean;
}

export function P8FileInput({
  value,
  onChange,
  fileName,
  ariaLabel,
  className,
  requireAppleAuthKeyFileName,
}: P8FileInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const extractedKeyId = extractKeyIdFromP8FileName(fileName);

  const handleFile = async (file: File) => {
    setUploadError(null);
    if (file.size > MAX_P8_BYTES) {
      setUploadError(`.p8 files are tiny (~250 bytes). Refusing ${file.size}-byte upload.`);
      return;
    }
    if (requireAppleAuthKeyFileName && !extractKeyIdFromP8FileName(file.name)) {
      setUploadError(
        `Filename "${file.name}" does not match Apple's AuthKey_<KEYID>.p8 pattern. ` +
          'Use the original file Apple let you download \u2014 Studio derives the 10-character Key ID from the filename. ' +
          'If you renamed it, restore the original AuthKey_XXXXXXXXXX.p8 name.',
      );
      return;
    }
    let text = '';
    try {
      text = await file.text();
    } catch (err) {
      setUploadError(`Could not read file: ${(err as Error).message}`);
      return;
    }
    const trimmed = text.trim();
    if (!trimmed.startsWith(P8_BEGIN) || !trimmed.includes(P8_END)) {
      setUploadError(
        'File is not a PEM-encoded private key. Make sure you selected AuthKey_<KEYID>.p8 from your downloads.',
      );
      return;
    }
    onChange(trimmed, file.name);
  };

  const handleClear = () => {
    setReveal(false);
    setUploadError(null);
    onChange('');
    if (inputRef.current) inputRef.current.value = '';
  };

  if (value) {
    return (
      <div className={`space-y-2 ${className ?? ''}`}>
        <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-3 flex items-center gap-3">
          <FileCheck2 size={18} className="text-emerald-500 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-bold text-foreground truncate">{fileName ?? 'AuthKey.p8'}</p>
            <p className="text-[10px] text-muted-foreground">
              {value.length.toLocaleString()} characters \u00b7 validated PEM \u00b7 stored encrypted in project vault
            </p>
            {extractedKeyId && (
              <p className="text-[10px] mt-0.5 inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300 font-mono">
                <KeyRound size={10} className="opacity-80" />
                Key ID: {extractedKeyId}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={() => setReveal((v) => !v)}
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
          >
            {reveal ? <EyeOff size={12} /> : <Eye size={12} />}
            <span>{reveal ? 'Hide' : 'Show'}</span>
          </button>
          <button
            type="button"
            onClick={handleClear}
            className="inline-flex items-center gap-1 text-[11px] text-red-500 hover:text-red-400 transition-colors"
          >
            <Trash2 size={12} />
            <span>Replace</span>
          </button>
        </div>
        {reveal && (
          <pre className="max-h-40 overflow-auto rounded-lg border border-border bg-muted/40 p-3 text-[10px] font-mono leading-relaxed text-foreground whitespace-pre-wrap break-all">
            {value}
          </pre>
        )}
      </div>
    );
  }

  return (
    <div className={`space-y-2 ${className ?? ''}`}>
      <button
        type="button"
        aria-label={ariaLabel ?? 'Upload .p8 file'}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const file = e.dataTransfer.files?.[0];
          if (file) void handleFile(file);
        }}
        className={`w-full rounded-lg border-2 border-dashed px-4 py-6 text-left transition-colors ${
          dragOver
            ? 'border-primary bg-primary/5'
            : 'border-border hover:border-primary/40 hover:bg-muted/30'
        }`}
      >
        <div className="flex items-center gap-3">
          <Upload size={20} className="text-muted-foreground shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-bold text-foreground">Drop AuthKey_&lt;KEYID&gt;.p8 here</p>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              or click to browse \u00b7 file is read in-browser, vaulted on save
            </p>
          </div>
        </div>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".p8,application/x-pem-file,text/plain"
        className="sr-only"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handleFile(file);
        }}
      />
      {uploadError && (
        <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-600 dark:text-red-400">
          <AlertCircle size={12} className="shrink-0 mt-0.5" />
          <span>{uploadError}</span>
        </div>
      )}
    </div>
  );
}
