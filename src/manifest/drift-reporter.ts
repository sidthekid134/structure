import { DriftFinding, DriftReport } from '../types/manifest';

export class DriftReporter {
  generateReport(projectId: string, manifestVersion: string, findings: DriftFinding[]): DriftReport {
    const configChanges = findings.filter((f) => f.driftType === 'config_change').length;
    const deletions = findings.filter((f) => f.driftType === 'resource_deleted').length;
    const additions = findings.filter((f) => f.driftType === 'resource_added').length;

    return {
      projectId,
      generatedAt: Date.now(),
      manifestVersion,
      findings,
      summary: {
        configChanges,
        deletions,
        additions,
        total: findings.length,
      },
    };
  }

  formatSummary(report: DriftReport): string {
    if (report.summary.total === 0) {
      return `[drift] No drift detected for project "${report.projectId}".`;
    }

    const lines: string[] = [
      `[drift] Drift report for project "${report.projectId}" (manifest v${report.manifestVersion}):`,
    ];

    // Group by provider
    const byProvider = new Map<string, DriftFinding[]>();
    for (const finding of report.findings) {
      const group = byProvider.get(finding.provider) ?? [];
      group.push(finding);
      byProvider.set(finding.provider, group);
    }

    for (const [provider, providerFindings] of byProvider) {
      const changes = providerFindings.filter((f) => f.driftType === 'config_change').length;
      const deleted = providerFindings.filter((f) => f.driftType === 'resource_deleted').length;
      const added = providerFindings.filter((f) => f.driftType === 'resource_added').length;

      const parts: string[] = [];
      if (changes > 0) parts.push(`${changes} config change${changes !== 1 ? 's' : ''}`);
      if (deleted > 0) parts.push(`${deleted} deleted resource${deleted !== 1 ? 's' : ''}`);
      if (added > 0) parts.push(`${added} new resource${added !== 1 ? 's' : ''}`);

      lines.push(`  ${provider}: ${parts.join(', ')}`);

      for (const finding of providerFindings) {
        const suffix =
          finding.driftType === 'config_change'
            ? `config changed (${finding.oldHash?.slice(0, 8)} → ${finding.newHash?.slice(0, 8)})`
            : finding.driftType === 'resource_deleted'
              ? 'deleted from provider'
              : 'new resource (not in manifest)';
        lines.push(`    - ${finding.resourceType}/${finding.resourceId}: ${suffix}`);
      }
    }

    lines.push(
      `  Total: ${report.summary.configChanges} changes, ${report.summary.deletions} deletions, ${report.summary.additions} additions`,
    );

    return lines.join('\n');
  }
}
