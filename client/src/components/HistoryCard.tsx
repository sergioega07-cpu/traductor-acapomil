import type { HistoryItem } from '../lib/types';

export function HistoryCard({ item }: { item: HistoryItem }) {
  const time = new Date(item.ts).toLocaleTimeString('es-CL', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const badge =
    item.mode === 'en-es' ? 'EN→ES' : item.mode === 'es-en' ? 'ES→EN' : 'EN↔ES';

  return (
    <article className="rounded-xl border border-acapomil-border bg-acapomil-card/90 p-4 md:p-5">
      <div className="mb-2 flex items-center justify-between gap-2 text-xs text-acapomil-muted">
        <span className="rounded-md bg-white/5 px-2 py-0.5 font-semibold text-sky-300">{badge}</span>
        <span>{time}</span>
      </div>
      <p className="text-xs text-gray-500 mb-0.5">Original</p>
      <p className="text-sm md:text-base text-gray-400 mb-3 whitespace-pre-wrap break-words leading-relaxed">
        {item.original || '—'}
      </p>
      <p className="text-xs text-acapomil-green/80 mb-0.5">Traducción</p>
      <p className="text-lg md:text-xl lg:text-2xl font-medium text-white whitespace-pre-wrap break-words leading-relaxed">
        {item.translation || '—'}
      </p>
    </article>
  );
}
