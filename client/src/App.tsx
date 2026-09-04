import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Copy,
  Eraser,
  Mic,
  Monitor,
  Play,
  RefreshCw,
  Shield,
  Sparkles,
  Square,
  Volume2,
} from 'lucide-react';
import { Crest } from './components/Crest';
import { StatusPill } from './components/StatusPill';
import { HistoryCard } from './components/HistoryCard';
import { ProjectionView } from './components/ProjectionView';
import { useMicCapture } from './hooks/useMicCapture';
import { useTranslatorSocket } from './hooks/useTranslatorSocket';
import { createSyncChannel } from './lib/broadcast';
import type { HistoryItem, TranslateMode } from './lib/types';
import {
  langForTranslation,
  speakText,
  stopSpeaking,
  voiceLabel,
} from './lib/tts';

function isProjectionRoute() {
  const q = new URLSearchParams(window.location.search);
  return window.location.pathname.includes('projection') || q.get('mode') === 'projection';
}

const DEMO_PHRASE = {
  original: 'Welcome distinguished guests to the ACAPOMIL annual assembly.',
  translation:
    'Bienvenidos distinguidos invitados a la asamblea anual de ACAPOMIL.',
};

export default function App() {
  if (isProjectionRoute()) return <ProjectionView />;
  return <ControlPanel />;
}

function ControlPanel() {
  const mic = useMicCapture();
  const tx = useTranslatorSocket();
  const [autoVoice, setAutoVoice] = useState(true);
  const [voiceOut, setVoiceOut] = useState('es-CL');
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const syncRef = useRef<ReturnType<typeof createSyncChannel> | null>(null);
  const lastAutoId = useRef<string | null>(null);

  useEffect(() => {
    syncRef.current = createSyncChannel((msg) => {
      if (msg.kind === 'ping') {
        syncRef.current?.post({ kind: 'status', status: tx.status, mode: tx.mode });
        syncRef.current?.post({ kind: 'partial', partial: tx.partial, mode: tx.mode });
        syncRef.current?.post({ kind: 'history', items: tx.history });
      }
    });
    return () => syncRef.current?.close();
  }, []);

  // Sync projection window
  useEffect(() => {
    syncRef.current?.post({ kind: 'status', status: tx.status, mode: tx.mode });
  }, [tx.status, tx.mode]);

  useEffect(() => {
    syncRef.current?.post({ kind: 'partial', partial: tx.partial, mode: tx.mode });
  }, [tx.partial, tx.mode]);

  useEffect(() => {
    const newest = tx.history[0];
    if (!newest) return;
    syncRef.current?.post({ kind: 'final', item: newest });
    if (autoVoice && newest.id !== lastAutoId.current && newest.translation) {
      lastAutoId.current = newest.id;
      speakItem(newest);
    }
  }, [tx.history, autoVoice]);

  useEffect(() => {
    const lang = langForTranslation(tx.mode);
    setVoiceOut(lang);
  }, [tx.mode]);

  const deviceLabel = useMemo(() => {
    if (mic.permission === 'denied') return 'Microfono denegado por el navegador';
    if (mic.permission !== 'granted' || !mic.devices.length) {
      return 'AUTORIZAR ACCESO AL MICROFONO';
    }
    const d = mic.devices.find((x) => x.deviceId === mic.deviceId);
    return d?.label || 'Microfono predeterminado';
  }, [mic]);

  const openProjection = () => {
    const url = `${window.location.origin}${window.location.pathname}?mode=projection`;
    window.open(url, 'traductor-acapomil-projection', 'noopener,noreferrer');
  };

  const speakItem = (item: HistoryItem) => {
    const lang = langForTranslation(item.mode, item.detectedLang);
    setVoiceOut(lang);
    setSpeakingId(item.id);
    syncRef.current?.post({ kind: 'speak', text: item.translation, lang, id: item.id });
    speakText(
      item.translation,
      lang,
      () => setSpeakingId(item.id),
      () => setSpeakingId(null)
    );
  };

  const speakLive = () => {
    const text = tx.partial.translation || tx.history[0]?.translation || '';
    if (!text) return;
    const lang = langForTranslation(tx.mode, tx.history[0]?.detectedLang);
    setSpeakingId('live');
    syncRef.current?.post({ kind: 'speak', text, lang, id: 'live' });
    speakText(text, lang, () => setSpeakingId('live'), () => setSpeakingId(null));
  };

  const onStart = async () => {
    tx.setError(null);
    if (mic.permission !== 'granted') {
      const ok = await mic.authorize();
      if (!ok) {
        tx.setError('Debes autorizar el microfono para iniciar la traduccion.');
        return;
      }
    }
    tx.startSession(tx.mode);
    try {
      await mic.start((b64) => tx.sendAudio(b64));
    } catch (e) {
      tx.setError('No se pudo iniciar la captura de audio.');
      tx.stopSession();
    }
  };

  const onStop = () => {
    mic.stop();
    tx.stopSession();
    stopSpeaking();
    setSpeakingId(null);
    syncRef.current?.post({ kind: 'speak_stop' });
  };

  const onClear = () => {
    tx.clearHistory();
    syncRef.current?.post({ kind: 'clear' });
  };

  const [demoItems, setDemoItems] = useState<HistoryItem[]>([]);
  const allHistory = [...demoItems, ...tx.history];

  const onTestPhrase = () => {
    const item: HistoryItem = {
      id: `demo-${Date.now()}`,
      original: DEMO_PHRASE.original,
      translation: DEMO_PHRASE.translation,
      mode: tx.mode,
      detectedLang: 'en',
      ts: new Date().toISOString(),
    };
    setDemoItems((d) => [item, ...d]);
    syncRef.current?.post({ kind: 'final', item });
    speakItem(item);
  };

  const listening = tx.status === 'listening' || mic.capturing;

  return (
    <div className="min-h-screen bg-acapomil-bg">
      <div className="mx-auto max-w-3xl px-4 py-6 space-y-4">
        <header className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Crest className="w-11 h-11" />
            <div>
              <h1 className="text-lg md:text-xl font-bold tracking-[0.12em]">
                TRADUCTOR ACAPOMIL
              </h1>
            </div>
            <StatusPill status={tx.status} />
          </div>
          <button
            type="button"
            onClick={openProjection}
            className="inline-flex items-center gap-2 rounded-lg border border-acapomil-blue/60 px-3 py-2 text-sm text-sky-300 hover:bg-acapomil-blue/10"
          >
            <Monitor className="h-4 w-4" />
            MODO PROYECCION
          </button>
        </header>

        {tx.error ? (
          <div className="rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            {tx.error}
          </div>
        ) : null}

        {tx.hasApiKey === false ? (
          <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
            El servidor no tiene <code className="text-amber-200">GEMINI_API_KEY</code>. Copia{' '}
            <code>.env.example</code> a <code>.env</code> y agrega tu clave de AI Studio.
          </div>
        ) : null}

        <section className="rounded-2xl border border-acapomil-border bg-acapomil-card p-5 space-y-4">
          <div>
            <p className="mb-2 text-xs font-semibold tracking-wider text-acapomil-muted">
              DISPOSITIVO DE AUDIO / MICROFONO
            </p>
            <div className="flex items-center gap-2">
              <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-acapomil-blue/20 text-sky-300">
                <Mic className="h-5 w-5" />
              </div>
              {mic.permission === 'granted' && mic.devices.length ? (
                <select
                  className="flex-1 rounded-lg border border-acapomil-border bg-[#0d1118] px-3 py-2.5 text-sm"
                  value={mic.deviceId}
                  onChange={(e) => mic.setDeviceId(e.target.value)}
                  disabled={listening}
                >
                  {mic.devices.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || `Microfono ${d.deviceId.slice(0, 6)}`}
                    </option>
                  ))}
                </select>
              ) : (
                <button
                  type="button"
                  onClick={() => mic.authorize()}
                  className="flex-1 inline-flex items-center justify-center gap-2 rounded-lg border border-acapomil-border bg-[#0d1118] px-3 py-2.5 text-sm hover:bg-white/5"
                >
                  <Shield className="h-4 w-4 text-sky-300" />
                  {deviceLabel}
                </button>
              )}
              <button
                type="button"
                onClick={() => mic.refreshDevices()}
                className="rounded-lg border border-acapomil-border p-2.5 hover:bg-white/5"
                title="Actualizar dispositivos"
              >
                <RefreshCw className="h-4 w-4" />
              </button>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2 rounded-xl bg-[#0d1118] p-1">
            {(
              [
                ['en-es', 'INGLES → ESPANOL'],
                ['es-en', 'ESPANOL → INGLES'],
                ['auto', '⇄ AUTO'],
              ] as [TranslateMode, string][]
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                disabled={listening}
                onClick={() => tx.setMode(value)}
                className={`rounded-lg px-2 py-2.5 text-xs md:text-sm font-semibold transition ${
                  tx.mode === value
                    ? 'bg-acapomil-blue text-white shadow'
                    : 'text-acapomil-muted hover:text-white'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {!listening ? (
              <button
                type="button"
                onClick={onStart}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-acapomil-blue hover:bg-acapomil-blue-hover px-4 py-3 font-semibold"
              >
                <Play className="h-5 w-5" />
                INICIAR TRADUCCION
              </button>
            ) : (
              <button
                type="button"
                onClick={onStop}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-red-600 hover:bg-red-500 px-4 py-3 font-semibold"
              >
                <Square className="h-5 w-5" />
                DETENER
              </button>
            )}
            <button
              type="button"
              onClick={openProjection}
              className="inline-flex items-center justify-center gap-2 rounded-xl border border-acapomil-border bg-white/5 px-4 py-3 font-semibold hover:bg-white/10"
            >
              <Monitor className="h-5 w-5" />
              MODO PROYECCION
            </button>
          </div>
          {tx.model ? (
            <p className="text-xs text-acapomil-muted">Modelo Live: {tx.model}</p>
          ) : null}
        </section>

        <section className="flex flex-col md:flex-row md:items-center justify-between gap-3 rounded-xl border border-acapomil-border bg-acapomil-card px-4 py-3">
          <button
            type="button"
            onClick={() => setAutoVoice((v) => !v)}
            className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium ${
              autoVoice
                ? 'border-acapomil-green/50 text-acapomil-green'
                : 'border-white/10 text-acapomil-muted'
            }`}
          >
            <Volume2 className="h-4 w-4" />
            VOZ AUTOMATICA: {autoVoice ? 'ACTIVADA' : 'DESACTIVADA'}
          </button>
          <label className="flex items-center gap-2 text-sm text-acapomil-muted">
            Salida de voz:
            <select
              className="rounded-lg border border-acapomil-border bg-[#0d1118] px-2 py-1.5 text-white"
              value={voiceOut}
              onChange={(e) => setVoiceOut(e.target.value)}
            >
              <option value="es-CL">{voiceLabel('es')}</option>
              <option value="en-US">{voiceLabel('en')}</option>
            </select>
          </label>
        </section>

        <section className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <StatusPill status={tx.status} />
              <h2 className="text-sm font-semibold tracking-wider text-acapomil-muted">
                SUBTITULOS EN TIEMPO REAL
              </h2>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onTestPhrase}
                className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-xs hover:bg-white/5"
              >
                <Sparkles className="h-3.5 w-3.5 text-sky-300" />
                PROBAR FRASE
              </button>
              <button
                type="button"
                onClick={() => tx.copyAll()}
                className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-xs hover:bg-white/5"
                title="Copiar historial"
              >
                <Copy className="h-3.5 w-3.5" />
                Copiar
              </button>
              <button
                type="button"
                onClick={() => {
                  onClear();
                  setDemoItems([]);
                }}
                className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-xs hover:bg-white/5"
              >
                <Eraser className="h-3.5 w-3.5" />
                Limpiar
              </button>
            </div>
          </div>

          {(tx.partial.original || tx.partial.translation) && (
            <article
              className={`rounded-xl border bg-acapomil-card p-4 ${
                speakingId === 'live' ? 'listening-glow border-acapomil-green' : 'border-sky-500/30'
              }`}
            >
              <div className="mb-2 flex items-center justify-between text-xs text-sky-300">
                <span className="font-semibold">EN VIVO</span>
                <button
                  type="button"
                  onClick={speakLive}
                  className="inline-flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-gray-200 hover:bg-white/5"
                >
                  <Volume2 className="h-3.5 w-3.5" />
                  Escuchar subtitulo
                </button>
              </div>
              <p className="text-sm text-gray-400 mb-1">Original</p>
              <p className="text-base text-gray-200 mb-3 whitespace-pre-wrap">
                {tx.partial.original || '…'}
              </p>
              <p className="text-sm text-acapomil-green mb-1">Traduccion</p>
              <p className="text-xl font-medium whitespace-pre-wrap">
                {tx.partial.translation || '…'}
              </p>
            </article>
          )}

          {allHistory.length === 0 && !tx.partial.original && !tx.partial.translation ? (
            <div className="rounded-xl border border-dashed border-acapomil-border px-4 py-10 text-center text-acapomil-muted text-sm">
              Los subtitulos originales y traducidos apareceran aqui al hablar.
            </div>
          ) : null}

          <div className="space-y-3">
            {allHistory.map((item) => (
              <HistoryCard
                key={item.id}
                item={item}
                speakingId={speakingId}
                onSpeak={speakItem}
              />
            ))}
          </div>
        </section>

        <footer className="pt-4 pb-8 text-center text-xs text-acapomil-muted">
          Mic PCM 16 kHz → Gemini Live → WebSocket → UI · TTS opcional con speechSynthesis
        </footer>
      </div>
    </div>
  );
}
