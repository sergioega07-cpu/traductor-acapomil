import { useEffect, useRef, useState } from 'react';
import { Crest } from './Crest';
import { StatusPill } from './StatusPill';
import { createSyncChannel, type SyncMessage } from '../lib/broadcast';
import type { AppStatus, HistoryItem, PartialSubtitles, TranslateMode } from '../lib/types';
import { useSubtitleDisplay } from '../lib/subtitleDisplay';
import { isValidTranslationText, stopSpeaking } from '../lib/tts';

function targetLabel(mode: TranslateMode, detected?: string) {
  if (mode === 'en-es') return 'EN→ES (un sentido)';
  if (mode === 'es-en') return 'ES→EN (un sentido)';
  if (detected === 'en') return 'EN→ES';
  if (detected === 'es') return 'ES→EN';
  return 'CONVERSACIÓN EN↔ES';
}

export function ProjectionView() {
  const [status, setStatus] = useState<AppStatus>('idle');
  const [mode, setMode] = useState<TranslateMode>('auto');
  const [partial, setPartial] = useState<PartialSubtitles>({ original: '', translation: '' });
  const [latest, setLatest] = useState<HistoryItem | null>(null);

  const channelRef = useRef<ReturnType<typeof createSyncChannel> | null>(null);

  useEffect(() => {
    const channel = createSyncChannel((msg: SyncMessage) => {
      if (msg.kind === 'partial') {
        setPartial(msg.partial);
        setMode(msg.mode);
      } else if (msg.kind === 'final') {
        setLatest(msg.item);
        setPartial({ original: '', translation: '' });
        setMode(msg.item.mode);
      } else if (msg.kind === 'status') {
        setStatus(msg.status);
        setMode(msg.mode);
      } else if (msg.kind === 'clear') {
        setPartial({ original: '', translation: '' });
        setLatest(null);
      } else if (msg.kind === 'speak_stop') {
        stopSpeaking(); // safety cancel only — projection never speaks
      }
      // ignore 'speak' — subtitles only, no TTS
    });
    channelRef.current = channel;
    channel.post({ kind: 'ping' });
    return () => {
      channel.close();
      channelRef.current = null;
    };
  }, []);

  const liveOriginal = partial.original || latest?.original || '';
  const rawLiveTranslation = partial.translation || latest?.translation || '';
  const liveTranslation = isValidTranslationText(rawLiveTranslation) ? rawLiveTranslation : '';
  const display = useSubtitleDisplay(liveOriginal, liveTranslation);
  const detected = latest?.detectedLang;
  const live = status === 'listening';

  return (
    <div className="min-h-screen bg-black text-white flex flex-col">
      <header className="flex items-center justify-between px-6 md:px-10 py-3 md:py-4 border-b border-white/10 shrink-0">
        <div className="flex items-center gap-3 min-w-[120px] md:min-w-[160px]">
          <Crest className="w-11 h-11 md:w-12 md:h-12" />
        </div>
        <h1 className="text-lg md:text-2xl lg:text-3xl font-bold tracking-[0.15em] text-center px-2">
          TRADUCTOR ACAPOMIL
        </h1>
        <div className="flex justify-end min-w-[120px] md:min-w-[160px]">
          <StatusPill status={status} />
        </div>
      </header>

      <main className="relative flex-1 flex flex-col w-full min-h-0">
        <div className="absolute inset-0 bg-gradient-to-b from-black via-[#05070a] to-black" />

        <div className="relative z-10 flex items-center justify-center pt-6 md:pt-8 px-6">
          <p
            className={`text-sm md:text-base font-semibold tracking-wide ${
              live ? 'text-acapomil-green' : 'text-acapomil-muted'
            }`}
          >
            <span className="inline-block h-2 w-2 rounded-full mr-2 align-middle bg-current" />
            {live
              ? `TRADUCCIÓN EN VIVO (${targetLabel(mode, detected)})`
              : `EN ESPERA — SALIDA (${targetLabel(mode, detected)})`}
          </p>
        </div>

        <div className="relative z-10 flex-1 min-h-[18vh] md:min-h-[22vh]" />

        <div className="relative z-10 flex flex-col items-center justify-end px-5 sm:px-10 lg:px-16 pb-8 md:pb-12 lg:pb-14 w-full">
          {display.largeText || liveOriginal ? (
            <div className="w-full max-w-6xl xl:max-w-7xl mx-auto text-center">
              {display.originalLine ? (
                <p
                  className="mb-3 md:mb-5 text-gray-400/85 whitespace-pre-wrap break-words leading-relaxed drop-shadow-[0_2px_8px_rgba(0,0,0,0.9)]"
                  style={{
                    fontSize: 'clamp(1rem, 1.6vw + 0.35rem, 1.55rem)',
                  }}
                >
                  {display.originalLine}
                  {display.showTranslatingBadge ? (
                    <span className="ml-2 text-sky-400/80 font-medium normal-case tracking-normal text-sm">
                      · traduciendo…
                    </span>
                  ) : null}
                </p>
              ) : display.showTranslatingBadge ? (
                <p className="mb-3 md:mb-5 text-sky-400/80 text-sm font-medium">traduciendo…</p>
              ) : null}
              <div className="rounded-2xl bg-black/70 backdrop-blur-sm border border-white/10 px-5 py-6 sm:px-8 sm:py-8 md:px-12 md:py-10 shadow-[0_12px_60px_rgba(0,0,0,0.65)]">
                <p
                  className="font-semibold text-white whitespace-pre-wrap break-words drop-shadow-[0_2px_12px_rgba(0,0,0,0.85)]"
                  style={{
                    fontSize: 'clamp(2rem, 5vw + 0.25rem, 4.75rem)',
                    lineHeight: 1.3,
                  }}
                >
                  {display.largeText || '…'}
                </p>
              </div>
            </div>
          ) : (
            <div className="w-full max-w-5xl mx-auto text-center rounded-2xl bg-black/50 border border-white/10 px-6 py-14 md:py-20">
              <p
                className="font-semibold text-gray-400 tracking-wide break-words"
                style={{ fontSize: 'clamp(1.75rem, 4vw + 0.5rem, 3.5rem)' }}
              >
                ESPERANDO ALOCUCIÓN...
              </p>
              <p className="mt-4 text-acapomil-muted text-base md:text-lg">
                La traducción aparecerá automáticamente en pantalla
              </p>
            </div>
          )}
        </div>
      </main>

      <footer className="flex items-center justify-between px-6 md:px-10 py-3 border-t border-white/10 text-xs tracking-[0.2em] text-acapomil-muted uppercase shrink-0">
        <span>Traducción simultánea en vivo</span>
        <span>Salida principal</span>
      </footer>
    </div>
  );
}
