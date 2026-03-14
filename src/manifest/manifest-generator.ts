import { join } from 'path';
import { OperationLock } from '../credentials/operation-lock';
import { LiveResource, Manifest, ManifestResource, ProviderCredentials } from '../types/manifest';
import { AppleAdapter } from './adapters/apple-adapter';
import { FirebaseAdapter } from './adapters/firebase-adapter';
import { GitHubAdapter } from './adapters/github-adapter';
import { DriftDetector } from './drift-detector';
import { DriftReporter } from './drift-reporter';
import { computeHash } from './hash-calculator';
import { IdempotencyChecker } from './idempotency-checker';
import {
  createEmptyManifest,
  loadManifest,
  MANIFEST_VERSION,
  mergeResources,
  saveManifest,
} from './manifest-storage';

export const DRIFT_REPORT_FILENAME = 'platform.drift-report.json';

export class ManifestGenerator {
  private readonly lock: OperationLock;
  private readonly idempotencyChecker: IdempotencyChecker;

  constructor(private readonly locksDir?: string) {
    this.lock = new OperationLock(locksDir);
    this.idempotencyChecker = new IdempotencyChecker();
  }

  async generateManifest(projectId: string, projectRoot: string, credentials: ProviderCredentials): Promise<Manifest> {
    await this.lock.acquire(projectId);
    try {
      return await this.doGenerateManifest(projectId, projectRoot, credentials);
    } finally {
      this.lock.release(projectId);
    }
  }

  private async doGenerateManifest(
    projectId: string,
    projectRoot: string,
    credentials: ProviderCredentials,
  ): Promise<Manifest> {
    const existingManifest = loadManifest(projectRoot);
    const allLiveResources: LiveResource[] = [];

    // Query Firebase
    if (credentials.firebase) {
      const adapter = new FirebaseAdapter();
      await adapter.authenticate({
        project_id: credentials.firebase.projectId,
        service_account_key: credentials.firebase.serviceAccountKey,
      });
      const resources = await adapter.listResources();
      allLiveResources.push(...resources);
    }

    // Query Apple
    if (credentials.apple) {
      const adapter = new AppleAdapter();
      await adapter.authenticate({
        key_id: credentials.apple.keyId,
        team_id: credentials.apple.teamId,
        private_key: credentials.apple.privateKey,
      });
      const resources = await adapter.listResources();
      allLiveResources.push(...resources);
    }

    // Query GitHub
    if (credentials.github) {
      const adapter = new GitHubAdapter();
      await adapter.authenticate({ token: credentials.github.token });
      const resources = await adapter.listResources();
      allLiveResources.push(...resources);
    }

    const now = Date.now();
    const freshResources: ManifestResource[] = allLiveResources.map((live) => {
      const hash = computeHash(live.configuration);
      const existingResource = existingManifest?.resources.find(
        (r) => r.provider === live.provider && r.resourceId === live.resourceId,
      );

      // Idempotency: if hash matches, preserve the existing lastVerified timestamp
      if (existingResource && this.idempotencyChecker.isUnchanged(existingResource, hash)) {
        console.log(
          `[idempotency] ${live.provider}/${live.resourceType}/${live.resourceId} unchanged, updating lastVerified`,
        );
        return { ...existingResource, lastVerified: now };
      }

      return {
        provider: live.provider,
        resourceType: live.resourceType,
        resourceId: live.resourceId,
        configHash: hash,
        lastVerified: now,
        configuration: live.configuration,
      };
    });

    const mergedResources = existingManifest
      ? mergeResources(existingManifest.resources, freshResources)
      : freshResources;

    const manifest: Manifest = {
      projectId,
      generatedAt: now,
      version: MANIFEST_VERSION,
      resources: mergedResources,
    };

    saveManifest(projectRoot, manifest);
    return manifest;
  }

  async reportDrift(projectId: string, projectRoot: string, credentials: ProviderCredentials): Promise<void> {
    const manifest = loadManifest(projectRoot);
    if (!manifest) {
      throw new Error(`No manifest found at ${projectRoot}. Run generateManifest first.`);
    }

    // Gather fresh live state
    const allLiveResources: LiveResource[] = [];

    if (credentials.firebase) {
      const adapter = new FirebaseAdapter();
      await adapter.authenticate({
        project_id: credentials.firebase.projectId,
        service_account_key: credentials.firebase.serviceAccountKey,
      });
      allLiveResources.push(...(await adapter.listResources()));
    }

    if (credentials.apple) {
      const adapter = new AppleAdapter();
      await adapter.authenticate({
        key_id: credentials.apple.keyId,
        team_id: credentials.apple.teamId,
        private_key: credentials.apple.privateKey,
      });
      allLiveResources.push(...(await adapter.listResources()));
    }

    if (credentials.github) {
      const adapter = new GitHubAdapter();
      await adapter.authenticate({ token: credentials.github.token });
      allLiveResources.push(...(await adapter.listResources()));
    }

    const detector = new DriftDetector();
    const reporter = new DriftReporter();

    const findings = detector.detectDrift(manifest, allLiveResources);
    const report = reporter.generateReport(projectId, manifest.version, findings);

    // Write drift report
    const { writeFileSync } = await import('fs');
    const reportPath = join(projectRoot, DRIFT_REPORT_FILENAME);
    writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o644 });

    // Update manifest with lastDriftCheck timestamp
    manifest.lastDriftCheck = Date.now();
    saveManifest(projectRoot, manifest);

    console.log(reporter.formatSummary(report));
  }
}
