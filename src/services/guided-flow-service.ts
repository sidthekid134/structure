/**
 * GuidedFlowService — manages guided manual flows.
 *
 * Provides:
 *   - Flow initialization (creates steps from flow definitions)
 *   - Step completion tracking and dependency re-evaluation
 *   - File upload recording with validation status
 *   - Dependency-aware step blocking
 *
 * Storage: SQLite via the same storeDir pattern as other services.
 */

import * as crypto from 'crypto';
import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { encrypt, decrypt } from '../encryption.js';
import type {
  GuidedFlow,
  GuidedFlowWithSteps,
  GuidedFlowType,
  GuidedFlowStatus,
  ManualStep,
  ManualStepWithUploads,
  ManualStepStatus,
  FileUpload,
  FileUploadStatus,
  StepInstruction,
  FileUploadConfig,
} from '../models/guided-flow.js';
import { GuidedFlowError } from '../models/guided-flow.js';
import type { FlowDefinition, StepDefinition } from '../flows/flow-definition-types.js';
import { APPLE_SIGNING_FLOW } from '../flows/apple-signing.flow.js';
import { GOOGLE_PLAY_FLOW } from '../flows/google-play.flow.js';

// ---------------------------------------------------------------------------
// GuidedFlowService
// ---------------------------------------------------------------------------

export class GuidedFlowService {
  private readonly db: Database.Database;
  private readonly deriveRowSecretKey: (purpose: string) => Buffer;

  constructor(storeDir: string, deriveRowSecretKey: (purpose: string) => Buffer) {
    fs.mkdirSync(storeDir, { recursive: true, mode: 0o700 });
    const dbPath = path.join(storeDir, 'guided-flows.db');
    this.db = new Database(dbPath);
    try { fs.chmodSync(dbPath, 0o600); } catch { /* best-effort */ }
    this.deriveRowSecretKey = deriveRowSecretKey;
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.initSchema();
  }

  // ---------------------------------------------------------------------------
  // Schema
  // ---------------------------------------------------------------------------

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS guided_flows (
        id         TEXT PRIMARY KEY,
        flow_type  TEXT NOT NULL,
        project_id TEXT NOT NULL,
        status     TEXT NOT NULL DEFAULT 'in_progress',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_guided_flows_project
        ON guided_flows(project_id, flow_type);

      CREATE TABLE IF NOT EXISTS manual_steps (
        id                    TEXT PRIMARY KEY,
        guided_flow_id        TEXT NOT NULL
          REFERENCES guided_flows(id) ON DELETE CASCADE,
        step_number           INTEGER NOT NULL,
        step_key              TEXT NOT NULL,
        title                 TEXT NOT NULL,
        description           TEXT NOT NULL DEFAULT '',
        instructions_json     TEXT NOT NULL DEFAULT '[]',
        portal_url            TEXT,
        is_optional           INTEGER NOT NULL DEFAULT 0,
        is_completed          INTEGER NOT NULL DEFAULT 0,
        status                TEXT NOT NULL DEFAULT 'not_started',
        blocked_reason        TEXT,
        file_upload_config_json TEXT,
        bottleneck_explanation TEXT,
        created_at            INTEGER NOT NULL,
        updated_at            INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_manual_steps_flow
        ON manual_steps(guided_flow_id, step_number);

      CREATE TABLE IF NOT EXISTS file_uploads (
        id                  TEXT PRIMARY KEY,
        manual_step_id      TEXT NOT NULL
          REFERENCES manual_steps(id) ON DELETE CASCADE,
        file_name           TEXT NOT NULL,
        file_type           TEXT NOT NULL,
        file_hash           TEXT NOT NULL,
        validation_status   TEXT NOT NULL DEFAULT 'pending',
        validation_error    TEXT,
        encrypted_file_data TEXT NOT NULL,
        uploaded_at         INTEGER NOT NULL,
        created_at          INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_file_uploads_step
        ON file_uploads(manual_step_id);

      CREATE TABLE IF NOT EXISTS step_dependencies (
        id                   TEXT PRIMARY KEY,
        dependent_step_id    TEXT NOT NULL,
        prerequisite_step_id TEXT NOT NULL,
        prerequisite_flow_id TEXT,
        blocking_behavior    TEXT NOT NULL DEFAULT 'block_step',
        created_at           INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_step_deps_dependent
        ON step_dependencies(dependent_step_id);
    `);
  }

  // ---------------------------------------------------------------------------
  // Flow CRUD
  // ---------------------------------------------------------------------------

  async initializeFlow(flowType: GuidedFlowType, projectId: string): Promise<GuidedFlowWithSteps> {
    const existing = this.getFlowByTypeAndProject(flowType, projectId);
    if (existing) {
      return this.getFlowWithSteps(existing.id);
    }

    const id = crypto.randomUUID();
    const now = Date.now();

    this.db.prepare(`
      INSERT INTO guided_flows (id, flow_type, project_id, status, metadata_json, created_at, updated_at)
      VALUES (?, ?, ?, 'in_progress', '{}', ?, ?)
    `).run(id, flowType, projectId, now, now);

    const definition = this.getFlowDefinition(flowType);
    this.initializeSteps(id, definition.steps);

    return this.getFlowWithSteps(id);
  }

  getFlowWithSteps(flowId: string): GuidedFlowWithSteps {
    const flow = this.getFlow(flowId);
    if (!flow) {
      throw new GuidedFlowError(`Guided flow "${flowId}" not found.`, 'FLOW_NOT_FOUND');
    }

    const steps = this.getStepsForFlow(flowId);
    const stepsWithUploads = steps.map((step) => ({
      ...step,
      uploads: this.getUploadsForStep(step.id),
    }));

    const completedCount = steps.filter((s) => s.is_completed).length;

    return {
      ...flow,
      steps: stepsWithUploads,
      completed_count: completedCount,
      total_count: steps.length,
    };
  }

  async completeStep(
    stepId: string,
    metadata?: Record<string, unknown>,
  ): Promise<GuidedFlowWithSteps> {
    const step = this.getStep(stepId);
    if (!step) {
      throw new GuidedFlowError(`Step "${stepId}" not found.`, 'STEP_NOT_FOUND');
    }

    if (step.status === 'blocked') {
      throw new GuidedFlowError(
        `Step "${step.title}" is blocked: ${step.blocked_reason ?? 'prerequisite steps not completed'}.`,
        'STEP_BLOCKED',
        { step_id: stepId, blocked_reason: step.blocked_reason },
      );
    }

    const now = Date.now();
    this.db.prepare(`
      UPDATE manual_steps
         SET is_completed = 1, status = 'completed', updated_at = ?
       WHERE id = ?
    `).run(now, stepId);

    if (metadata) {
      const flow = this.getFlow(step.guided_flow_id)!;
      const existingMeta = flow.metadata;
      this.db.prepare(`
        UPDATE guided_flows SET metadata_json = ?, updated_at = ? WHERE id = ?
      `).run(JSON.stringify({ ...existingMeta, ...metadata }), now, step.guided_flow_id);
    }

    this.evaluateDependencies(step.guided_flow_id);

    const flow = this.getFlowWithSteps(step.guided_flow_id);

    const allRequired = flow.steps.filter((s) => !s.is_optional);
    if (allRequired.every((s) => s.is_completed)) {
      this.db.prepare(`UPDATE guided_flows SET status = 'completed', updated_at = ? WHERE id = ?`)
        .run(now, step.guided_flow_id);
    }

    return this.getFlowWithSteps(step.guided_flow_id);
  }

  // ---------------------------------------------------------------------------
  // File uploads
  // ---------------------------------------------------------------------------

  async recordFileUpload(
    stepId: string,
    fileName: string,
    fileType: string,
    fileBuffer: Buffer,
    validationStatus: FileUploadStatus = 'pending',
    validationError?: string,
  ): Promise<FileUpload> {
    const step = this.getStep(stepId);
    if (!step) {
      throw new GuidedFlowError(`Step "${stepId}" not found.`, 'STEP_NOT_FOUND');
    }

    const id = crypto.randomUUID();
    const now = Date.now();
    const fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    const key = this.deriveRowSecretKey(`file_upload:${id}`);
    const encryptedData = encrypt(fileBuffer.toString('base64'), key);

    this.db.prepare(`
      INSERT INTO file_uploads
        (id, manual_step_id, file_name, file_type, file_hash, validation_status, validation_error, encrypted_file_data, uploaded_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, stepId, fileName, fileType, fileHash, validationStatus, validationError ?? null, encryptedData, now, now);

    if (validationStatus === 'valid') {
      this.db.prepare(`UPDATE manual_steps SET updated_at = ? WHERE id = ?`).run(now, stepId);
    }

    return this.getUpload(id)!;
  }

  getUpload(uploadId: string): FileUpload | null {
    const row = this.db
      .prepare('SELECT * FROM file_uploads WHERE id = ?')
      .get(uploadId) as RawUpload | undefined;
    return row ? this.mapUpload(row) : null;
  }

  decryptUploadedFile(uploadId: string): Buffer | null {
    const row = this.db
      .prepare('SELECT encrypted_file_data FROM file_uploads WHERE id = ?')
      .get(uploadId) as { encrypted_file_data: string } | undefined;
    if (!row) return null;
    try {
      const key = this.deriveRowSecretKey(`file_upload:${uploadId}`);
      const base64 = decrypt(row.encrypted_file_data, key);
      return Buffer.from(base64, 'base64');
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Dependency evaluation
  // ---------------------------------------------------------------------------

  private evaluateDependencies(flowId: string): void {
    const steps = this.getStepsForFlow(flowId);
    const completedIds = new Set(steps.filter((s) => s.is_completed).map((s) => s.id));
    const now = Date.now();

    for (const step of steps) {
      if (step.is_completed) continue;
      const deps = this.db
        .prepare('SELECT * FROM step_dependencies WHERE dependent_step_id = ?')
        .all(step.id) as Array<{ prerequisite_step_id: string; blocking_behavior: string }>;

      if (deps.length === 0) {
        if (step.status === 'blocked') {
          this.db.prepare(`UPDATE manual_steps SET status = 'not_started', blocked_reason = NULL, updated_at = ? WHERE id = ?`).run(now, step.id);
        }
        continue;
      }

      const unmetDeps = deps.filter((d) => !completedIds.has(d.prerequisite_step_id));
      if (unmetDeps.length > 0) {
        const prereqStep = steps.find((s) => s.id === unmetDeps[0]!.prerequisite_step_id);
        this.db.prepare(`
          UPDATE manual_steps SET status = 'blocked', blocked_reason = ?, updated_at = ? WHERE id = ?
        `).run(
          `Complete "${prereqStep?.title ?? 'prerequisite step'}" first.`,
          now,
          step.id,
        );
      } else if (step.status === 'blocked') {
        this.db.prepare(`UPDATE manual_steps SET status = 'not_started', blocked_reason = NULL, updated_at = ? WHERE id = ?`).run(now, step.id);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private getFlow(flowId: string): GuidedFlow | null {
    const row = this.db
      .prepare('SELECT * FROM guided_flows WHERE id = ?')
      .get(flowId) as RawFlow | undefined;
    return row ? this.mapFlow(row) : null;
  }

  private getFlowByTypeAndProject(
    flowType: GuidedFlowType,
    projectId: string,
  ): GuidedFlow | null {
    const row = this.db
      .prepare('SELECT * FROM guided_flows WHERE flow_type = ? AND project_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(flowType, projectId) as RawFlow | undefined;
    return row ? this.mapFlow(row) : null;
  }

  private getStep(stepId: string): ManualStep | null {
    const row = this.db
      .prepare('SELECT * FROM manual_steps WHERE id = ?')
      .get(stepId) as RawStep | undefined;
    return row ? this.mapStep(row) : null;
  }

  private getStepsForFlow(flowId: string): ManualStep[] {
    const rows = this.db
      .prepare('SELECT * FROM manual_steps WHERE guided_flow_id = ? ORDER BY step_number ASC')
      .all(flowId) as RawStep[];
    return rows.map((r) => this.mapStep(r));
  }

  private getUploadsForStep(stepId: string): FileUpload[] {
    const rows = this.db
      .prepare('SELECT * FROM file_uploads WHERE manual_step_id = ? ORDER BY created_at DESC')
      .all(stepId) as RawUpload[];
    return rows.map((r) => this.mapUpload(r));
  }

  private initializeSteps(flowId: string, stepDefs: StepDefinition[]): void {
    const now = Date.now();
    for (const def of stepDefs) {
      const stepId = crypto.randomUUID();
      this.db.prepare(`
        INSERT INTO manual_steps
          (id, guided_flow_id, step_number, step_key, title, description,
           instructions_json, portal_url, is_optional, is_completed, status,
           file_upload_config_json, bottleneck_explanation, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
      `).run(
        stepId,
        flowId,
        def.step_number,
        def.step_key,
        def.title,
        def.description,
        JSON.stringify(def.instructions),
        def.portal_url ?? null,
        def.is_optional ? 1 : 0,
        def.dependencies && def.dependencies.length > 0 ? 'blocked' : 'not_started',
        def.file_upload_config ? JSON.stringify(def.file_upload_config) : null,
        def.bottleneck_explanation ?? null,
        now,
        now,
      );
    }

    const allSteps = this.db
      .prepare('SELECT id, step_key FROM manual_steps WHERE guided_flow_id = ?')
      .all(flowId) as Array<{ id: string; step_key: string }>;
    const stepIdByKey = Object.fromEntries(allSteps.map((s) => [s.step_key, s.id]));

    for (const def of stepDefs) {
      if (!def.dependencies || def.dependencies.length === 0) continue;
      const dependentId = stepIdByKey[def.step_key];
      if (!dependentId) continue;
      for (const prereqKey of def.dependencies) {
        const prereqId = stepIdByKey[prereqKey];
        if (!prereqId) continue;
        this.db.prepare(`
          INSERT INTO step_dependencies
            (id, dependent_step_id, prerequisite_step_id, blocking_behavior, created_at)
          VALUES (?, ?, ?, 'block_step', ?)
        `).run(crypto.randomUUID(), dependentId, prereqId, Date.now());
      }
    }

    this.evaluateDependencies(flowId);
  }

  private getFlowDefinition(flowType: GuidedFlowType): FlowDefinition {
    switch (flowType) {
      case 'apple_signing':
        return APPLE_SIGNING_FLOW;
      case 'google_play':
        return GOOGLE_PLAY_FLOW;
      default:
        throw new GuidedFlowError(`Unknown flow type: "${flowType}".`, 'UNKNOWN_FLOW_TYPE');
    }
  }

  // ---------------------------------------------------------------------------
  // Row mappers
  // ---------------------------------------------------------------------------

  private mapFlow(row: RawFlow): GuidedFlow {
    return {
      id: row.id,
      flow_type: row.flow_type as GuidedFlowType,
      project_id: row.project_id,
      status: row.status as GuidedFlowStatus,
      metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private mapStep(row: RawStep): ManualStep {
    return {
      id: row.id,
      guided_flow_id: row.guided_flow_id,
      step_number: row.step_number,
      step_key: row.step_key,
      title: row.title,
      description: row.description,
      instructions: JSON.parse(row.instructions_json) as StepInstruction[],
      portal_url: row.portal_url ?? undefined,
      is_optional: row.is_optional === 1,
      is_completed: row.is_completed === 1,
      status: row.status as ManualStepStatus,
      blocked_reason: row.blocked_reason ?? undefined,
      file_upload_config: row.file_upload_config_json
        ? JSON.parse(row.file_upload_config_json) as FileUploadConfig
        : undefined,
      bottleneck_explanation: row.bottleneck_explanation ?? undefined,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private mapUpload(row: RawUpload): FileUpload {
    return {
      id: row.id,
      manual_step_id: row.manual_step_id,
      file_name: row.file_name,
      file_type: row.file_type,
      file_hash: row.file_hash,
      validation_status: row.validation_status as FileUploadStatus,
      validation_error: row.validation_error ?? undefined,
      encrypted_file_path: row.encrypted_file_data,
      uploaded_at: row.uploaded_at,
      created_at: row.created_at,
    };
  }

  close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Raw DB row types
// ---------------------------------------------------------------------------

interface RawFlow {
  id: string;
  flow_type: string;
  project_id: string;
  status: string;
  metadata_json: string;
  created_at: number;
  updated_at: number;
}

interface RawStep {
  id: string;
  guided_flow_id: string;
  step_number: number;
  step_key: string;
  title: string;
  description: string;
  instructions_json: string;
  portal_url: string | null;
  is_optional: number;
  is_completed: number;
  status: string;
  blocked_reason: string | null;
  file_upload_config_json: string | null;
  bottleneck_explanation: string | null;
  created_at: number;
  updated_at: number;
}

interface RawUpload {
  id: string;
  manual_step_id: string;
  file_name: string;
  file_type: string;
  file_hash: string;
  validation_status: string;
  validation_error: string | null;
  encrypted_file_data: string;
  uploaded_at: number;
  created_at: number;
}
