import { DriftFinding } from '../types/manifest';
import { DriftReporter } from './drift-reporter';

const makeFinding = (overrides: Partial<DriftFinding>): DriftFinding => ({
  driftType: 'config_change',
  resourceId: 'res-1',
  provider: 'firebase',
  resourceType: 'app',
  oldHash: 'a'.repeat(64),
  newHash: 'b'.repeat(64),
  detectedAt: Date.now(),
  ...overrides,
});

describe('DriftReporter', () => {
  const reporter = new DriftReporter();

  describe('generateReport', () => {
    it('creates report with correct structure', () => {
      const findings = [makeFinding({})];
      const report = reporter.generateReport('my-project', '1.0', findings);
      expect(report.projectId).toBe('my-project');
      expect(report.manifestVersion).toBe('1.0');
      expect(report.findings).toEqual(findings);
      expect(typeof report.generatedAt).toBe('number');
    });

    it('summarizes counts correctly', () => {
      const findings = [
        makeFinding({ driftType: 'config_change' }),
        makeFinding({ driftType: 'config_change', resourceId: 'res-2' }),
        makeFinding({ driftType: 'resource_deleted', resourceId: 'res-3' }),
        makeFinding({ driftType: 'resource_added', resourceId: 'res-4', provider: 'github' }),
      ];
      const report = reporter.generateReport('proj', '1.0', findings);
      expect(report.summary.configChanges).toBe(2);
      expect(report.summary.deletions).toBe(1);
      expect(report.summary.additions).toBe(1);
      expect(report.summary.total).toBe(4);
    });

    it('handles empty findings', () => {
      const report = reporter.generateReport('proj', '1.0', []);
      expect(report.summary.total).toBe(0);
      expect(report.findings).toHaveLength(0);
    });
  });

  describe('formatSummary', () => {
    it('returns no-drift message when no findings', () => {
      const report = reporter.generateReport('proj', '1.0', []);
      const summary = reporter.formatSummary(report);
      expect(summary).toContain('No drift detected');
    });

    it('includes provider name and counts', () => {
      const findings = [
        makeFinding({ driftType: 'config_change', provider: 'firebase' }),
        makeFinding({ driftType: 'resource_deleted', provider: 'firebase', resourceId: 'res-2' }),
      ];
      const report = reporter.generateReport('proj', '1.0', findings);
      const summary = reporter.formatSummary(report);
      expect(summary).toContain('firebase');
      expect(summary).toContain('config change');
      expect(summary).toContain('deleted');
    });

    it('groups findings by provider', () => {
      const findings = [
        makeFinding({ provider: 'firebase' }),
        makeFinding({ provider: 'github', resourceId: 'repo-1' }),
      ];
      const report = reporter.generateReport('proj', '1.0', findings);
      const summary = reporter.formatSummary(report);
      expect(summary).toContain('firebase');
      expect(summary).toContain('github');
    });

    it('includes total counts in output', () => {
      const findings = [
        makeFinding({ driftType: 'config_change' }),
        makeFinding({ driftType: 'resource_deleted', resourceId: 'r2' }),
        makeFinding({ driftType: 'resource_added', resourceId: 'r3' }),
      ];
      const report = reporter.generateReport('proj', '1.0', findings);
      const summary = reporter.formatSummary(report);
      expect(summary).toContain('Total');
    });
  });
});
