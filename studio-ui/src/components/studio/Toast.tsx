export function Toast({ text, tone }: { text: string; tone: 'ok' | 'error' }) {
  return (
    <div className={`fixed right-4 bottom-4 z-50 rounded-lg px-3 py-2 text-sm text-white ${tone === 'error' ? 'bg-red-600' : 'bg-slate-900'}`}>
      {text}
    </div>
  );
}
