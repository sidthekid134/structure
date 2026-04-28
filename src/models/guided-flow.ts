/**
 * TypeScript models for the Guided Manual Flow system.
 *
 * Guided flows provide rich, step-by-step instructions for manual processes
 * that cannot be fully automated (e.g., Apple signing setup, Google Play
 * initial upload). Each flow contains ordered steps; steps can block or
 * require completion of prerequisite steps.
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export type GuidedFlowType = 'apple_signing' | 'google_play';
export type GuidedFlowStatus = 'in_progress' | 'completed' | 'blocked';
export type ManualStepStatus = 'not_started' | 'in_progress' | 'completed' | 'skipped' | 'blocked';
export type FileUploadStatus = 'pending' | 'valid' | 'invalid';
export type StepBlockingBehavior = 'block_step' | 'block_flow';

// ---------------------------------------------------------------------------
// Guided Flow
// ---------------------------------------------------------------------------

export interface GuidedFlow {
  id: string;
  flow_type: GuidedFlowType;
  project_id: string;
  status: GuidedFlowStatus;
  /** Flow-specific state (e.g., collected team_id, bundle_id) */
  metadata: Record<string, unknown>;
  created_at: number;
  updated_at: number;
}

export interface GuidedFlowWithSteps extends GuidedFlow {
  steps: ManualStepWithUploads[];
  completed_count: number;
  total_count: number;
}

// ---------------------------------------------------------------------------
// Manual Step
// ---------------------------------------------------------------------------

export interface StepInstruction {
  number: number;
  text: string;
  url?: string;
  warning?: string;
}

export interface FileUploadConfig {
  accepted_types: string[];
  max_size_kb: number;
  validator: 'apple_p8' | 'google_play_aab' | 'google_play_service_account';
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
  created_at: number;
  updated_at: number;
}

export interface ManualStepWithUploads extends ManualStep {
  uploads: FileUpload[];
}

// ---------------------------------------------------------------------------
// File Upload
// ---------------------------------------------------------------------------

export interface FileUpload {
  id: string;
  manual_step_id: string;
  file_name: string;
  file_type: string;
  file_hash: string;
  validation_status: FileUploadStatus;
  validation_error?: string;
  encrypted_file_path: string;
  uploaded_at: number;
  created_at: number;
}

// ---------------------------------------------------------------------------
// Step Dependency
// ---------------------------------------------------------------------------

export interface StepDependency {
  id: string;
  dependent_step_id: string;
  prerequisite_step_id: string;
  prerequisite_flow_id?: string;
  blocking_behavior: StepBlockingBehavior;
  created_at: number;
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class GuidedFlowError extends Error {
  public readonly code: string;
  public readonly context: Record<string, unknown>;

  constructor(
    message: string,
    code: string,
    context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'GuidedFlowError';
    this.code = code;
    this.context = context;
  }
}
