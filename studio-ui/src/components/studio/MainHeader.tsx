import { Moon, Sun } from 'lucide-react';

export function MainHeader({
  title,
  subtitle,
  isDark,
  wsStatus,
  wsTone,
  onToggleDark,
}: {
  title: string;
  subtitle: string;
  isDark: boolean;
  wsStatus: 'offline' | 'connecting' | 'live' | 'error';
  wsTone: string;
  onToggleDark: () => void;
}) {
  return (
    <header className="sticky top-0 z-10 bg-background/90 backdrop-blur border-b border-border px-6 py-4 flex items-center justify-between">
      <div>
        <h1 className="text-xl font-bold tracking-tight">{title}</h1>
        <p className="text-xs text-muted-foreground">{subtitle}</p>
      </div>
      <div className="flex items-center gap-3">
        <button type="button" className="p-2 rounded-lg border border-border hover:bg-muted" onClick={onToggleDark}>
          {isDark ? <Sun size={16} /> : <Moon size={16} />}
        </button>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className={`w-2 h-2 rounded-full ${wsTone}`} />
          {wsStatus}
        </div>
      </div>
    </header>
  );
}
