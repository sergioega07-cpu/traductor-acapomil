import { useCallback, useEffect, useRef, useState } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import { Crest } from './Crest';
import { StatusPill } from './StatusPill';
import { createSyncChannel, type SyncMessage } from '../lib/broadcast';
import type { AppStatus, HistoryItem, PartialSubtitles, ServerMessage, TranslateMode } from '../lib/types';
import { useSubtitleDisplay } from '../lib/subtitleDisplay';
import { isValidTranslationText, stopSpeaking } from '../lib/tts';
import { wsUrl } from '../lib/wsUrl';

function targetLabel(mode: TranslateMode, detected?: string) {
  if (mode === 'en-es') return 'EN→ES (un sentido)';
  if (mode === 'es-en') return 'ES→EN (un sentido)';
  if (detected === 'en') return 'EN→ES';
  if (detected === 'es') return 'ES→EN';
  return 'CONVERSACIÓN EN↔ES';
}

function mapServerStatus(s: string | undefined): AppStatus | null {
  if (!s) return null;
  if (s === 'ready') return 'ready';
  if (s === 'connecting' || s === 'reconnecting') return 'connecting';
  if (s === 'listening' || s === 'connected' || s === 'setup_complete') return 'listening';
  if (s === 'stopped') return 'stopped';
  if (s === 'disconnected') return 'disconnected';
  if (s === 'mode') return null;
  return null;
}

export function ProjectionView() {
  const [status, setStatus] = useState<AppStatus>('idle');
  const [mode, setMode] = useState<TranslateMode>('auto');
  const [partial, setPartial] = useState<PartialSubtitles>({ original: '', translation: '' });
  const [latest, setLatest] = useState<HistoryItem | null>(null);
  const [wsOk, setWsOk] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const channelRef = useRef<ReturnType<typeof createSyncChannel> | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const intentionalClose = useRef(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const applyServerMessage = useCallback((msg: ServerMessage) => {
    switch (msg.type) {
      case 'status': {
        if (msg.mode === 'en-es' || msg.mode === 'es-en' || msg.mode === 'auto') {
          setMode(msg.mode);
        }
        const mapped = mapServerStatus(msg.status);
        if (mapped) setStatus(mapped);
        break;
      }
      case 'error':
        setStatus('error');
        break;
      case 'partial':
      case 'interim': {
        setPartial((prev) => {
          const nextOriginal =
            msg.original ?? (msg.role === 'original' ? msg.text || prev.original : prev.original);
          let nextTranslation =
            msg.translation ??
            (msg.role === 'translation' ? msg.text || prev.translation : prev.translation);
          if (nextTranslation && !isValidTranslationText(nextTranslation)) {
            nextTranslation =
              msg.role === 'translation' || msg.translation != null ? prev.translation : nextTranslation;
            if (nextTranslation && !isValidTranslationText(nextTranslation)) {
              nextTranslation = '';
            }
          }
          return { original: nextOriginal || '', translation: nextTranslation || '' };
        });
        if (msg.mode === 'en-es' || msg.mode === 'es-en' || msg.mode === 'auto') {
          setMode(msg.mode);
        }
        break;
      }
      case 'final': {
        if (!msg.id) break;
        const rawTrad = msg.translation || '';
        const item: HistoryItem = {
          id: msg.id,
          original: msg.original || '',
          translation: isValidTranslationText(rawTrad) ? rawTrad.trim() : '',
          mode: (msg.mode as TranslateMode) || 'auto',
          detectedLang: msg.detectedLang,
          ts: msg.ts || new Date().toISOString(),
        };
        setLatest(item);
        setPartial({ original: '', translation: '' });
        setMode(item.mode);
        break;
      }
      case 'clear':
        setPartial({ original: '', translation: '' });
        setLatest(null);
        break;
      default:
        break;
    }
  }, []);

  // Prefer WebSocket relay (works across devices on the same LAN)
  useEffect(() => {
    intentionalClose.current = false;
    let reconnectTimer: number | null = null;
    let attempt = 0;

    const connect = () => {
      if (intentionalClose.current) return;
      const ws = new WebSocket(wsUrl());
      wsRef.current = ws;

      ws.onopen = () => {
        attempt = 0;
        setWsOk(true);
        setStatus((s) => (s === 'idle' || s === 'disconnected' ? 'ready' : s));
        ws.send(JSON.stringify({ type: 'hello', role: 'projection' }));
      };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data)) as ServerMessage;
          applyServerMessage(msg);
        } catch {
          /* ignore */
        }
      };
      ws.onclose = () => {
        if (wsRef.current === ws) wsRef.current = null;
        setWsOk(false);
        if (intentionalClose.current) return;
        setStatus('disconnected');
        attempt += 1;
        const delay = Math.min(400 * attempt, 4000);
        reconnectTimer = window.setTimeout(connect, delay);
      };
      ws.onerror = () => {
        /* onclose handles retry */
      };
    };

    connect();

    return () => {
      intentionalClose.current = true;
      if (reconnectTimer != null) window.clearTimeout(reconnectTimer);
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        ws.close();
      }
    };
  }, [applyServerMessage]);

  // Optional same-device BroadcastChannel fallback (same browser / Mac window)
  useEffect(() => {
    const channel = createSyncChannel((msg: SyncMessage) => {
      // Prefer WS when connected — skip BC duplicates
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) return;

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
        stopSpeaking();
      }
    });
    channelRef.current = channel;
    channel.post({ kind: 'ping' });
    return () => {
      channel.close();
      channelRef.current = null;
    };
  }, []);

  useEffect(() => {
    const onFs = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  const toggleFullscreen = async () => {
    const el = rootRef.current || document.documentElement;
    try {
      if (!document.fullscreenElement) {
        await el.requestFullscreen?.();
      } else {
        await document.exitFullscreen?.();
      }
    } catch (err) {
      console.warn('Fullscreen no disponible en este dispositivo:', err);
    }
  };

  const liveOriginal = partial.original || latest?.original || '';
  const rawLiveTranslation = partial.translation || latest?.translation || '';
  const liveTranslation = isValidTranslationText(rawLiveTranslation) ? rawLiveTranslation : '';
  const display = useSubtitleDisplay(liveOriginal, liveTranslation);
  const detected = latest?.detectedLang;
  const live = status === 'listening';

  return (
    <div ref={rootRef} className="min-h-screen bg-black text-white flex flex-col">
      <header className="flex items-center justify-between px-6 md:px-10 py-3 md:py-4 border-b border-white/10 shrink-0">
        <div className="flex items-center gap-3 min-w-[120px] md:min-w-[160px]">
          <Crest className="w-11 h-11 md:w-12 md:h-12" />
        </div>
        <h1 className="text-lg md:text-2xl lg:text-3xl font-bold tracking-[0.15em] text-center px-2">
          TRADUCTOR ACAPOMIL
        </h1>
        <div className="flex items-center justify-end gap-2 min-w-[120px] md:min-w-[160px]">
          <StatusPill status={status} />
          <button
            type="button"
            onClick={() => void toggleFullscreen()}
            className="inline-flex items-center justify-center rounded-lg border border-white/20 bg-white/5 p-2 text-white hover:bg-white/10"
            title={isFullscreen ? 'Salir de pantalla completa' : 'Pantalla completa'}
            aria-label={isFullscreen ? 'Salir de pantalla completa' : 'Pantalla completa'}
          >
            {isFullscreen ? <Minimize2 className="h-5 w-5" /> : <Maximize2 className="h-5 w-5" />}
            <span className="sr-only md:not-sr-only md:ml-1.5 md:text-xs md:font-semibold md:tracking-wider">
              {isFullscreen ? 'SALIR' : '⛶'}
            </span>
          </button>
        </div>
      </header>

      {!wsOk ? (
        <div className="px-4 py-2 text-center text-xs text-amber-200/90 bg-amber-500/10 border-b border-amber-500/20">
          Conectando al servidor de proyección… (misma WiFi que el Mac)
        </div>
      ) : null}

      <main className="relative flex-1 flex flex-col w-full min-h-0">
        <div className="absolute inset-0 bg-gradient-to-b from-black via-[#05070a] to-black" />

        <div className="relative z-10 flex items-center justify-center pt-4 md:pt-6 px-6 shrink-0">
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

        {display.largeText || liveOriginal ? (
          <div className="relative z-10 flex-1 flex flex-col min-h-0 w-full">
            {/* Upper half — original speech */}
            <div className="flex-1 min-h-0 flex flex-col items-center justify-center px-5 sm:px-10 lg:px-16 py-4 md:py-6">
              <div className="w-full max-w-6xl xl:max-w-7xl mx-auto text-center">
                {display.originalLine ? (
                  <p
                    className="font-normal text-gray-400/90 whitespace-pre-wrap break-words leading-relaxed drop-shadow-[0_2px_8px_rgba(0,0,0,0.9)]"
                    style={{ fontSize: 'clamp(1.15rem, 2vw + 0.35rem, 1.85rem)' }}
                  >
                    {display.originalLine}
                    {display.showTranslatingBadge && !display.hasRealTranslation ? (
                      <span className="ml-2 text-sky-400/80 font-medium normal-case tracking-normal text-sm md:text-base">
                        · traduciendo…
                      </span>
                    ) : null}
                  </p>
                ) : display.showTranslatingBadge && !display.hasRealTranslation ? (
                  <p className="text-sky-400/80 text-sm md:text-base font-medium">traduciendo…</p>
                ) : (
                  <p
                    className="font-normal text-gray-500/70 tracking-wide"
                    style={{ fontSize: 'clamp(1.15rem, 2vw + 0.35rem, 1.85rem)' }}
                  >
                    …
                  </p>
                )}
              </div>
            </div>

            <div className="shrink-0 mx-8 sm:mx-16 lg:mx-24 border-t border-white/10" aria-hidden />

            {/* Lower half — translation */}
            <div className="flex-1 min-h-0 flex flex-col items-center justify-center px-5 sm:px-10 lg:px-16 py-4 md:py-6">
              <div className="w-full max-w-6xl xl:max-w-7xl mx-auto text-center">
                {display.largeText && display.largeText !== 'traduciendo…' ? (
                  <p
                    className="font-normal text-gray-400/90 whitespace-pre-wrap break-words leading-relaxed drop-shadow-[0_2px_8px_rgba(0,0,0,0.9)]"
                    style={{ fontSize: 'clamp(1.15rem, 2vw + 0.35rem, 1.85rem)' }}
                  >
                    {display.largeText}
                  </p>
                ) : display.largeText === 'traduciendo…' ? (
                  <p
                    className="font-normal text-sky-400/80 whitespace-pre-wrap break-words leading-relaxed"
                    style={{ fontSize: 'clamp(1.15rem, 2vw + 0.35rem, 1.85rem)' }}
                  >
                    traduciendo…
                  </p>
                ) : (
                  <p
                    className="font-normal text-gray-500/70 tracking-wide"
                    style={{ fontSize: 'clamp(1.15rem, 2vw + 0.35rem, 1.85rem)' }}
                  >
                    …
                  </p>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="relative z-10 flex-1 flex flex-col items-center justify-center px-6 py-10 md:py-14">
            <p
              className="font-normal text-gray-500 tracking-wide break-words text-center"
              style={{ fontSize: 'clamp(1.15rem, 2vw + 0.35rem, 1.85rem)' }}
            >
              ESPERANDO ALOCUCIÓN...
            </p>
            <p className="mt-3 text-acapomil-muted text-sm md:text-base text-center">
              La traducción aparecerá automáticamente en pantalla
            </p>
          </div>
        )}
      </main>

      <footer className="flex items-center justify-between px-6 md:px-10 py-3 border-t border-white/10 text-xs tracking-[0.2em] text-acapomil-muted uppercase shrink-0">
        <span>Traducción simultánea en vivo</span>
        <span>Salida principal · WiFi</span>
      </footer>
    </div>
  );
}
