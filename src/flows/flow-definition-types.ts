/**
 * Shared types for flow definition files.
 * Flow definitions are static data objects describing the steps in a guided flow.
 */

import type { GuidedFlowType, StepInstruction, FileUploadConfig } from '../models/guided-flow.js';

export interface StepDefinition {
  step_number: number;
  step_key: string;
  title: string;
  description: string;
  instructions: StepInstruction[];
  portal_url?: string;
  is_optional: boolean;
  file_upload_config?: FileUploadConfig;
  bottleneck_explanation?: string;
  /** step_key values that must be completed before this step unlocks */
  dependencies?: string[];
}

export interface FlowDefinition {
  flow_type: GuidedFlowType;
  /**
   * Optional: provisioning step key(s) this flow is associated with.
   * Used by the plugin registry to look up flows by step key.
   * When omitted, the plugin registry falls back to flow_type-based lookup.
   */
  stepKeys?: string[];
  label: string;
  description: string;
  steps: StepDefinition[];
}
