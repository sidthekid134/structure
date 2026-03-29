import { Plus, X } from 'lucide-react';
import type { ModuleId, ProjectTemplateId } from './types';

export type CreateProjectForm = {
  name: string;
  slug: string;
  bundleId: string;
  description: string;
  githubOrg: string;
  easAccount: string;
  environments: string[];
  templateId: ProjectTemplateId;
  modules: ModuleId[];
};

export const DEFAULT_ENVIRONMENTS: string[] = ['qa', 'production'];
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

  function addEnvironment() {
    onChange({ ...form, environments: [...form.environments, ''] });
  }

  function removeEnvironment(idx: number) {
    onChange({ ...form, environments: form.environments.filter((_, i) => i !== idx) });
  }

  function updateEnvironment(idx: number, value: string) {
    const next = [...form.environments];
    next[idx] = value.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    onChange({ ...form, environments: next });
  }

  const validEnvs = form.environments.filter((e) => e.trim().length > 0);
  const canCreate =
    form.name.trim() && form.slug.trim() && form.bundleId.trim() && validEnvs.length > 0 && form.modules.length > 0;

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
            </label>

            <label className="text-sm text-muted-foreground">
              Bundle ID <span className="text-red-500">*</span>
              <input
                className="mt-1 w-full rounded-lg border border-border px-3 py-2 bg-background text-sm"
                value={form.bundleId}
                onChange={(e) => onChange({ ...form, bundleId: e.target.value.trim().toLowerCase() })}
                placeholder="com.example.payments-app"
              />
            </label>

            <label className="text-sm text-muted-foreground">
              Description
              <input
                className="mt-1 w-full rounded-lg border border-border px-3 py-2 bg-background text-sm"
                value={form.description}
                onChange={(e) => onChange({ ...form, description: e.target.value })}
                placeholder="High-level context"
              />
            </label>

            <label className="text-sm text-muted-foreground">
              GitHub Org
              <input
                className="mt-1 w-full rounded-lg border border-border px-3 py-2 bg-background text-sm"
                value={form.githubOrg}
                onChange={(e) => onChange({ ...form, githubOrg: e.target.value })}
                placeholder="my-org"
              />
            </label>

            <label className="text-sm text-muted-foreground">
              EAS Account
              <input
                className="mt-1 w-full rounded-lg border border-border px-3 py-2 bg-background text-sm"
                value={form.easAccount}
                onChange={(e) => onChange({ ...form, easAccount: e.target.value })}
                placeholder="my-eas-account"
              />
            </label>

            <div className="col-span-full">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-muted-foreground">
                  Environments <span className="text-red-500">*</span>
                </span>
                <button
                  type="button"
                  onClick={addEnvironment}
                  className="flex items-center gap-1 text-xs font-semibold text-primary hover:opacity-80 transition-opacity"
                >
                  <Plus size={12} />
                  Add
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                {form.environments.map((env, idx) => (
                  <div key={idx} className="flex items-center gap-1 rounded-lg border border-border bg-muted overflow-hidden">
                    <input
                      className="w-28 px-2.5 py-1.5 bg-transparent text-xs font-mono focus:outline-none focus:ring-2 focus:ring-primary/30 rounded-l-lg"
                      value={env}
                      onChange={(e) => updateEnvironment(idx, e.target.value)}
                      placeholder="e.g. qa"
                    />
                    {form.environments.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeEnvironment(idx)}
                        className="px-1.5 py-1.5 text-muted-foreground hover:text-red-500 transition-colors"
                      >
                        <X size={11} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
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

