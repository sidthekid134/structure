/**
 * GuidedFlowContainer — the top-level orchestrator for a guided manual flow.
 *
 * Renders:
 *   - Flow header (title, progress bar, completion count)
 *   - Ordered list of ManualStepCard components
 *   - Completion state when all required steps are done
 *
 * Used for both Apple Signing and Google Play guided flows.
 */

import { useCallback } from 'react';
import { CheckCircle2, Loader2 } from 'lucide-react';
import type { GuidedFlowType, FileUpload } from '../../hooks/useGuidedFlow';
import { useGuidedFlow } from '../../hooks/useGuidedFlow';
import { ManualStepCard } from './ManualStepCard';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface GuidedFlowContainerProps {
  projectId: string;
  flowType: GuidedFlowType;
  existingFlowId?: string;
  onFlowComplete?: () => void;
}

// ---------------------------------------------------------------------------
// Flow metadata
// ---------------------------------------------------------------------------

const FLOW_LABELS: Record<GuidedFlowType, { title: string; description: string }> = {
  apple_signing: {
    title: 'Apple Signing Setup',
    description:
      'Set up Apple code signing for iOS app distribution. Follow the steps below in order.',
  },
  google_play: {
    title: 'Google Play Setup',
    description:
      'Configure Google Play publishing. This includes a required one-time manual AAB upload.',
  },
};

// ---------------------------------------------------------------------------
// Container
// ---------------------------------------------------------------------------

export function GuidedFlowContainer({
  projectId,
  flowType,
  existingFlowId,
  onFlowComplete,
}: GuidedFlowContainerProps) {
  const { flow, loading, error, initializeFlow, completeStep, refetchFlow } = useGuidedFlow(
    projectId,
    existingFlowId,
  );

  const label = FLOW_LABELS[flowType];

  const handleStart = useCallback(async () => {
    await initializeFlow(flowType);
  }, [initializeFlow, flowType]);

  const handleStepComplete = useCallback(
    async (stepId: string, metadata?: Record<string, unknown>): Promise<boolean> => {
      const success = await completeStep(stepId, metadata);
      if (success && flow) {
        const updatedFlow = flow;
        const allRequired = updatedFlow.steps.filter((s) => !s.is_optional);
        if (allRequired.every((s) => s.is_completed)) {
          onFlowComplete?.();
        }
      }
      return success;
    },
    [completeStep, flow, onFlowComplete],
  );

  const handleFileUploaded = useCallback(
    (_upload: FileUpload) => {
      refetchFlow();
    },
    [refetchFlow],
  );

  const progressPercent = flow
    ? Math.round((flow.completed_count / Math.max(flow.total_count, 1)) * 100)
    : 0;

  // -------------------------------------------
  // States
  // -------------------------------------------

  if (loading && !flow) {
    return (
      <div className="flex items-center justify-center py-12 text-gray-400">
        <Loader2 className="h-6 w-6 animate-spin" />
        <span className="ml-2 text-sm">Loading...</span>
      </div>
    );
  }

  if (!flow) {
    return (
      <div className="space-y-4 py-6 text-center">
        <div>
          <h2 className="text-base font-semibold text-gray-900">{label.title}</h2>
          <p className="mt-1 text-sm text-gray-500">{label.description}</p>
        </div>
        {error && (
          <p className="text-sm text-red-600">{error}</p>
        )}
        <button
          type="button"
          onClick={handleStart}
          className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-700"
        >
          Start setup
        </button>
      </div>
    );
  }

  if (flow.status === 'completed') {
    return (
      <div className="space-y-4 py-8 text-center">
        <CheckCircle2 className="mx-auto h-10 w-10 text-green-500" />
        <div>
          <h2 className="text-base font-semibold text-green-800">Setup complete!</h2>
          <p className="mt-1 text-sm text-gray-500">
            All {label.title.toLowerCase()} steps are done. Provisioning can now proceed.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div>
        <h2 className="text-base font-semibold text-gray-900">{label.title}</h2>
        <p className="mt-0.5 text-sm text-gray-500">{label.description}</p>
      </div>

      {/* Progress */}
      <div className="space-y-1">
        <div className="flex items-center justify-between text-xs text-gray-500">
          <span>{flow.completed_count} of {flow.total_count} steps completed</span>
          <span>{progressPercent}%</span>
        </div>
        <div className="h-2 w-full rounded-full bg-gray-100">
          <div
            className="h-2 rounded-full bg-blue-500 transition-all duration-500"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Steps */}
      <div className="space-y-3">
        {flow.steps.map((step, index) => (
          <ManualStepCard
            key={step.id}
            step={step}
            flowId={flow.id}
            projectId={projectId}
            stepIndex={index}
            onStepComplete={handleStepComplete}
            onFileUploaded={handleFileUploaded}
          />
        ))}
      </div>
    </div>
  );
}
