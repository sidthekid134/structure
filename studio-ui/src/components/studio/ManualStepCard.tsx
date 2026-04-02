/**
 * ManualStepCard — displays a single manual step in a guided flow.
 *
 * Features:
 *   - Step number, title, description
 *   - Numbered instruction list with warnings
 *   - Portal link (external)
 *   - File upload widget (if step requires a file)
 *   - Bottleneck explanation for blocking steps (e.g., Google Play AAB)
 *   - Visual states: not_started, in_progress, completed, blocked, skipped
 *   - "Mark as done" button for manual confirmation steps
 */

import { useCallback, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Info,
  Lock,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import type { ManualStep, FileUpload } from '../../hooks/useGuidedFlow';
import { StepInstructions } from './StepInstructions';
import { FileUploadWidget } from './FileUploadWidget';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ManualStepCardProps {
  step: ManualStep;
  flowId: string;
  projectId: string;
  stepIndex: number;
  onStepComplete: (stepId: string, metadata?: Record<string, unknown>) => Promise<boolean>;
  onFileUploaded?: (upload: FileUpload) => void;
}

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: ManualStep['status'] }) {
  const styles: Record<string, string> = {
    not_started: 'bg-gray-100 text-gray-600',
    in_progress: 'bg-blue-100 text-blue-700',
    completed: 'bg-green-100 text-green-700',
    skipped: 'bg-gray-100 text-gray-500',
    blocked: 'bg-red-100 text-red-700',
  };
  const labels: Record<string, string> = {
    not_started: 'Not started',
    in_progress: 'In progress',
    completed: 'Completed',
    skipped: 'Skipped',
    blocked: 'Blocked',
  };
  return (
    <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', styles[status] ?? styles['not_started'])}>
      {labels[status] ?? status}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

export function ManualStepCard({
  step,
  flowId,
  projectId,
  stepIndex,
  onStepComplete,
  onFileUploaded,
}: ManualStepCardProps) {
  const [expanded, setExpanded] = useState(!step.is_completed && step.status !== 'blocked');
  const [completing, setCompleting] = useState(false);
  const [uploadedFileId, setUploadedFileId] = useState<string | null>(
    step.uploads.find((u) => u.validation_status === 'valid')?.id ?? null,
  );

  const isBlocked = step.status === 'blocked';
  const isCompleted = step.is_completed;

  const handleComplete = useCallback(async () => {
    setCompleting(true);
    const metadata: Record<string, unknown> = {};
    if (uploadedFileId) metadata['upload_id'] = uploadedFileId;
    await onStepComplete(step.id, Object.keys(metadata).length > 0 ? metadata : undefined);
    setCompleting(false);
  }, [step.id, uploadedFileId, onStepComplete]);

  const handleFileUploaded = useCallback(
    (upload: FileUpload) => {
      setUploadedFileId(upload.id);
      onFileUploaded?.(upload);
    },
    [onFileUploaded],
  );

  return (
    <div
      className={cn(
        'rounded-xl border bg-white transition-all',
        isCompleted ? 'border-green-200 opacity-75' : 'border-gray-200',
        isBlocked && 'border-gray-100 bg-gray-50',
      )}
    >
      {/* Header */}
      <div
        className={cn(
          'flex cursor-pointer items-start gap-3 px-5 py-4',
          isBlocked && 'cursor-not-allowed',
        )}
        onClick={() => !isBlocked && setExpanded((v) => !v)}
        role="button"
        tabIndex={isBlocked ? -1 : 0}
        onKeyDown={(e) => e.key === 'Enter' && !isBlocked && setExpanded((v) => !v)}
      >
        {/* Step number / completion icon */}
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 border-gray-200 text-sm font-semibold text-gray-500">
          {isCompleted ? (
            <CheckCircle2 className="h-5 w-5 text-green-500" />
          ) : isBlocked ? (
            <Lock className="h-4 w-4 text-gray-300" />
          ) : (
            <span>{stepIndex + 1}</span>
          )}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className={cn('text-sm font-semibold', isBlocked ? 'text-gray-400' : 'text-gray-900')}>
              {step.title}
            </h3>
            <StatusBadge status={step.status} />
            {step.is_optional && (
              <span className="text-xs text-gray-400">(optional)</span>
            )}
          </div>
          {!expanded && (
            <p className="mt-0.5 text-xs text-gray-500 line-clamp-1">{step.description}</p>
          )}
          {isBlocked && step.blocked_reason && (
            <p className="mt-0.5 flex items-center gap-1 text-xs text-red-600">
              <Lock className="h-3 w-3" />
              {step.blocked_reason}
            </p>
          )}
        </div>

        {!isBlocked && (
          <div className="shrink-0 text-gray-400">
            {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </div>
        )}
      </div>

      {/* Expanded content */}
      {expanded && !isBlocked && (
        <div className="border-t border-gray-100 px-5 py-4 space-y-4">
          {step.description && (
            <p className="text-sm text-gray-600">{step.description}</p>
          )}

          {/* Portal link */}
          {step.portal_url && (
            <a
              href={step.portal_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md border border-blue-200 bg-blue-50 px-3 py-1.5 text-sm text-blue-700 hover:bg-blue-100"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Open in portal
            </a>
          )}

          {/* Bottleneck explanation */}
          {step.bottleneck_explanation && (
            <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-4 py-3">
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <div>
                <p className="text-xs font-semibold text-amber-800">Why this step is manual</p>
                <p className="mt-1 text-xs text-amber-700">{step.bottleneck_explanation}</p>
              </div>
            </div>
          )}

          {/* Instructions */}
          {step.instructions.length > 0 && (
            <StepInstructions instructions={step.instructions} />
          )}

          {/* File upload */}
          {step.file_upload_config && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-gray-700">Upload required file</p>
              <FileUploadWidget
                options={{
                  flowId,
                  stepId: step.id,
                  upload_type:
                    step.file_upload_config.validator === 'apple_p8'
                      ? 'apple_p8'
                      : step.file_upload_config.validator === 'google_play_service_account'
                        ? 'google_play_service_account'
                        : 'generic',
                  project_id: projectId,
                }}
                acceptedTypes={step.file_upload_config.accepted_types}
                maxSizeKb={step.file_upload_config.max_size_kb}
                onUploadComplete={handleFileUploaded}
              />
            </div>
          )}

          {/* Complete button */}
          {!isCompleted && (
            <div className="flex items-center justify-between pt-2">
              {step.file_upload_config && !uploadedFileId && (
                <p className="flex items-center gap-1 text-xs text-amber-600">
                  <AlertTriangle className="h-3 w-3" />
                  Upload the required file before completing this step.
                </p>
              )}
              <button
                type="button"
                onClick={handleComplete}
                disabled={completing || (!!step.file_upload_config && !uploadedFileId)}
                className={cn(
                  'ml-auto flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium text-white transition-colors',
                  completing || (step.file_upload_config && !uploadedFileId)
                    ? 'bg-gray-300 cursor-not-allowed'
                    : 'bg-blue-600 hover:bg-blue-700',
                )}
              >
                {completing ? (
                  'Saving...'
                ) : (
                  <>
                    <CheckCircle2 className="h-4 w-4" />
                    Mark as done
                  </>
                )}
              </button>
            </div>
          )}

          {isCompleted && (
            <div className="flex items-center gap-2 pt-2 text-sm text-green-600">
              <CheckCircle2 className="h-4 w-4" />
              Step completed
            </div>
          )}
        </div>
      )}
    </div>
  );
}
