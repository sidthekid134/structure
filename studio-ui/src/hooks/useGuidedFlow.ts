/**
 * useGuidedFlow — manages guided flow state for a project.
 *
 * Handles flow initialization, step completion, and real-time state updates.
 */

import { useCallback, useEffect, useState } from 'react';
import { api } from '../components/studio/helpers';

// ---------------------------------------------------------------------------
// Types (mirroring backend models)
// ---------------------------------------------------------------------------

export type GuidedFlowType = 'apple_signing' | 'google_play';
export type GuidedFlowStatus = 'in_progress' | 'completed' | 'blocked';
export type ManualStepStatus = 'not_started' | 'in_progress' | 'completed' | 'skipped' | 'blocked';
export type FileUploadStatus = 'pending' | 'valid' | 'invalid';

export interface StepInstruction {
  number: number;
  text: string;
  url?: string;
  warning?: string;
}

export interface FileUploadConfig {
  accepted_types: string[];
  max_size_kb: number;
  validator: string;
}

export interface FileUpload {
  id: string;
  manual_step_id: string;
  file_name: string;
  file_type: string;
  file_hash: string;
  validation_status: FileUploadStatus;
  validation_error?: string;
  uploaded_at: number;
  created_at: number;
}

export interface ManualStep {
  id: string;
  guided_flow_id: string;
  step_number: number;
  step_key: string;
  title: string;
  description: string;
  instructions: StepInstruction[];
  portal_url?: string;
  is_optional: boolean;
  is_completed: boolean;
  status: ManualStepStatus;
  blocked_reason?: string;
  file_upload_config?: FileUploadConfig;
  bottleneck_explanation?: string;
  uploads: FileUpload[];
  created_at: number;
  updated_at: number;
}

export interface GuidedFlowWithSteps {
  id: string;
  flow_type: GuidedFlowType;
  project_id: string;
  status: GuidedFlowStatus;
  metadata: Record<string, unknown>;
  steps: ManualStep[];
  completed_count: number;
  total_count: number;
  created_at: number;
  updated_at: number;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useGuidedFlow(projectId: string, flowId?: string) {
  const [flow, setFlow] = useState<GuidedFlowWithSteps | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchFlow = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<GuidedFlowWithSteps>(`/projects/${projectId}/guided-flows/${id}`);
      setFlow(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (flowId) {
      fetchFlow(flowId);
    }
  }, [flowId, fetchFlow]);

  const initializeFlow = useCallback(
    async (flowType: GuidedFlowType): Promise<GuidedFlowWithSteps | null> => {
      setLoading(true);
      setError(null);
      try {
        const data = await api<GuidedFlowWithSteps>(
          `/projects/${projectId}/guided-flows`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ flow_type: flowType }),
          },
        );
        setFlow(data);
        return data;
      } catch (err) {
        setError((err as Error).message);
        return null;
      } finally {
        setLoading(false);
      }
    },
    [projectId],
  );

  const completeStep = useCallback(
    async (stepId: string, metadata?: Record<string, unknown>): Promise<boolean> => {
      setError(null);
      try {
        const updated = await api<GuidedFlowWithSteps>(
          `/guided-flows/${flow?.id}/steps/${stepId}/complete`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ metadata }),
          },
        );
        setFlow(updated);
        return true;
      } catch (err) {
        setError((err as Error).message);
        return false;
      }
    },
    [flow?.id],
  );

  const refetchFlow = useCallback(() => {
    if (flow?.id) fetchFlow(flow.id);
  }, [flow?.id, fetchFlow]);

  const clearError = useCallback(() => setError(null), []);

  return {
    flow,
    loading,
    error,
    initializeFlow,
    completeStep,
    refetchFlow,
    clearError,
  };
}
