import { useEffect, useMemo, useState } from 'react';
import { Volume2 } from 'lucide-react';
import { Crest } from './Crest';
import { StatusPill } from './StatusPill';
import { createSyncChannel, type SyncMessage } from '../lib/broadcast';
import type { AppStatus, HistoryItem, PartialSubtitles, TranslateMode } from '../lib/types';
import { langForTranslation, speakText, stopSpeaking, waitForVoices } from '../lib/tts';

function targetLabel(mode: TranslateMode, detected?: string) {
  if (mode === 'en-es') return 'ESPANOL';
  if (mode === 'es-en') return 'INGLES';
  if (detected === 'en') return 'ESPANOL';
  if (detected === 'es') return 'INGLES';
  return 'AUTO';
}

export function ProjectionView() {
  const [status, setStatus] = useState<AppStatus>('idle');
  const [mode, setMode] = useState<TranslateMode>('en-es');
  const [partial, setPartial] = useState<PartialSubtitles>({ original: '', translation: '' });
  const [latest, setLatest] = useState<HistoryItem | null>(null);
  const [speaking, setSpeaking] = useState(false);

  useEffect(() => {
    void waitForVoices();
  }, []);

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
      } else if (msg.kind === 'speak') {
        speakText(msg.text, msg.lang, () => setSpeaking(true), () => setSpeaking(false));
      } else if (msg.kind === 'speak_stop') {
        stopSpeaking();
        setSpeaking(false);
      }
    });
    channel.post({ kind: 'ping' });
    return () => channel.close();
  }, []);

  const display = useMemo(() => {
    if (partial.translation?.trim()) return partial.translation.trim();
    if (latest?.translation?.trim()) return latest.translation.trim();
    return '';
  }, [partial, latest]);

  const original = partial.original || latest?.original || '';
  const detected = latest?.detectedLang;
  const live = status === 'listening';

  const onSpeak = () => {
    if (!display) return;
    const lang = langForTranslation(mode, detected);
    speakText(display, lang, () => setSpeaking(true), () => setSpeaking(false));
  };

  return (
    <div className="min-h-screen bg-black text-white flex flex-col">
      <header className="flex items-center justify-between px-6 md:px-10 py-4 md:py-5 border-b border-white/10">
        <div className="flex items-center gap-3 min-w-[140px] md:min-w-[180px]">
          <Crest className="w-12 h-12" />
        </div>
        <h1 className="text-xl md:text-2xl lg:text-3xl font-bold tracking-[0.15em] text-center px-2">
          TRADUCTOR ACAPOMIL
        </h1>
        <div className="flex justify-end min-w-[140px] md:min-w-[180px]">
          <StatusPill status={status} />
        </div>
      </header>

      <main className="flex-1 flex flex-col items-center justify-center px-6 md:px-12 lg:px-16 py-8 text-center w-full">
        <p
          className={`mb-6 md:mb-8 text-sm md:text-base font-semibold tracking-wide ${
            live ? 'text-acapomil-green' : 'text-acapomil-muted'
          }`}
        >
          <span className="inline-block h-2 w-2 rounded-full mr-2 align-middle bg-current" />
          {live
            ? `TRADUCCION EN VIVO (${targetLabel(mode, detected)})`
            : `EN ESPERA — SALIDA (${targetLabel(mode, detected)})`}
        </p>

        {display ? (
          <>
            <p
              className="w-full max-w-6xl xl:max-w-7xl font-semibold text-white break-words leading-relaxed"
              style={{
                fontSize: 'clamp(1.75rem, 4.5vw + 0.5rem, 4.5rem)',
              }}
            >
              {display}
            </p>
            {original ? (
              <p
                className="mt-8 md:mt-10 w-full max-w-5xl text-gray-500 break-words leading-relaxed"
                style={{ fontSize: 'clamp(0.95rem, 1.2vw + 0.5rem, 1.35rem)' }}
              >
                {original}
              </p>
            ) : null}
          </>
        ) : (
          <>
            <p
              className="font-semibold text-gray-400 tracking-wide break-words"
              style={{ fontSize: 'clamp(1.75rem, 4vw + 0.5rem, 3.5rem)' }}
            >
              ESPERANDO ALOCUCION...
            </p>
            <p className="mt-4 text-acapomil-muted text-base md:text-lg">
              La traduccion aparecera automaticamente en pantalla
            </p>
          </>
        )}

        <button
          type="button"
          onClick={onSpeak}
          disabled={!display}
          className={`mt-10 md:mt-12 inline-flex items-center gap-2 rounded-xl border px-5 py-3 text-sm md:text-base font-semibold transition ${
            speaking
              ? 'listening-glow border-acapomil-green text-acapomil-green'
              : 'border-white/20 text-white hover:bg-white/5 disabled:opacity-40'
          }`}
        >
          <Volume2 className="h-5 w-5" />
          Escuchar subtitulo
        </button>
      </main>

      <footer className="flex items-center justify-between px-6 md:px-10 py-4 border-t border-white/10 text-xs tracking-[0.2em] text-acapomil-muted uppercase">
        <span>Traduccion simultanea en vivo</span>
        <span>Salida principal</span>
      </footer>
    </div>
  );
}
