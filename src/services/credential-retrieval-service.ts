/**
 * CredentialRetrievalService — retrieves validated credentials for use
 * in provisioning steps and guides orchestration through missing credential flows.
 *
 * This service is the bridge between:
 *   - CredentialService (storage)
 *   - GuidedFlowService (manual flows)
 *   - CredentialCollectionOrchestrator (missing credential analysis)
 *
 * Usage in provisioning:
 *   1. Call `validateCredentialsExist(projectId, stepType)` before step execution.
 *   2. If credentials are missing, returns `CollectionResult` with info to display
 *      the CredentialCollectionModal or a guided flow.
 *   3. After user submits, call `getCredentialForStep(projectId, stepType, credentialType)`
 *      to get the plaintext value (only when immediately needed for an API call).
 */

import type { CredentialService, CredentialType } from './credential-service.js';
import type { GuidedFlowService } from './guided-flow-service.js';
import { CredentialCollectionOrchestrator } from './credential-collection-orchestrator.js';
import type { CollectionResult } from './credential-collection-orchestrator.js';
import { OrchestrationError } from '../orchestration/error-handler.js';
import type { ProjectManager } from '../studio/project-manager.js';
import { projectPrimaryDomain } from '../studio/project-identity.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CredentialValidationResult {
  valid: boolean;
  collection_result?: CollectionResult;
}

// ---------------------------------------------------------------------------
// CredentialRetrievalService
// ---------------------------------------------------------------------------

export class CredentialRetrievalService {
  private readonly collectionOrchestrator: CredentialCollectionOrchestrator;

  constructor(
    private readonly credentialService: CredentialService,
    private readonly guidedFlowService: GuidedFlowService,
    private readonly projectManager: ProjectManager,
  ) {
    this.collectionOrchestrator = new CredentialCollectionOrchestrator(credentialService, projectManager);
  }

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  /**
   * Checks whether all required credentials for a step type exist.
   *
   * Returns `valid: true` when all credentials are present.
   * Returns `valid: false` with a `collection_result` describing what's missing.
   * Does NOT throw — callers decide how to handle missing credentials.
   */
  validateCredentialsExist(projectId: string, stepType: string): CredentialValidationResult {
    const collectionResult = this.collectionOrchestrator.collectMissingCredentials(
      projectId,
      stepType,
    );

    if (collectionResult.missing_types.length === 0) {
      return { valid: true };
    }

    return {
      valid: false,
      collection_result: collectionResult,
    };
  }

  /**
   * Checks credentials and throws OrchestrationError if any are missing.
   * Use in provisioning steps that should fail fast on missing credentials.
   */
  requireCredentialsForStep(projectId: string, stepType: string): void {
    this.collectionOrchestrator.checkMissingCredentialsForStep(projectId, stepType);
  }

  // ---------------------------------------------------------------------------
  // Retrieval
  // ---------------------------------------------------------------------------

  /**
   * Retrieves the plaintext value of a credential for use in an API call.
   * Returns null if the credential is not present.
   *
   * Only call this when you are immediately using the value (e.g., to call
   * an external API). Do not store the returned plaintext.
   */
  getCredentialForStep(
    projectId: string,
    _stepType: string,
    credentialType: CredentialType,
  ): string | null {
    if (credentialType === 'domain_name') {
      const stored = this.credentialService.retrieveCredential(projectId, 'domain_name');
      if (stored) return stored;
      try {
        const d = projectPrimaryDomain(this.projectManager.getProject(projectId).project);
        return d || null;
      } catch {
        return null;
      }
    }
    return this.credentialService.retrieveCredential(projectId, credentialType);
  }

  /**
   * Returns a map of all active credentials for a project.
   * Values are summaries only — no plaintext.
   */
  listProjectCredentials(projectId: string) {
    return this.credentialService.listCredentials(projectId);
  }

  /**
   * Returns the types of credentials already collected for a project.
   */
  getCollectedCredentialTypes(projectId: string): CredentialType[] {
    return this.credentialService
      .listCredentials(projectId)
      .map((c) => c.credential_type);
  }

  // ---------------------------------------------------------------------------
  // Guided flow integration
  // ---------------------------------------------------------------------------

  /**
   * Returns the current guided flow for a step type, if one exists.
   * Useful for linking a missing credential to a guided setup flow.
   */
  async getGuidedFlowForStep(
    projectId: string,
    stepType: string,
  ): Promise<{ flow_id: string; flow_type: string } | null> {
    const stepToFlowMap: Record<string, 'apple_signing' | 'google_play'> = {
      'apple:generate-apns-key': 'apple_signing',
      'apple:upload-apns-to-firebase': 'apple_signing',
      'apple:configure-signing': 'apple_signing',
      'google-play:configure-app': 'google_play',
    };

    const flowType = stepToFlowMap[stepType];
    if (!flowType) return null;

    try {
      const flow = await this.guidedFlowService.initializeFlow(flowType, projectId);
      return { flow_id: flow.id, flow_type: flow.flow_type };
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Missing credential analysis for provisioning gate
  // ---------------------------------------------------------------------------

  /**
   * Analyzes all steps in a provisioning plan and returns which ones
   * have missing credentials.
   *
   * Used by the API's prerequisite check endpoint to report which steps
   * are blocked before the run is kicked off.
   */
  analyzeMissingCredentialsForPlan(
    projectId: string,
    stepTypes: string[],
  ): Record<string, CollectionResult> {
    const results: Record<string, CollectionResult> = {};

    for (const stepType of stepTypes) {
      const result = this.collectionOrchestrator.collectMissingCredentials(projectId, stepType);
      if (result.missing_types.length > 0) {
        results[stepType] = result;
      }
    }

    return results;
  }
}
