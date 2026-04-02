/**
 * FileUploadWidget — drag-and-drop file upload with validation feedback.
 *
 * Accepts a file (via drag-and-drop or click), uploads it to the guided flow
 * step endpoint, and displays real-time validation status.
 */

import { useCallback, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  FileText,
  Loader2,
  RefreshCw,
  Upload,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import type { FileUploadOptions, UploadState } from '../../hooks/useFileUpload';
import { useFileUpload } from '../../hooks/useFileUpload';
import type { FileUpload } from '../../hooks/useGuidedFlow';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface FileUploadWidgetProps {
  options: FileUploadOptions;
  acceptedTypes?: string[];
  maxSizeKb?: number;
  label?: string;
  onUploadComplete?: (upload: FileUpload) => void;
  className?: string;
}

// ---------------------------------------------------------------------------
// Status icon
// ---------------------------------------------------------------------------

function StatusIcon({ state }: { state: UploadState }) {
  switch (state) {
    case 'uploading':
    case 'validating':
      return <Loader2 className="h-5 w-5 animate-spin text-blue-500" />;
    case 'valid':
      return <CheckCircle2 className="h-5 w-5 text-green-500" />;
    case 'invalid':
      return <AlertCircle className="h-5 w-5 text-red-500" />;
    default:
      return <Upload className="h-5 w-5 text-gray-400" />;
  }
}

// ---------------------------------------------------------------------------
// Widget
// ---------------------------------------------------------------------------

export function FileUploadWidget({
  options,
  acceptedTypes,
  maxSizeKb = 10,
  label = 'Choose file or drag and drop',
  onUploadComplete,
  className,
}: FileUploadWidgetProps) {
  const { uploadState, uploadedFile, error, selectedFile, uploadFile, reset } =
    useFileUpload(options);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const handleFile = useCallback(
    async (file: File) => {
      if (maxSizeKb && file.size > maxSizeKb * 1024) {
        return;
      }
      const result = await uploadFile(file);
      if (result && result.validation_status === 'valid' && onUploadComplete) {
        onUploadComplete(result);
      }
    },
    [uploadFile, maxSizeKb, onUploadComplete],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    },
    [handleFile],
  );

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) handleFile(file);
    },
    [handleFile],
  );

  const isProcessing = uploadState === 'uploading' || uploadState === 'validating';

  return (
    <div className={cn('space-y-2', className)}>
      <div
        className={cn(
          'relative flex flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 py-8 transition-colors',
          dragging
            ? 'border-blue-400 bg-blue-50'
            : uploadState === 'valid'
              ? 'border-green-300 bg-green-50'
              : uploadState === 'invalid'
                ? 'border-red-300 bg-red-50'
                : 'border-gray-300 bg-gray-50 hover:border-gray-400 hover:bg-gray-100',
          isProcessing && 'pointer-events-none opacity-75',
        )}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onClick={() => !isProcessing && fileInputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && !isProcessing && fileInputRef.current?.click()}
      >
        <StatusIcon state={uploadState} />

        <div className="mt-2 text-center">
          {uploadState === 'idle' && (
            <>
              <p className="text-sm font-medium text-gray-700">{label}</p>
              {acceptedTypes && (
                <p className="mt-1 text-xs text-gray-400">
                  {acceptedTypes.join(', ')} • max {maxSizeKb}KB
                </p>
              )}
            </>
          )}
          {uploadState === 'uploading' && (
            <p className="text-sm text-blue-600">Uploading...</p>
          )}
          {uploadState === 'validating' && (
            <p className="text-sm text-blue-600">Validating file...</p>
          )}
          {uploadState === 'valid' && (
            <div>
              <p className="text-sm font-medium text-green-700">File validated</p>
              {selectedFile && (
                <div className="mt-1 flex items-center gap-1 text-xs text-gray-500">
                  <FileText className="h-3 w-3" />
                  {selectedFile.name}
                </div>
              )}
            </div>
          )}
          {uploadState === 'invalid' && (
            <p className="text-sm font-medium text-red-700">Validation failed</p>
          )}
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept={acceptedTypes?.join(',')}
          onChange={handleInputChange}
          className="hidden"
        />
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
          <p className="text-xs text-red-700">{error}</p>
        </div>
      )}

      {uploadedFile?.validation_error && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2">
          <p className="text-xs font-medium text-amber-800">Validation error:</p>
          <p className="mt-0.5 text-xs text-amber-700">{uploadedFile.validation_error}</p>
        </div>
      )}

      {(uploadState === 'invalid' || uploadState === 'valid') && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); reset(); }}
          className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-700"
        >
          <RefreshCw className="h-3 w-3" />
          {uploadState === 'valid' ? 'Replace file' : 'Try again'}
        </button>
      )}
    </div>
  );
}
