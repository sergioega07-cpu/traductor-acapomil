import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppStatus, HistoryItem, PartialSubtitles, ServerMessage, TargetLang, TranslateMode } from '../lib/types';
import { isValidTranslationText } from '../lib/tts';
import { wsUrl } from '../lib/wsUrl';

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_MS = 400;
const MAX_AUDIO_BUFFER = 80; // ~8s of 100ms chunks



export function useTranslatorSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<AppStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [partial, setPartial] = useState<PartialSubtitles>({ original: '', translation: '' });
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [mode, setModeState] = useState<TranslateMode>('auto');
  const [targetLang, setTargetLangState] = useState<TargetLang>('es');
  const intentionalClose = useRef(false);
  const reconnectTimer = useRef<number | null>(null);
  const failCount = useRef(0);
  const connectRef = useRef<() => void>(() => {});

  // Buffer mic PCM until Gemini Live session is ready (listening/connected/setup_complete)
  const liveReadyRef = useRef(false);
  const audioQueueRef = useRef<string[]>([]);

  const clearReconnect = () => {
    if (reconnectTimer.current != null) {
      window.clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }
  };

  const flushAudioQueue = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const queued = audioQueueRef.current;
    audioQueueRef.current = [];
    for (const b64 of queued) {
      ws.send(JSON.stringify({ type: 'audio', data: b64 }));
    }
  }, []);

  const markLiveReady = useCallback(() => {
    if (liveReadyRef.current) return;
    liveReadyRef.current = true;
    flushAudioQueue();
  }, [flushAudioQueue]);

  const handleServer = useCallback(
    (msg: ServerMessage) => {
      switch (msg.type) {
        case 'status': {
          if (typeof msg.hasApiKey === 'boolean') setHasApiKey(msg.hasApiKey);
          if (msg.model) setModel(msg.model);
          if (msg.mode === 'en-es' || msg.mode === 'es-en' || msg.mode === 'auto') {
            setModeState(msg.mode);
          }
          if (msg.targetLang === 'en' || msg.targetLang === 'es') {
            setTargetLangState(msg.targetLang);
          }
          const s = msg.status;
          if (s === 'ready') {
            setError(null);
            setStatus('ready');
          } else if (s === 'connecting' || s === 'reconnecting') {
            setStatus('connecting');
          } else if (s === 'listening' || s === 'connected' || s === 'setup_complete') {
            setStatus('listening');
            markLiveReady();
          } else if (s === 'stopped') {
            liveReadyRef.current = false;
            audioQueueRef.current = [];
            setStatus('stopped');
          } else if (s === 'disconnected') {
            liveReadyRef.current = false;
            audioQueueRef.current = [];
            setStatus('disconnected');
          }
          if (msg.message) setError(msg.message);
          break;
        }
        case 'error':
          liveReadyRef.current = false;
          audioQueueRef.current = [];
          setError(msg.message || 'Error desconocido');
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
            // Never show language-code garbage as the live subtitle
            if (nextTranslation && !isValidTranslationText(nextTranslation)) {
              nextTranslation =
                msg.role === 'translation' || msg.translation != null ? prev.translation : nextTranslation;
              if (nextTranslation && !isValidTranslationText(nextTranslation)) {
                nextTranslation = '';
              }
            }
            return { original: nextOriginal || '', translation: nextTranslation || '' };
          });
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
          setHistory((h) => [item, ...h]);
          setPartial({ original: '', translation: '' });
          break;
        }
        case 'turn_complete':
          break;
        default:
          break;
      }
    },
    [markLiveReady]
  );

  const connect = useCallback(() => {
    if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) {
      return;
    }
    intentionalClose.current = false;
    clearReconnect();

    // While (re)connecting, show connecting — not a flash of disconnected
    setStatus('connecting');

    const ws = new WebSocket(wsUrl());
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    ws.onopen = () => {
      failCount.current = 0;
      setError(null);
      setStatus('ready');
      try {
        ws.send(JSON.stringify({ type: 'hello', role: 'control' }));
      } catch {
        /* ignore */
      }
    };
    ws.onclose = () => {
      if (wsRef.current === ws) wsRef.current = null;
      liveReadyRef.current = false;
      audioQueueRef.current = [];
      // Intentional StrictMode / unmount close: do not flash disconnected
      if (intentionalClose.current) return;

      failCount.current += 1;
      if (failCount.current >= MAX_RECONNECT_ATTEMPTS) {
        setStatus('disconnected');
        setError(
          'No se pudo conectar al servidor de traducción. Comprueba que el backend esté en marcha y pulsa Reconectar.'
        );
        return;
      }

      // Keep UI as connecting while retries are in flight
      setStatus('connecting');
      const delay = RECONNECT_BASE_MS * Math.min(failCount.current, 4);
      reconnectTimer.current = window.setTimeout(() => {
        if (!intentionalClose.current) connectRef.current();
      }, delay);
    };
    ws.onerror = () => {
      // No marcar error si estamos cerrando a proposito (React StrictMode)
      if (intentionalClose.current) return;
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as ServerMessage;
        handleServer(msg);
      } catch {
        /* ignore */
      }
    };
  }, [handleServer]);

  connectRef.current = connect;

  useEffect(() => {
    connect();
    return () => {
      intentionalClose.current = true;
      clearReconnect();
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        ws.close();
      }
    };
  }, [connect]);

  const reconnect = useCallback(() => {
    failCount.current = 0;
    setError(null);
    setStatus('connecting');
    liveReadyRef.current = false;
    audioQueueRef.current = [];
    clearReconnect();
    const existing = wsRef.current;
    if (existing) {
      // Avoid onclose scheduling a competing retry while we reconnect manually
      intentionalClose.current = true;
      try {
        existing.close();
      } catch {
        /* ignore */
      }
      if (wsRef.current === existing) wsRef.current = null;
    }
    intentionalClose.current = false;
    connect();
  }, [connect]);

  const sendJson = useCallback((payload: unknown) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }, []);

  const startSession = useCallback(
    (m: TranslateMode, tLang: TargetLang = 'es') => {
      setError(null);
      setPartial({ original: '', translation: '' });
      setModeState(m);
      setTargetLangState(tLang);
      setStatus('connecting');
      liveReadyRef.current = false;
      audioQueueRef.current = [];
      sendJson({ type: 'start', mode: m, targetLang: tLang });
    },
    [sendJson]
  );

  const stopSession = useCallback(() => {
    liveReadyRef.current = false;
    audioQueueRef.current = [];
    sendJson({ type: 'stop' });
    setStatus('stopped');
  }, [sendJson]);

  const sendAudio = useCallback(
    (b64: string) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      if (!liveReadyRef.current) {
        const q = audioQueueRef.current;
        if (q.length >= MAX_AUDIO_BUFFER) q.shift();
        q.push(b64);
        return;
      }

      ws.send(JSON.stringify({ type: 'audio', data: b64 }));
    },
    []
  );

  const setMode = useCallback(
    (m: TranslateMode, tLang?: TargetLang) => {
      setModeState(m);
      const resolved: TargetLang =
        tLang ?? (m === 'es-en' ? 'en' : 'es');
      setTargetLangState(resolved);
      sendJson({ type: 'set_mode', mode: m, targetLang: resolved });
    },
    [sendJson]
  );

  const clearHistory = useCallback(() => {
    setHistory([]);
    setPartial({ original: '', translation: '' });
  }, []);

  const copyAll = useCallback(async () => {
    const lines = history
      .slice()
      .reverse()
      .map((h) => '[' + h.ts + '] ORIG: ' + h.original + '\nTRAD: ' + h.translation)
      .join('\n\n');
    const live =
      partial.original || partial.translation
        ? '\n\n[EN VIVO]\nORIG: ' + partial.original + '\nTRAD: ' + partial.translation
        : '';
    await navigator.clipboard.writeText((lines + live).trim() || '(vacio)');
  }, [history, partial]);

  return {
    status,
    error,
    setError,
    hasApiKey,
    model,
    partial,
    history,
    mode,
    targetLang,
    setMode,
    startSession,
    stopSession,
    sendAudio,
    clearHistory,
    copyAll,
    reconnect,
  };
}
