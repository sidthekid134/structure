import { X } from 'lucide-react';

export type CreateProjectForm = {
  name: string;
  slug: string;
  bundleId: string;
  description: string;
  githubOrg: string;
  easAccount: string;
};

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

  return (
    <div className="fixed inset-0 z-50 bg-black/55 flex items-center justify-center p-4" onClick={onClose}>
      <div className="w-full max-w-2xl rounded-2xl border border-border bg-background shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="px-6 py-4 border-b border-border flex items-center justify-between">
          <h2 className="font-semibold text-lg">Create Project Module</h2>
          <button type="button" className="p-2 rounded-lg hover:bg-muted" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-4">
          <label className="text-sm text-muted-foreground">Name (required)
            <input className="mt-1 w-full rounded-lg border border-border px-3 py-2 bg-background text-sm" value={form.name} onChange={(event) => onChange({ ...form, name: event.target.value })} placeholder="Payments App" />
          </label>
          <label className="text-sm text-muted-foreground">Slug (required)
            <input className="mt-1 w-full rounded-lg border border-border px-3 py-2 bg-background text-sm" value={form.slug} onChange={(event) => onChange({ ...form, slug: event.target.value })} placeholder="payments-app" />
          </label>
          <label className="text-sm text-muted-foreground">Bundle ID (required)
            <input className="mt-1 w-full rounded-lg border border-border px-3 py-2 bg-background text-sm" value={form.bundleId} onChange={(event) => onChange({ ...form, bundleId: event.target.value.trim().toLowerCase() })} placeholder="com.example.payments-app" />
          </label>
          <label className="text-sm text-muted-foreground">Description
            <input className="mt-1 w-full rounded-lg border border-border px-3 py-2 bg-background text-sm" value={form.description} onChange={(event) => onChange({ ...form, description: event.target.value })} placeholder="High-level context" />
          </label>
          <label className="text-sm text-muted-foreground">GitHub Org
            <input className="mt-1 w-full rounded-lg border border-border px-3 py-2 bg-background text-sm" value={form.githubOrg} onChange={(event) => onChange({ ...form, githubOrg: event.target.value })} placeholder="my-org" />
          </label>
          <label className="text-sm text-muted-foreground">EAS Account
            <input className="mt-1 w-full rounded-lg border border-border px-3 py-2 bg-background text-sm" value={form.easAccount} onChange={(event) => onChange({ ...form, easAccount: event.target.value })} placeholder="my-eas-account" />
          </label>
        </div>
        <div className="px-6 py-4 border-t border-border flex justify-end gap-2">
          <button type="button" className="rounded-lg border border-border px-3 py-2 text-sm" onClick={onClose}>Cancel</button>
          <button type="button" className="rounded-lg bg-primary text-primary-foreground px-3 py-2 text-sm" onClick={onCreate}>Create Project</button>
        </div>
      </div>
    </div>
  );
}
