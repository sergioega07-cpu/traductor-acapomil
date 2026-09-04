import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeftRight,
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
import type { HistoryItem, SourceLang, TargetLang } from './lib/types';
import { deriveMode } from './lib/types';
import {
  formatVoiceOption,
  langForTranslation,
  normalizeSpeakText,
  pickVoice,
  shouldSkipDuplicateSpeak,
  shouldWaitForRealTranslation,
  speakText,
  stopSpeaking,
  textsLookIdentical,
  isSpeaking,
  voicesForLang,
  waitForVoices,
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

const VOICE_URI_KEY = 'acapomil-tts-voice-uri';

const SOURCE_OPTIONS: { value: SourceLang; label: string }[] = [
  { value: 'auto', label: 'Detectar idioma' },
  { value: 'es', label: 'Español' },
  { value: 'en', label: 'Inglés' },
];

const TARGET_OPTIONS: { value: TargetLang; label: string }[] = [
  { value: 'es', label: 'Español' },
  { value: 'en', label: 'Inglés' },
];

export default function App() {
  if (isProjectionRoute()) return <ProjectionView />;
  return <ControlPanel />;
}

function ControlPanel() {
  const mic = useMicCapture();
  const tx = useTranslatorSocket();
  const [sourceLang, setSourceLang] = useState<SourceLang>('en');
  const [targetLang, setTargetLang] = useState<TargetLang>('es');
  const [autoVoice, setAutoVoice] = useState(true);
  const [voiceLang, setVoiceLang] = useState('es-CL');
  const [voiceURI, setVoiceURI] = useState<string>(() => {
    try {
      return localStorage.getItem(VOICE_URI_KEY) || '';
    } catch {
      return '';
    }
  });
  const [voiceOptions, setVoiceOptions] = useState<SpeechSynthesisVoice[]>([]);
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [followSpeak, setFollowSpeak] = useState(false);
  const [noSubtitleHint, setNoSubtitleHint] = useState(false);
  const syncRef = useRef<ReturnType<typeof createSyncChannel> | null>(null);
  const lastAutoId = useRef<string | null>(null);
  const listeningSinceRef = useRef<number | null>(null);
  const followDebounceRef = useRef<number | null>(null);
  const lastFollowSpokenRef = useRef('');
  const followSpeakRef = useRef(false);
  followSpeakRef.current = followSpeak;

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
      // Si el origen igualaría al destino, intercambiar origen al otro idioma
      applyLangPair(value === 'es' ? 'en' : 'es', value);
      return;
    }
    applyLangPair(sourceLang, value);
  };

  const onSwapLanguages = () => {
    if (sourceLang === 'auto') {
      // Estilo Google: el destino pasa a origen; el otro idioma a destino
      const newSource: SourceLang = targetLang;
      const newTarget: TargetLang = targetLang === 'es' ? 'en' : 'es';
      applyLangPair(newSource, newTarget);
      return;
    }
    const newSource: SourceLang = targetLang;
    const newTarget: TargetLang = sourceLang === 'es' ? 'es' : 'en';
    applyLangPair(newSource, newTarget);
  };

  const refreshVoiceList = (lang: string, preferred?: string) => {
    const ranked = voicesForLang(lang);
    setVoiceOptions(ranked);
    const pref = preferred ?? voiceURI;
    if (pref && ranked.some((v) => v.voiceURI === pref)) {
      setVoiceURI(pref);
      return;
    }
    const best = pickVoice(lang, pref || null);
    if (best) {
      setVoiceURI(best.voiceURI);
      try {
        localStorage.setItem(VOICE_URI_KEY, best.voiceURI);
      } catch {
        /* ignore */
      }
    } else {
      setVoiceURI('');
    }
  };

  useEffect(() => {
    let cancelled = false;
    const boot = async () => {
      await waitForVoices();
      if (cancelled) return;
      const lang = langForTranslation(mode, undefined, targetLang);
      setVoiceLang(lang);
      refreshVoiceList(lang);
    };
    void boot();

    const s = window.speechSynthesis;
    const onChange = () => {
      if (cancelled) return;
      refreshVoiceList(voiceLang || langForTranslation(mode, undefined, targetLang));
    };
    s?.addEventListener?.('voiceschanged', onChange);
    return () => {
      cancelled = true;
      s?.removeEventListener?.('voiceschanged', onChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clearFollowDebounce = () => {
    if (followDebounceRef.current != null) {
      window.clearTimeout(followDebounceRef.current);
      followDebounceRef.current = null;
    }
  };

  const stopFollowSpeaking = () => {
    clearFollowDebounce();
    stopSpeaking();
    setSpeakingId(null);
    lastFollowSpokenRef.current = '';
  };

  const setFollowSpeakSynced = (on: boolean, broadcast: boolean) => {
    setFollowSpeak(on);
    followSpeakRef.current = on;
    if (on) {
      // Mutual exclusion: sticky listen owns the only speaking path
      setAutoVoice(false);
    }
    if (!on) stopFollowSpeaking();
    if (broadcast) {
      syncRef.current?.post({ kind: 'speak_follow', on });
      if (!on) syncRef.current?.post({ kind: 'speak_stop' });
    }
  };

  const setAutoVoiceExclusive = (on: boolean) => {
    if (on && followSpeakRef.current) {
      setFollowSpeakSynced(false, true);
    }
    setAutoVoice(on);
  };

  useEffect(() => {
    syncRef.current = createSyncChannel((msg) => {
      if (msg.kind === 'ping') {
        syncRef.current?.post({ kind: 'status', status: tx.status, mode });
        syncRef.current?.post({ kind: 'partial', partial: tx.partial, mode });
        syncRef.current?.post({ kind: 'history', items: tx.history });
        syncRef.current?.post({ kind: 'speak_follow', on: followSpeakRef.current });
      } else if (msg.kind === 'speak_follow') {
        setFollowSpeakSynced(msg.on, false);
      }
    });
    return () => {
      clearFollowDebounce();
      syncRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync projection window
  useEffect(() => {
    syncRef.current?.post({ kind: 'status', status: tx.status, mode });
  }, [tx.status, mode]);

  useEffect(() => {
    syncRef.current?.post({ kind: 'partial', partial: tx.partial, mode });
  }, [tx.partial, mode]);

  const modeRef = useRef(mode);
  const targetLangRef = useRef(targetLang);
  const voiceURIRef = useRef(voiceURI);
  const historyRef = useRef(tx.history);
  modeRef.current = mode;
  targetLangRef.current = targetLang;
  voiceURIRef.current = voiceURI;
  historyRef.current = tx.history;

  const speakFollowLatest = (
    text: string,
    immediate: boolean,
    opts?: { isFinal?: boolean; original?: string }
  ) => {
    const t = text.trim();
    if (!t || !followSpeakRef.current) return;

    // Sticky path: translation only — never fall back to original
    if (
      shouldWaitForRealTranslation(
        modeRef.current,
        opts?.original,
        t,
        targetLangRef.current
      )
    ) {
      return;
    }

    const midSpeak = isSpeaking() || speakingId != null;
    if (
      shouldSkipDuplicateSpeak(t, lastFollowSpokenRef.current, {
        midSpeak,
        isFinal: opts?.isFinal,
      })
    ) {
      return;
    }

    const run = () => {
      if (!followSpeakRef.current) return;
      if (
        shouldWaitForRealTranslation(
          modeRef.current,
          opts?.original,
          t,
          targetLangRef.current
        )
      ) {
        return;
      }
      if (
        shouldSkipDuplicateSpeak(t, lastFollowSpokenRef.current, {
          midSpeak: true,
          isFinal: opts?.isFinal,
        })
      ) {
        return;
      }
      // Interrupt-to-latest: speakText cancels queue + in-flight TTS
      lastFollowSpokenRef.current = normalizeSpeakText(t);
      const hist0 = historyRef.current[0];
      const lang = langForTranslation(
        modeRef.current,
        hist0?.detectedLang,
        targetLangRef.current
      );
      setSpeakingId('live');
      // Local TTS only — projection mirrors via speak_follow + its own follow effect
      speakText(
        t,
        lang,
        () => setSpeakingId('live'),
        () => setSpeakingId((id) => (id === 'live' ? null : id)),
        voiceURIRef.current || null
      );
    };

    clearFollowDebounce();
    if (immediate) {
      run();
    } else {
      followDebounceRef.current = window.setTimeout(run, 500);
    }
  };

  // When sticky listen turns ON (local or via BroadcastChannel), speak current caption
  const wasFollowSpeakRef = useRef(false);
  useEffect(() => {
    if (followSpeak && !wasFollowSpeakRef.current) {
      const text = (tx.partial.translation || tx.history[0]?.translation || '').trim();
      const original = (tx.partial.original || tx.history[0]?.original || '').trim();
      if (text) {
        lastFollowSpokenRef.current = '';
        speakFollowLatest(text, true, { isFinal: true, original });
      }
    }
    wasFollowSpeakRef.current = followSpeak;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followSpeak]);

  // Sticky listen: debounced partial translations only (never original)
  useEffect(() => {
    if (!followSpeak) return;
    const text = tx.partial.translation?.trim();
    if (!text) return;
    speakFollowLatest(text, false, {
      isFinal: false,
      original: tx.partial.original,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tx.partial.translation, followSpeak]);

  useEffect(() => {
    const newest = tx.history[0];
    if (!newest) return;
    syncRef.current?.post({ kind: 'final', item: newest });
    if (newest.id === lastAutoId.current) return;
    if (!newest.translation?.trim()) return;

    // Only ONE speaking path: sticky wins over autoVoice
    if (followSpeak) {
      lastAutoId.current = newest.id;
      speakFollowLatest(newest.translation, true, {
        isFinal: true,
        original: newest.original,
      });
    } else if (autoVoice) {
      lastAutoId.current = newest.id;
      speakItem(newest);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tx.history, autoVoice, followSpeak]);

  useEffect(() => {
    const lang = langForTranslation(mode, undefined, targetLang);
    setVoiceLang(lang);
    refreshVoiceList(lang);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, targetLang]);

  // Mantener UI alineada si el servidor reporta otro modo
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

  // Soft hint: listening but no partial subtitles for 8s
  useEffect(() => {
    const active = tx.status === 'listening' || mic.capturing;
    const hasPartial = Boolean(tx.partial.original || tx.partial.translation);
    if (!active) {
      listeningSinceRef.current = null;
      setNoSubtitleHint(false);
      return;
    }
    if (hasPartial) {
      listeningSinceRef.current = null;
      setNoSubtitleHint(false);
      return;
    }
    if (listeningSinceRef.current == null) {
      listeningSinceRef.current = Date.now();
    }
    const elapsed = Date.now() - listeningSinceRef.current;
    const remain = Math.max(0, 8000 - elapsed);
    const t = window.setTimeout(() => {
      if (!(tx.partial.original || tx.partial.translation)) {
        setNoSubtitleHint(true);
      }
    }, remain);
    return () => window.clearTimeout(t);
  }, [tx.status, mic.capturing, tx.partial.original, tx.partial.translation]);

  const deviceLabel = useMemo(() => {
    if (mic.permission === 'denied') return 'Micrófono denegado por el navegador';
    if (mic.permission !== 'granted' || !mic.devices.length) {
      return 'AUTORIZAR ACCESO AL MICRÓFONO';
    }
    const d = mic.devices.find((x) => x.deviceId === mic.deviceId);
    return d?.label || 'Micrófono predeterminado';
  }, [mic]);

  const openProjection = () => {
    const url = `${window.location.origin}${window.location.pathname}?mode=projection`;
    window.open(url, 'traductor-acapomil-projection', 'noopener,noreferrer');
  };

  const speakItem = (item: HistoryItem) => {
    if (followSpeakRef.current) return; // sticky owns the only path
    const translation = item.translation?.trim();
    if (!translation) return;
    if (
      shouldWaitForRealTranslation(item.mode, item.original, translation, targetLang)
    ) {
      return;
    }
    if (
      shouldSkipDuplicateSpeak(translation, lastFollowSpokenRef.current, {
        isFinal: true,
      })
    ) {
      return;
    }
    const lang = langForTranslation(item.mode, item.detectedLang, targetLang);
    setVoiceLang(lang);
    setSpeakingId(item.id);
    lastFollowSpokenRef.current = normalizeSpeakText(translation);
    syncRef.current?.post({ kind: 'speak', text: translation, lang, id: item.id });
    // speakText always stopSpeaking()/cancels queue before a new utterance
    speakText(
      translation,
      lang,
      () => setSpeakingId(item.id),
      () => setSpeakingId(null),
      voiceURI || null
    );
  };

  const toggleFollowSpeak = () => {
    if (followSpeak) {
      setFollowSpeakSynced(false, true);
      return;
    }
    setFollowSpeakSynced(true, true);
  };

  const onStart = async () => {
    tx.setError(null);
    if (mic.permission !== 'granted') {
      const ok = await mic.authorize();
      if (!ok) {
        tx.setError('Debes autorizar el micrófono para iniciar la traducción.');
        return;
      }
    }
    tx.startSession(mode, targetLang);
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
    // Always clear sticky follow + TTS queue / interval / lastSpoken
    setFollowSpeakSynced(false, true);
    stopSpeaking();
    setSpeakingId(null);
    lastFollowSpokenRef.current = '';
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
      mode,
      detectedLang: 'en',
      ts: new Date().toISOString(),
    };
    setDemoItems((d) => [item, ...d]);
    syncRef.current?.post({ kind: 'final', item });
    speakItem(item);
  };

  const onVoiceSelect = (uri: string) => {
    setVoiceURI(uri);
    try {
      localStorage.setItem(VOICE_URI_KEY, uri);
    } catch {
      /* ignore */
    }
  };

  const listening = tx.status === 'listening' || mic.capturing;

  const pairLabel =
    sourceLang === 'auto'
      ? `AUTO → ${targetLang === 'es' ? 'ESPAÑOL' : 'INGLÉS'}`
      : `${sourceLang === 'es' ? 'ESPAÑOL' : 'INGLÉS'} → ${targetLang === 'es' ? 'ESPAÑOL' : 'INGLÉS'}`;

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
          <div className="flex flex-col items-end gap-1">
            <button
              type="button"
              onClick={openProjection}
              className="inline-flex items-center gap-2 rounded-lg border border-acapomil-blue/60 px-3 py-2 text-sm text-sky-300 hover:bg-acapomil-blue/10"
            >
              <Monitor className="h-4 w-4" />
              MODO PROYECCIÓN
            </button>
            <p className="max-w-[260px] text-right text-[11px] leading-snug text-acapomil-muted">
              Úsalo en el televisor/proyector a pantalla completa (F11).
            </p>
          </div>
        </header>

        {tx.error || tx.status === 'disconnected' ? (
          <div className="rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200 flex flex-wrap items-center justify-between gap-3">
            <span>
              {tx.error ||
                'Desconectado del servidor de traducción. Puedes seguir viendo el historial de subtítulos.'}
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

        {/* 1) SUBTÍTULOS EN TIEMPO REAL — arriba */}
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <StatusPill status={tx.status} />
              <h2 className="text-sm font-semibold tracking-wider text-acapomil-muted">
                SUBTÍTULOS EN TIEMPO REAL
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

          {/* Hero live subtitle stage — cinema caption style */}
          <article
            className={`relative w-full min-h-[40vh] md:min-h-[44vh] rounded-2xl border overflow-hidden flex flex-col ${
              followSpeak || speakingId === 'live'
                ? 'listening-glow border-acapomil-green'
                : tx.partial.original || tx.partial.translation || allHistory[0]
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
                <button
                  type="button"
                  onClick={toggleFollowSpeak}
                  disabled={
                    !followSpeak && !(tx.partial.translation || allHistory[0]?.translation)
                  }
                  className={`inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 disabled:opacity-40 ${
                    followSpeak
                      ? 'listening-glow border-acapomil-green text-acapomil-green'
                      : 'border-white/15 text-gray-200 hover:bg-white/5'
                  }`}
                >
                  <Volume2 className="h-3.5 w-3.5" />
                  {followSpeak ? 'Cancelar escucha' : 'Escuchar subtítulo'}
                </button>
              </div>

              <div className="flex flex-1 flex-col items-center justify-end px-4 sm:px-8 md:px-12 pb-8 md:pb-10 pt-6 text-center">
                {tx.partial.original || tx.partial.translation || allHistory[0] ? (
                  <>
                    {(() => {
                      const liveOriginal =
                        tx.partial.original || allHistory[0]?.original || '';
                      const liveTranslation =
                        tx.partial.translation || allHistory[0]?.translation || '';
                      const identical =
                        Boolean(liveOriginal.trim()) &&
                        textsLookIdentical(liveOriginal, liveTranslation);
                      return (
                        <>
                          {!identical ? (
                            <p
                              className="w-full max-w-5xl text-gray-400/90 mb-3 md:mb-4 whitespace-pre-wrap break-words leading-relaxed"
                              style={{
                                fontSize: 'clamp(0.95rem, 1.4vw + 0.4rem, 1.35rem)',
                              }}
                            >
                              {liveOriginal || '…'}
                            </p>
                          ) : (
                            <p
                              className="w-full max-w-5xl text-gray-400/90 mb-3 md:mb-4 whitespace-pre-wrap break-words leading-relaxed"
                              style={{
                                fontSize: 'clamp(0.95rem, 1.4vw + 0.4rem, 1.35rem)',
                              }}
                            >
                              {liveOriginal}
                              <span className="ml-2 text-sky-400/80 font-medium">
                                · traduciendo…
                              </span>
                            </p>
                          )}
                          <div className="w-full max-w-6xl rounded-xl bg-black/45 px-4 py-5 md:px-8 md:py-7 border border-white/5 shadow-[0_8px_40px_rgba(0,0,0,0.45)]">
                            <p
                              className="font-semibold text-white whitespace-pre-wrap break-words"
                              style={{
                                fontSize: 'clamp(1.75rem, 4vw, 3.5rem)',
                                lineHeight: 1.35,
                              }}
                            >
                              {identical
                                ? 'traduciendo…'
                                : liveTranslation || '…'}
                            </p>
                          </div>
                        </>
                      );
                    })()}
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
                      <p className="mt-3 text-sm md:text-base text-acapomil-muted">
                        Los subtítulos originales y traducidos aparecerán aquí al hablar — estilo cine.
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </article>

          {noSubtitleHint ? (
            <div className="rounded-xl border border-sky-500/30 bg-sky-500/10 px-4 py-3 text-sm text-sky-100">
              Hablando… si no aparece texto, prueba otro mic o Reconectar
            </div>
          ) : null}

          {allHistory.length > 0 ? (
            <div className="space-y-3 pt-2">
              <h3 className="text-xs font-semibold tracking-wider text-acapomil-muted">
                HISTORIAL
              </h3>
              {allHistory.map((item) => (
                <HistoryCard
                  key={item.id}
                  item={item}
                  speakingId={speakingId}
                  onSpeak={speakItem}
                />
              ))}
            </div>
          ) : null}
        </section>

        {/* 2) Idiomas + voz + acciones */}
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
                <span className="sr-only">Idioma de destino</span>
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
              Modo enviado al servidor: <span className="text-sky-300 font-semibold">{mode}</span>
              {mode === 'auto' ? (
                <>
                  {' '}
                  · sesgo destino:{' '}
                  <span className="text-sky-300 font-semibold">
                    {targetLang === 'es' ? 'español' : 'inglés'}
                  </span>
                </>
              ) : null}
            </p>
          </div>

          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 rounded-xl border border-acapomil-border bg-[#0d1118] px-3 py-3">
            <button
              type="button"
              onClick={() => setAutoVoiceExclusive(!autoVoice)}
              className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium shrink-0 ${
                autoVoice
                  ? 'border-acapomil-green/50 text-acapomil-green'
                  : 'border-white/10 text-acapomil-muted'
              }`}
              title="Exclusivo con «Escuchar subtítulo»: solo una ruta de voz a la vez"
            >
              <Volume2 className="h-4 w-4" />
              VOZ AUTOMÁTICA: {autoVoice ? 'ACTIVADA' : 'DESACTIVADA'}
            </button>
            <label className="flex flex-col sm:flex-row sm:items-center gap-2 text-sm text-acapomil-muted min-w-0 flex-1">
              <span className="shrink-0">Voz TTS:</span>
              <select
                className="w-full min-w-0 rounded-lg border border-acapomil-border bg-acapomil-card px-2 py-1.5 text-white text-sm"
                value={voiceURI}
                onChange={(e) => onVoiceSelect(e.target.value)}
              >
                {voiceOptions.length === 0 ? (
                  <option value="">Cargando voces del sistema…</option>
                ) : (
                  voiceOptions.map((v) => (
                    <option key={v.voiceURI} value={v.voiceURI}>
                      {formatVoiceOption(v)}
                    </option>
                  ))
                )}
              </select>
            </label>
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
          {tx.model ? (
            <p className="text-xs text-acapomil-muted">Modelo Live: {tx.model}</p>
          ) : null}
        </section>

        {/* 3) Micrófono / dispositivo — abajo */}
        <section className="rounded-2xl border border-acapomil-border bg-acapomil-card p-5 md:p-6">
          <p className="mb-2 text-xs font-semibold tracking-wider text-acapomil-muted">
            DISPOSITIVO DE AUDIO / MICRÓFONO
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
                onFocus={() => {
                  void mic.refreshDevices();
                }}
                onMouseDown={() => {
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
          <p className="mt-2 text-xs text-acapomil-muted leading-relaxed">
            iPhone: desbloqueado, cerca, Continuity Mic activado en Ajustes del Mac; pulsa refrescar.
          </p>
        </section>

        <footer className="pt-4 pb-8 text-center text-xs text-acapomil-muted">
          Mic PCM 16 kHz → Gemini Live → WebSocket → UI · TTS opcional con speechSynthesis · Solo EN ↔ ES
        </footer>
      </div>
    </div>
  );
}
