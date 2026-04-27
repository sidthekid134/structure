import { X } from 'lucide-react';
import type { ModuleId, MobilePlatform, ProjectTemplateId } from './types';
import { isValidAppHostname } from './helpers';

export type CreateProjectForm = {
  name: string;
  slug: string;
  domain: string;
  description: string;
  environments: string[];
  platforms: MobilePlatform[];
  templateId: ProjectTemplateId;
  modules: ModuleId[];
};

export const REQUIRED_ENVIRONMENTS: string[] = ['preview', 'production'];
export const DEFAULT_ENVIRONMENTS: string[] = [...REQUIRED_ENVIRONMENTS];
export const DEFAULT_PLATFORMS: MobilePlatform[] = ['ios', 'android'];
export const DEFAULT_MODULE_IDS: ModuleId[] = [
  'firebase-core',
  'firebase-auth',
  'firebase-firestore',
  'firebase-storage',
  'github-repo',
  'github-ci',
  'eas-builds',
];

export function CreateProjectModal({
  show,
  form,
  onClose,
  onChange,
  onCreate,
}: {
  show: boolean;
  form: CreateProjectForm;
  onClose: () => void;
  onChange: (next: CreateProjectForm) => void;
  onCreate: () => void;
}) {
  if (!show) return null;

  const developmentEnabled = form.environments.includes('development');

  function toggleDevelopmentEnvironment(enabled: boolean) {
    if (enabled) {
      onChange({ ...form, environments: ['development', ...REQUIRED_ENVIRONMENTS] });
      return;
    }
    onChange({ ...form, environments: [...REQUIRED_ENVIRONMENTS] });
  }

  const platforms = form.platforms.length > 0 ? form.platforms : DEFAULT_PLATFORMS;
  function togglePlatform(platform: MobilePlatform, enabled: boolean) {
    const current = new Set(platforms);
    if (enabled) {
      current.add(platform);
    } else {
      current.delete(platform);
    }
    onChange({ ...form, platforms: Array.from(current) as MobilePlatform[] });
  }

  const canCreate =
    form.name.trim() &&
    form.slug.trim() &&
    isValidAppHostname(form.domain) &&
    form.modules.length > 0 &&
    platforms.length > 0;

  return (
    <div className="fixed inset-0 z-50 bg-black/55 flex items-center justify-center p-4" onClick={onClose}>
      <div className="w-full max-w-4xl rounded-2xl border border-border bg-background shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-border flex items-center justify-between">
          <div>
            <h2 className="font-semibold text-lg">Create Project</h2>
            <p className="text-xs text-muted-foreground mt-0.5">Project details and environments</p>
          </div>
          <button type="button" className="p-2 rounded-lg hover:bg-muted" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-4">
            <label className="text-sm text-muted-foreground">
              Name <span className="text-red-500">*</span>
              <input
                className="mt-1 w-full rounded-lg border border-border px-3 py-2 bg-background text-sm"
                value={form.name}
                onChange={(e) => onChange({ ...form, name: e.target.value })}
                placeholder="Payments App"
              />
            </label>

            <label className="text-sm text-muted-foreground">
              Slug <span className="text-red-500">*</span>
              <input
                className="mt-1 w-full rounded-lg border border-border px-3 py-2 bg-background text-sm"
                value={form.slug}
                onChange={(e) => onChange({ ...form, slug: e.target.value })}
                placeholder="payments-app"
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                Used for GitHub repo name, EAS project name, and GCP-style IDs.
              </p>
            </label>

            <label className="text-sm text-muted-foreground md:col-span-2">
              App domain <span className="text-red-500">*</span>
              <input
                className="mt-1 w-full rounded-lg border border-border px-3 py-2 bg-background text-sm font-mono"
                value={form.domain}
                onChange={(e) => onChange({ ...form, domain: e.target.value.trim().toLowerCase() })}
                placeholder="app.example.com"
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                Used for web, auth, and deep links. iOS/Android bundle ID is set automatically from this hostname (reverse-DNS).
              </p>
            </label>

            <label className="text-sm text-muted-foreground md:col-span-2">
              Description
              <input
                className="mt-1 w-full rounded-lg border border-border px-3 py-2 bg-background text-sm"
                value={form.description}
                onChange={(e) => onChange({ ...form, description: e.target.value })}
                placeholder="High-level context"
              />
            </label>

            <div className="col-span-full">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-muted-foreground">
                  Environments <span className="text-red-500">*</span>
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                {REQUIRED_ENVIRONMENTS.map((env) => (
                  <div key={env} className="rounded-lg border border-border bg-muted px-2.5 py-1.5 text-xs font-mono">
                    {env}
                  </div>
                ))}
              </div>
              <label className="mt-2 inline-flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={developmentEnabled}
                  onChange={(e) => toggleDevelopmentEnvironment(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-border"
                />
                Enable development environment
              </label>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Expo supports only development, preview, and production.
              </p>
            </div>

            <div className="col-span-full">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-muted-foreground">
                  Mobile platforms <span className="text-red-500">*</span>
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                {(['ios', 'android'] as MobilePlatform[]).map((platform) => {
                  const active = platforms.includes(platform);
                  return (
                    <label
                      key={platform}
                      className={`inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs cursor-pointer ${
                        active
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-border bg-muted text-muted-foreground'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={active}
                        onChange={(e) => togglePlatform(platform, e.target.checked)}
                        className="h-3.5 w-3.5 rounded border-border"
                      />
                      <span className="font-mono">{platform}</span>
                    </label>
                  );
                })}
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Pick at least one. Pick only one to keep the provisioning plan focused on
                that platform — sign-ins (Google / Apple / email) and Firebase auth still work
                independently of the other platform.
              </p>
            </div>
          </div>

        <div className="px-6 py-4 border-t border-border flex justify-end gap-2">
          <button type="button" className="rounded-lg border border-border px-3 py-2 text-sm" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            disabled={!canCreate}
            className="rounded-lg bg-primary text-primary-foreground px-3 py-2 text-sm disabled:opacity-40 disabled:cursor-not-allowed"
            onClick={onCreate}
          >
            Create Project
          </button>
        </div>
      </div>
    </div>
  );
}

