import { Volume2 } from 'lucide-react';
import type { HistoryItem } from '../lib/types';
import { langForTranslation } from '../lib/tts';

export function HistoryCard({
  item,
  speakingId,
  onSpeak,
}: {
  item: HistoryItem;
  speakingId: string | null;
  onSpeak: (item: HistoryItem) => void;
}) {
  const active = speakingId === item.id;
  const time = new Date(item.ts).toLocaleTimeString('es-CL', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const badge =
    item.mode === 'en-es' ? 'EN→ES' : item.mode === 'es-en' ? 'ES→EN' : 'AUTO';

  return (
    <article
      className={`rounded-xl border bg-acapomil-card p-4 transition ${
        active ? 'listening-glow border-acapomil-green' : 'border-acapomil-border'
      }`}
    >
      <div className="mb-2 flex items-center justify-between gap-2 text-xs text-acapomil-muted">
        <span className="rounded-md bg-white/5 px-2 py-0.5 font-semibold text-sky-300">{badge}</span>
        <span>{time}</span>
      </div>
      <p className="text-sm text-gray-400 mb-1">Original</p>
      <p className="text-base text-gray-200 mb-3 whitespace-pre-wrap">{item.original || '—'}</p>
      <p className="text-sm text-acapomil-green mb-1">Traduccion</p>
      <p className="text-lg font-medium text-white mb-3 whitespace-pre-wrap">
        {item.translation || '—'}
      </p>
      <button
        type="button"
        onClick={() => onSpeak(item)}
        className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium border ${
          active
            ? 'border-acapomil-green text-acapomil-green bg-emerald-500/10'
            : 'border-white/10 text-gray-200 hover:bg-white/5'
        }`}
        title={`TTS ${langForTranslation(item.mode, item.detectedLang)}`}
      >
        <Volume2 className="h-4 w-4" />
        Escuchar
      </button>
    </article>
  );
}
