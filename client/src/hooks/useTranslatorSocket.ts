import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppStatus, HistoryItem, PartialSubtitles, ServerMessage, TranslateMode } from '../lib/types';

function wsUrl() {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  // En dev Vite proxy /ws; en prod mismo host
  return `${proto}//${window.location.host}/ws`;
}

export function useTranslatorSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<AppStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [partial, setPartial] = useState<PartialSubtitles>({ original: '', translation: '' });
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [mode, setModeState] = useState<TranslateMode>('en-es');
  const intentionalClose = useRef(false);

  const connect = useCallback(() => {
    if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) {
      return;
    }
    intentionalClose.current = false;
    const ws = new WebSocket(wsUrl());
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    ws.onopen = () => setStatus('ready');
    ws.onclose = () => {
      if (!intentionalClose.current) setStatus('disconnected');
      wsRef.current = null;
    };
    ws.onerror = () => setError('Error de conexion WebSocket con el servidor');
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as ServerMessage;
        handleServer(msg);
      } catch {
        /* ignore */
      }
    };
  }, []);

  const handleServer = (msg: ServerMessage) => {
    switch (msg.type) {
      case 'status': {
        if (typeof msg.hasApiKey === 'boolean') setHasApiKey(msg.hasApiKey);
        if (msg.model) setModel(msg.model);
        if (msg.mode === 'en-es' || msg.mode === 'es-en' || msg.mode === 'auto') {
          setModeState(msg.mode);
        }
        const s = msg.status;
        if (s === 'ready') setStatus('ready');
        else if (s === 'connecting' || s === 'reconnecting') setStatus('connecting');
        else if (s === 'listening' || s === 'connected' || s === 'setup_complete') setStatus('listening');
        else if (s === 'stopped') setStatus('stopped');
        else if (s === 'disconnected') setStatus('disconnected');
        if (msg.message) setError(msg.message);
        break;
      }
      case 'error':
        setError(msg.message || 'Error desconocido');
        setStatus('error');
        break;
      case 'partial':
      case 'interim':
        setPartial((prev) => ({
          original: msg.original ?? (msg.role === 'original' ? msg.text || prev.original : prev.original),
          translation:
            msg.translation ??
            (msg.role === 'translation' ? msg.text || prev.translation : prev.translation),
        }));
        break;
      case 'final': {
        if (!msg.id) break;
        const item: HistoryItem = {
          id: msg.id,
          original: msg.original || '',
          translation: msg.translation || '',
          mode: (msg.mode as TranslateMode) || 'en-es',
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
  };

  useEffect(() => {
    connect();
    return () => {
      intentionalClose.current = true;
      wsRef.current?.close();
    };
  }, [connect]);

  const sendJson = useCallback((payload: unknown) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }, []);

  const startSession = useCallback(
    (m: TranslateMode) => {
      setError(null);
      setPartial({ original: '', translation: '' });
      setModeState(m);
      setStatus('connecting');
      sendJson({ type: 'start', mode: m });
    },
    [sendJson]
  );

  const stopSession = useCallback(() => {
    sendJson({ type: 'stop' });
    setStatus('stopped');
  }, [sendJson]);

  const sendAudio = useCallback(
    (b64: string) => {
      sendJson({ type: 'audio', data: b64 });
    },
    [sendJson]
  );

  const setMode = useCallback(
    (m: TranslateMode) => {
      setModeState(m);
      sendJson({ type: 'set_mode', mode: m });
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
    setMode,
    startSession,
    stopSession,
    sendAudio,
    clearHistory,
    copyAll,
    reconnect: connect,
  };
}
