import type { AppStatus } from '../lib/types';

const LABELS: Record<string, string> = {
  idle: 'EN ESPERA',
  ready: 'EN ESPERA',
  connecting: 'CONECTANDO',
  listening: 'ESCUCHANDO',
  stopped: 'DETENIDO',
  disconnected: 'DESCONECTADO',
  error: 'ERROR',
};

export function StatusPill({ status }: { status: AppStatus }) {
  const live = status === 'listening';
  const err = status === 'error';
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold tracking-wide ${
        live
          ? 'bg-emerald-500/15 text-acapomil-green border border-emerald-500/40'
          : err
            ? 'bg-red-500/15 text-red-400 border border-red-500/40'
            : 'bg-white/5 text-acapomil-muted border border-white/10'
      }`}
    >
      <span
        className={`h-2 w-2 rounded-full ${
          live ? 'bg-acapomil-green animate-pulse' : err ? 'bg-red-400' : 'bg-gray-500'
        }`}
      />
      {LABELS[status] || 'EN ESPERA'}
    </span>
  );
}
