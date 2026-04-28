import { useMemo } from 'react';
import {
  Apple,
  Cloud,
  CloudCog,
  Download,
  ExternalLink,
  Flame,
  Github,
  Globe,
  PlayCircle,
  Smartphone,
  Sparkles,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import type { ProvisioningPlanResponse } from './types';
import { collectUpstreamResources } from './provisioning-display-registry';

interface QuickLink {
  id: string;
  label: string;
  subtitle?: string;
  href: string;
  icon: LucideIcon;
  /** Tailwind colour for icon + accent. */
  accent: string;
  /** Tailwind colour for the icon background tile. */
  tile: string;
}

/**
 * Scans the merged "upstream" resource map produced across all completed
 * provisioning steps, and surfaces a curated set of high-value links.
 * Anything unknown is silently ignored — we never invent links for missing
 * data.
 */
function deriveQuickLinks(upstream: Record<string, string>): QuickLink[] {
  const links: QuickLink[] = [];

  const githubRepo = upstream.github_repo_url;
  if (githubRepo) {
    const slug = githubRepo
      .replace(/^https?:\/\/(www\.)?github\.com\//, '')
      .replace(/\.git$/, '')
      .replace(/\/+$/, '');
    links.push({
      id: 'github-repo',
      label: 'GitHub Repository',
      subtitle: slug || githubRepo,
      href: githubRepo,
      icon: Github,
      accent: 'text-slate-900 dark:text-slate-100',
      tile: 'bg-slate-900/10 dark:bg-slate-100/10',
    });
  }

  const easProjectId = upstream.eas_project_id;
  if (easProjectId) {
    links.push({
      id: 'expo-project',
      label: 'Expo / EAS Project',
      subtitle: easProjectId,
      href: `https://expo.dev/projects/${easProjectId}`,
      icon: Sparkles,
      accent: 'text-indigo-600 dark:text-indigo-300',
      tile: 'bg-indigo-500/10',
    });
  }

  const firebaseProjectId = upstream.firebase_project_id;
  if (firebaseProjectId) {
    links.push({
      id: 'firebase-console',
      label: 'Firebase Console',
      subtitle: firebaseProjectId,
      href: `https://console.firebase.google.com/project/${firebaseProjectId}`,
      icon: Flame,
      accent: 'text-amber-600 dark:text-amber-300',
      tile: 'bg-amber-500/10',
    });
  }

  const gcpProjectId = upstream.gcp_project_id;
  if (gcpProjectId) {
    links.push({
      id: 'gcp-console',
      label: 'Google Cloud',
      subtitle: gcpProjectId,
      href: `https://console.cloud.google.com/home/dashboard?project=${gcpProjectId}`,
      icon: CloudCog,
      accent: 'text-blue-600 dark:text-blue-300',
      tile: 'bg-blue-500/10',
    });
  }

  const cloudflareZoneId = upstream.cloudflare_zone_id;
  if (cloudflareZoneId) {
    const domain = upstream.domain_name;
    links.push({
      id: 'cloudflare-zone',
      label: 'Cloudflare Dashboard',
      subtitle: domain ?? cloudflareZoneId,
      href: `https://dash.cloudflare.com/?zoneId=${cloudflareZoneId}`,
      icon: Cloud,
      accent: 'text-orange-600 dark:text-orange-300',
      tile: 'bg-orange-500/10',
    });
  } else if (upstream.domain_name) {
    links.push({
      id: 'domain',
      label: 'Domain',
      subtitle: upstream.domain_name,
      href: `https://${upstream.domain_name}`,
      icon: Globe,
      accent: 'text-emerald-600 dark:text-emerald-300',
      tile: 'bg-emerald-500/10',
    });
  }

  const ascAppId = upstream.asc_app_id;
  if (ascAppId) {
    links.push({
      id: 'asc-app',
      label: 'App Store Connect',
      subtitle: ascAppId,
      href: `https://appstoreconnect.apple.com/apps/${ascAppId}/appstore`,
      icon: Smartphone,
      accent: 'text-zinc-700 dark:text-zinc-200',
      tile: 'bg-zinc-700/10 dark:bg-zinc-200/10',
    });
  }

  const appleTeamId = upstream.apple_team_id;
  if (appleTeamId) {
    links.push({
      id: 'apple-developer',
      label: 'Apple Developer',
      subtitle: `Team ${appleTeamId}`,
      href: 'https://developer.apple.com/account',
      icon: Apple,
      accent: 'text-zinc-700 dark:text-zinc-200',
      tile: 'bg-zinc-700/10 dark:bg-zinc-200/10',
    });
  }

  const playAppId = upstream.play_app_id;
  if (playAppId) {
    links.push({
      id: 'play-console',
      label: 'Google Play Console',
      subtitle: playAppId,
      href: 'https://play.google.com/console',
      icon: PlayCircle,
      accent: 'text-green-600 dark:text-green-300',
      tile: 'bg-green-500/10',
    });
  }

  return links;
}

/** Uniform pill size for both real links and skeletons. */
const PILL_SIZE = 'w-44 h-10';
const SKELETON_COUNT = 6;

function QuickLinkSkeleton() {
  return (
    <div
      aria-hidden
      className={`inline-flex items-center gap-2 rounded-md border border-border/60 bg-background/40 px-2 ${PILL_SIZE}`}
    >
      <span className="h-5 w-5 shrink-0 animate-pulse rounded bg-muted/70" />
      <span className="min-w-0 flex-1 flex flex-col gap-1">
        <span className="h-2 w-3/4 animate-pulse rounded bg-muted/80" />
        <span className="h-1.5 w-1/2 animate-pulse rounded bg-muted/60" />
      </span>
    </div>
  );
}

export function ProjectQuickLinks({
  plan,
  onDeleteProject,
}: {
  plan: ProvisioningPlanResponse | null;
  onDeleteProject?: () => void;
}) {
  const links = useMemo(() => {
    if (!plan) return [];
    return deriveQuickLinks(collectUpstreamResources(plan.nodeStates));
  }, [plan]);

  const isLoading = plan === null;
  const hasLinks = links.length > 0;
  const envDownloadHref = plan
    ? `/api/projects/${encodeURIComponent(plan.projectId)}/integration-kit/env`
    : null;

  return (
    <div className="rounded-xl border border-border bg-card/60 p-2">
      <div className="flex items-center justify-between gap-2 px-1 pb-1.5">
        <div className="flex items-center gap-2">
          <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
            Project Links
          </p>
          {isLoading ? (
            <span className="h-2 w-14 animate-pulse rounded bg-muted/60" aria-hidden />
          ) : (
            <p className="text-[10px] text-muted-foreground/70">
              {links.length} {links.length === 1 ? 'integration' : 'integrations'}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {envDownloadHref ? (
            <a
              href={envDownloadHref}
              download
              className="inline-flex items-center gap-1 rounded-md border border-primary/30 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-primary hover:bg-primary/10"
              title="Download project-level .env secrets bundle"
            >
              <Download size={11} />
              Download .env
            </a>
          ) : null}
          {onDeleteProject ? (
            <button
              type="button"
              onClick={onDeleteProject}
              className="inline-flex items-center gap-1 rounded-md border border-red-500/40 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-red-600 dark:text-red-400 hover:bg-red-500/10"
            >
              <Trash2 size={11} />
              Delete Project
            </button>
          ) : null}
        </div>
      </div>
      {isLoading ? (
        <div className="flex flex-wrap gap-1.5" role="status" aria-label="Loading project links">
          {Array.from({ length: SKELETON_COUNT }).map((_, i) => (
            <QuickLinkSkeleton key={i} />
          ))}
        </div>
      ) : !hasLinks ? (
        <p className="px-1 py-1 text-[11px] text-muted-foreground">
          Integration links will appear here once setup steps complete.
        </p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {links.map((link) => {
            const Icon = link.icon;
            return (
              <a
                key={link.id}
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                title={link.subtitle ? `${link.label} — ${link.subtitle}` : link.label}
                className={`group inline-flex items-center gap-2 rounded-md border border-border bg-background/60 px-2 transition-colors hover:border-primary/40 hover:bg-accent ${PILL_SIZE}`}
              >
                <span
                  className={`flex h-5 w-5 shrink-0 items-center justify-center rounded ${link.tile}`}
                >
                  <Icon size={12} className={link.accent} />
                </span>
                <span className="min-w-0 flex-1 flex flex-col leading-tight">
                  <span className="text-[11px] font-bold text-foreground truncate">
                    {link.label}
                  </span>
                  {link.subtitle ? (
                    <span className="text-[9px] font-mono text-muted-foreground truncate">
                      {link.subtitle}
                    </span>
                  ) : null}
                </span>
                <ExternalLink
                  size={10}
                  className="shrink-0 text-muted-foreground/60 transition-colors group-hover:text-primary"
                />
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}
