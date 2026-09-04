import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeftRight,
  Copy,
  Mic,
  Monitor,
  Play,
  RefreshCw,
  Shield,
  Smartphone,
  Square,
} from 'lucide-react';
import { Crest } from './components/Crest';
import { StatusPill } from './components/StatusPill';
import { ProjectionView } from './components/ProjectionView';
import { MicView } from './components/MicView';
import { useMicCapture } from './hooks/useMicCapture';
import { useTranslatorSocket } from './hooks/useTranslatorSocket';
import { createSyncChannel } from './lib/broadcast';
import { useSubtitleDisplay } from './lib/subtitleDisplay';
import type { SourceLang, TargetLang } from './lib/types';
import { deriveMode } from './lib/types';
import { isValidTranslationText, stopSpeaking } from './lib/tts';
import { resolveMicUrl, resolveProjectionUrl } from './lib/projectionUrl';

function isProjectionRoute() {
  const q = new URLSearchParams(window.location.search);
  if (window.location.hash.includes('projection')) return true;
  return window.location.pathname.includes('projection') || q.get('mode') === 'projection';
}

function isMicRoute() {
  const q = new URLSearchParams(window.location.search);
  if (window.location.hash === '#/mic' || window.location.hash.includes('mic')) return true;
  return window.location.pathname.includes('/mic') || q.get('mode') === 'mic';
}

const SOURCE_OPTIONS: { value: SourceLang; label: string }[] = [
  { value: 'auto', label: 'Conversación (EN ↔ ES)' },
  { value: 'en', label: 'Inglés (solo un sentido →)' },
  { value: 'es', label: 'Español (solo un sentido →)' },
];

const TARGET_OPTIONS: { value: TargetLang; label: string }[] = [
  { value: 'es', label: 'Español (audiencia)' },
  { value: 'en', label: 'Inglés (audiencia)' },
];

export default function App() {
  if (isProjectionRoute()) return <ProjectionView />;
  if (isMicRoute()) return <MicView />;
  return <ControlPanel />;
}

function ControlPanel() {
  const mic = useMicCapture();
  const tx = useTranslatorSocket();
  const [sourceLang, setSourceLang] = useState<SourceLang>('auto');
  const [targetLang, setTargetLang] = useState<TargetLang>('es');
  const syncRef = useRef<ReturnType<typeof createSyncChannel> | null>(null);
  const [projectionUrl, setProjectionUrl] = useState('');
  const [micUrl, setMicUrl] = useState('');
  const [copiedTv, setCopiedTv] = useState(false);
  const [copiedMic, setCopiedMic] = useState(false);
  /** When false, Mac does not capture local mic — use iPhone remote mic instead */
  const [useMacMic, setUseMacMic] = useState(true);

  const mode = useMemo(() => deriveMode(sourceLang, targetLang), [sourceLang, targetLang]);

  const applyLangPair = (nextSource: SourceLang, nextTarget: TargetLang) => {
    let src = nextSource;
    let tgt = nextTarget;
    if (src !== 'auto' && src === tgt) {
      tgt = src === 'es' ? 'en' : 'es';
    }
    setSourceLang(src);
    setTargetLang(tgt);
    const m = deriveMode(src, tgt);
    tx.setMode(m, tgt);
  };

  const onSourceChange = (value: SourceLang) => {
    applyLangPair(value, targetLang);
  };

  const onTargetChange = (value: TargetLang) => {
    if (sourceLang !== 'auto' && sourceLang === value) {
      applyLangPair(value === 'es' ? 'en' : 'es', value);
      return;
    }
    applyLangPair(sourceLang, value);
  };

  const onSwapLanguages = () => {
    if (sourceLang === 'auto') {
      const newSource: SourceLang = targetLang;
      const newTarget: TargetLang = targetLang === 'es' ? 'en' : 'es';
      applyLangPair(newSource, newTarget);
      return;
    }
    const newSource: SourceLang = targetLang;
    const newTarget: TargetLang = sourceLang === 'es' ? 'es' : 'en';
    applyLangPair(newSource, newTarget);
  };

  useEffect(() => {
    syncRef.current = createSyncChannel((msg) => {
      if (msg.kind === 'ping') {
        syncRef.current?.post({ kind: 'status', status: tx.status, mode });
        syncRef.current?.post({ kind: 'partial', partial: tx.partial, mode });
        syncRef.current?.post({ kind: 'history', items: tx.history });
      }
    });
    return () => {
      syncRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([resolveProjectionUrl(), resolveMicUrl()]).then(([tv, mic]) => {
      if (!cancelled) {
        setProjectionUrl(tv);
        setMicUrl(mic);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    syncRef.current?.post({ kind: 'status', status: tx.status, mode });
  }, [tx.status, mode]);

  useEffect(() => {
    syncRef.current?.post({ kind: 'partial', partial: tx.partial, mode });
  }, [tx.partial, mode]);

  useEffect(() => {
    const newest = tx.history[0];
    if (!newest) return;
    syncRef.current?.post({ kind: 'final', item: newest });
  }, [tx.history]);

  useEffect(() => {
    if (tx.mode === 'en-es') {
      setSourceLang('en');
      setTargetLang('es');
    } else if (tx.mode === 'es-en') {
      setSourceLang('es');
      setTargetLang('en');
    } else if (tx.mode === 'auto') {
      setSourceLang('auto');
      if (tx.targetLang === 'en' || tx.targetLang === 'es') {
        setTargetLang(tx.targetLang);
      }
    }
  }, [tx.mode, tx.targetLang]);

  const deviceLabel = useMemo(() => {
    if (mic.permission === 'denied') return 'Micrófono denegado por el navegador';
    if (mic.permission !== 'granted' || !mic.devices.length) {
      return 'AUTORIZAR ACCESO AL MICRÓFONO';
    }
    const d = mic.devices.find((x) => x.deviceId === mic.deviceId);
    return d?.label || 'Micrófono predeterminado';
  }, [mic]);

  const openProjection = () => {
    const url = projectionUrl || `${window.location.origin}/?mode=projection`;
    window.open(url, 'traductor-acapomil-projection', 'noopener,noreferrer');
  };

  const copyTvUrl = async () => {
    const url = projectionUrl || (await resolveProjectionUrl());
    setProjectionUrl(url);
    try {
      await navigator.clipboard.writeText(url);
      setCopiedTv(true);
      window.setTimeout(() => setCopiedTv(false), 2000);
    } catch {
      // Fallback for older TV remotes / restricted clipboard
      window.prompt('Copia esta URL para la TV:', url);
    }
  };

  const copyMicUrl = async () => {
    const url = micUrl || (await resolveMicUrl());
    setMicUrl(url);
    try {
      await navigator.clipboard.writeText(url);
      setCopiedMic(true);
      window.setTimeout(() => setCopiedMic(false), 2000);
    } catch {
      window.prompt('Copia esta URL para el micrófono del iPhone:', url);
    }
  };

  const onStart = async () => {
    tx.setError(null);
    if (useMacMic) {
      if (mic.permission !== 'granted') {
        const ok = await mic.authorize();
        if (!ok) {
          tx.setError(
            'Debes autorizar el micrófono del Mac, o desactiva «Micrófono local del Mac» y usa la URL de micrófono en el iPhone.'
          );
          return;
        }
      }
    }
    tx.startSession(mode, targetLang);
    if (!useMacMic) {
      // Remote iPhone mic will feed the shared live session
      return;
    }
    try {
      await mic.start((b64) => tx.sendAudio(b64));
    } catch {
      tx.setError('No se pudo iniciar la captura de audio.');
      tx.stopSession();
    }
  };

  const onStop = () => {
    mic.stop();
    tx.stopSession();
    stopSpeaking(); // safety cancel if any leftover TTS
    syncRef.current?.post({ kind: 'speak_stop' });
  };

  const listening = tx.status === 'listening' || tx.status === 'connecting' || mic.capturing;

  const pairLabel =
    sourceLang === 'auto'
      ? `CONVERSACIÓN EN ↔ ES · audiencia ${targetLang === 'es' ? 'ES' : 'EN'}`
      : `${sourceLang === 'es' ? 'ES' : 'EN'} → ${targetLang === 'es' ? 'ES' : 'EN'} (un sentido)`;

  // Live hero only — history kept in memory for sync, not rendered
  const liveOriginal = tx.partial.original || tx.history[0]?.original || '';
  const rawLiveTranslation = tx.partial.translation || tx.history[0]?.translation || '';
  const liveTranslation = isValidTranslationText(rawLiveTranslation) ? rawLiveTranslation : '';
  const subtitle = useSubtitleDisplay(liveOriginal, liveTranslation);

  return (
    <div className="min-h-screen bg-acapomil-bg">
      <div className="mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8 py-6 space-y-5">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Crest className="w-11 h-11" />
            <div>
              <h1 className="text-lg md:text-xl font-bold tracking-[0.12em]">
                TRADUCTOR ACAPOMIL
              </h1>
            </div>
            <StatusPill status={tx.status} />
          </div>
        </header>

        {tx.error || tx.status === 'disconnected' ? (
          <div className="rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200 flex flex-wrap items-center justify-between gap-3">
            <span>
              {tx.error ||
                'Desconectado del servidor de traducción. Reconecta para continuar.'}
            </span>
            <button
              type="button"
              onClick={() => tx.reconnect()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-red-400/40 px-3 py-1.5 text-xs font-semibold text-red-100 hover:bg-red-500/20"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Reconectar
            </button>
          </div>
        ) : null}

        {tx.hasApiKey === false ? (
          <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
            El servidor no tiene <code className="text-amber-200">GEMINI_API_KEY</code>. Copia{' '}
            <code>.env.example</code> a <code>.env</code> y agrega tu clave de AI Studio.
          </div>
        ) : null}

        <section className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <StatusPill status={tx.status} />
            <h2 className="text-sm font-semibold tracking-wider text-acapomil-muted">
              SUBTÍTULOS EN TIEMPO REAL
            </h2>
          </div>

          <article
            className={`relative w-full min-h-[40vh] md:min-h-[44vh] rounded-2xl border overflow-hidden flex flex-col ${
              tx.partial.original || liveTranslation || tx.history[0]
                ? 'border-sky-500/40'
                : 'border-acapomil-border'
            }`}
          >
            <div className="absolute inset-0 bg-gradient-to-b from-[#0a0e14] via-[#0d1118] to-[#080b10]" />
            <div className="absolute inset-x-0 bottom-0 h-2/3 bg-black/55 backdrop-blur-[2px]" />
            <div className="relative z-10 flex flex-1 flex-col">
              <div className="flex items-center justify-between gap-3 px-4 sm:px-6 pt-4 pb-2 text-xs text-sky-300">
                <span className="font-semibold tracking-wider">
                  EN VIVO · {pairLabel}
                </span>
                {subtitle.showTranslatingBadge ? (
                  <span className="rounded-md border border-sky-500/30 bg-sky-500/10 px-2 py-1 text-sky-200">
                    traduciendo…
                  </span>
                ) : null}
              </div>

              <div className="flex flex-1 flex-col items-center justify-end px-4 sm:px-8 md:px-12 pb-8 md:pb-10 pt-6 text-center">
                {subtitle.largeText || liveOriginal ? (
                  <>
                    {subtitle.originalLine ? (
                      <p
                        className="w-full max-w-5xl text-gray-400/90 mb-3 md:mb-4 whitespace-pre-wrap break-words leading-relaxed"
                        style={{
                          fontSize: 'clamp(0.95rem, 1.4vw + 0.4rem, 1.35rem)',
                        }}
                      >
                        {subtitle.originalLine}
                      </p>
                    ) : null}
                    <div className="w-full max-w-6xl rounded-xl bg-black/45 px-4 py-5 md:px-8 md:py-7 border border-white/5 shadow-[0_8px_40px_rgba(0,0,0,0.45)]">
                      <p
                        className="font-semibold text-white whitespace-pre-wrap break-words"
                        style={{
                          fontSize: 'clamp(1.75rem, 4vw, 3.5rem)',
                          lineHeight: 1.35,
                        }}
                      >
                        {subtitle.largeText || '…'}
                      </p>
                    </div>
                  </>
                ) : (
                  <div className="flex flex-1 w-full flex-col items-center justify-center py-10 md:py-16">
                    <div className="w-full max-w-4xl rounded-xl bg-black/35 border border-white/5 px-6 py-12 md:py-16">
                      <p
                        className="text-gray-500 font-medium tracking-wide"
                        style={{ fontSize: 'clamp(1.25rem, 2.5vw, 2rem)' }}
                      >
                        Escenario de subtítulos
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </article>
        </section>

        <section className="rounded-2xl border border-acapomil-border bg-acapomil-card p-5 md:p-6 space-y-4">
          <div>
            <p className="mb-2 text-xs font-semibold tracking-wider text-acapomil-muted">
              IDIOMAS (SOLO ESPAÑOL ↔ INGLÉS)
            </p>
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 sm:gap-3">
              <label className="flex-1 min-w-0">
                <span className="sr-only">Idioma de origen</span>
                <select
                  className="w-full rounded-xl border border-acapomil-border bg-[#0d1118] px-3 py-3 text-sm font-medium"
                  value={sourceLang}
                  disabled={listening}
                  onChange={(e) => onSourceChange(e.target.value as SourceLang)}
                >
                  {SOURCE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>

              <button
                type="button"
                disabled={listening}
                onClick={onSwapLanguages}
                className="inline-flex items-center justify-center self-center rounded-full border border-acapomil-border bg-[#0d1118] p-2.5 text-sky-300 hover:bg-white/5 disabled:opacity-50"
                title="Intercambiar idiomas"
                aria-label="Intercambiar idiomas"
              >
                <ArrowLeftRight className="h-5 w-5" />
              </button>

              <label className="flex-1 min-w-0">
                <span className="sr-only">Idioma de destino / sesgo audiencia</span>
                <select
                  className="w-full rounded-xl border border-acapomil-border bg-[#0d1118] px-3 py-3 text-sm font-medium"
                  value={targetLang}
                  disabled={listening}
                  onChange={(e) => onTargetChange(e.target.value as TargetLang)}
                >
                  {TARGET_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p className="mt-2 text-xs text-acapomil-muted">
              Modo:{' '}
              <span className="text-sky-300 font-semibold">{mode}</span>
              {mode === 'auto' ? (
                <>
                  {' '}
                  · conversación bidireccional · audiencia:{' '}
                  <span className="text-sky-300 font-semibold">
                    {targetLang === 'es' ? 'español' : 'inglés'}
                  </span>
                </>
              ) : (
                <> · solo un sentido</>
              )}
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {!listening ? (
              <button
                type="button"
                onClick={onStart}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-acapomil-blue hover:bg-acapomil-blue-hover px-4 py-3 font-semibold"
              >
                <Play className="h-5 w-5" />
                INICIAR TRADUCCIÓN
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
              MODO PROYECCIÓN
            </button>
          </div>

          <div className="rounded-xl border border-acapomil-border bg-[#0d1118] p-3 space-y-3">
            <div className="space-y-2">
              <p className="text-xs font-semibold tracking-wider text-acapomil-muted">
                URL DE PROYECCIÓN (TV · MISMA WIFI)
              </p>
              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  readOnly
                  value={projectionUrl || 'Detectando IP de red local…'}
                  className="flex-1 min-w-0 rounded-lg border border-acapomil-border bg-black/40 px-3 py-2 text-xs sm:text-sm font-mono text-sky-200"
                  onFocus={(e) => e.target.select()}
                />
                <button
                  type="button"
                  onClick={() => void copyTvUrl()}
                  disabled={!projectionUrl}
                  className="inline-flex items-center justify-center gap-2 rounded-lg border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-sm font-semibold text-sky-100 hover:bg-sky-500/20 disabled:opacity-50"
                >
                  <Copy className="h-4 w-4" />
                  {copiedTv ? 'Copiado' : 'Copiar URL TV'}
                </button>
              </div>
              <p className="text-xs text-acapomil-muted">
                Abre esta URL en el navegador del Samsung TV (misma WiFi). Sin HDMI.
              </p>
            </div>

            <div className="border-t border-acapomil-border pt-3 space-y-2">
              <p className="text-xs font-semibold tracking-wider text-acapomil-muted flex items-center gap-1.5">
                <Smartphone className="h-3.5 w-3.5" />
                URL DE MICRÓFONO (iPHONE · MISMA WIFI)
              </p>
              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  readOnly
                  value={micUrl || 'Detectando IP de red local…'}
                  className="flex-1 min-w-0 rounded-lg border border-acapomil-border bg-black/40 px-3 py-2 text-xs sm:text-sm font-mono text-emerald-200"
                  onFocus={(e) => e.target.select()}
                />
                <button
                  type="button"
                  onClick={() => void copyMicUrl()}
                  disabled={!micUrl}
                  className="inline-flex items-center justify-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm font-semibold text-emerald-100 hover:bg-emerald-500/20 disabled:opacity-50"
                >
                  <Copy className="h-4 w-4" />
                  {copiedMic ? 'Copiado' : 'Copiar URL mic'}
                </button>
              </div>
              <p className="text-xs text-acapomil-muted">
                Abre en Safari del iPhone (otra habitación). Permite mic → Enviar audio. Mac inicia la traducción; TV muestra subtítulos.
              </p>
            </div>
          </div>

          {tx.model ? (
            <p className="text-xs text-acapomil-muted">Modelo Live: {tx.model}</p>
          ) : null}
        </section>

        <section className="rounded-2xl border border-acapomil-border bg-acapomil-card p-5 md:p-6">
          <p className="mb-2 text-xs font-semibold tracking-wider text-acapomil-muted">
            DISPOSITIVO DE AUDIO / MICRÓFONO
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-acapomil-blue/20 text-sky-300">
              <Mic className="h-5 w-5" />
            </div>
            {mic.permission === 'granted' && mic.devices.length ? (
              <select
                className="flex-1 min-w-[12rem] rounded-lg border border-acapomil-border bg-[#0d1118] px-3 py-2.5 text-sm"
                value={
                  mic.devices.some((d) => d.deviceId === mic.deviceId)
                    ? mic.deviceId
                    : ''
                }
                onChange={(e) => mic.setDeviceId(e.target.value)}
                onFocus={() => {
                  void mic.refreshDevices();
                }}
                disabled={listening}
              >
                {mic.devices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `Micrófono ${d.deviceId.slice(0, 6)}`}
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
              onClick={() => {
                void mic.refreshDevices();
              }}
              className="rounded-lg border border-acapomil-border p-2.5 hover:bg-white/5"
              title="Actualizar dispositivos"
            >
              <RefreshCw className="h-4 w-4" />
            </button>
          </div>
          <label className="mt-3 flex items-start gap-2 text-sm cursor-pointer select-none">
            <input
              type="checkbox"
              className="mt-1 rounded border-acapomil-border"
              checked={useMacMic}
              disabled={listening}
              onChange={(e) => setUseMacMic(e.target.checked)}
            />
            <span>
              <span className="font-medium">Micrófono local del Mac</span>
              <span className="block text-xs text-acapomil-muted mt-0.5">
                Desactívalo si vas a usar solo el iPhone (URL mic). Así el Mac no captura audio local.
              </span>
            </span>
          </label>
          <p className="mt-2 text-xs text-acapomil-muted">
            Preferido: iPhone con URL de micrófono en la sala de presentación (misma WiFi). Continuity no hace falta.
          </p>
        </section>
      </div>
    </div>
  );
}
