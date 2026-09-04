import { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, MicOff, Radio, RefreshCw, Shield } from 'lucide-react';
import { Crest } from './Crest';
import { useMicCapture } from '../hooks/useMicCapture';
import { wsUrl } from '../lib/wsUrl';

type MicUiStatus = 'connecting' | 'ready' | 'sending' | 'error' | 'disconnected';

/**
 * Mobile-friendly remote mic page (?mode=mic).
 * Captures PCM 16kHz on the phone and streams to the shared Gemini Live session on the Mac server.
 */
export function MicView() {
  const mic = useMicCapture();
  const [wsStatus, setWsStatus] = useState<MicUiStatus>('connecting');
  const [liveActive, setLiveActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const intentionalClose = useRef(false);
  const sendingRef = useRef(false);

  const connect = useCallback(() => {
    if (
      wsRef.current &&
      (wsRef.current.readyState === WebSocket.OPEN ||
        wsRef.current.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    intentionalClose.current = false;
    setWsStatus('connecting');
    setError(null);

    const ws = new WebSocket(wsUrl());
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    ws.onopen = () => {
      setWsStatus('ready');
      try {
        ws.send(JSON.stringify({ type: 'hello', role: 'mic' }));
      } catch {
        /* ignore */
      }
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as {
          type?: string;
          status?: string;
          message?: string;
          liveActive?: boolean;
        };
        if (msg.type === 'error') {
          setError(msg.message || 'Error del servidor');
          // Keep WS UI as ready/sending when Mac session is simply not started yet
          if (!/Inicia traducción/i.test(msg.message || '')) {
            setWsStatus('error');
          }
          return;
        }
        if (msg.type === 'status') {
          if (typeof msg.liveActive === 'boolean') setLiveActive(msg.liveActive);
          if (msg.status === 'listening' || msg.status === 'connected' || msg.status === 'setup_complete') {
            setLiveActive(true);
            setError(null);
            if (!sendingRef.current) setWsStatus('ready');
          } else if (msg.status === 'stopped' || msg.status === 'disconnected') {
            setLiveActive(false);
            if (msg.message) setError(msg.message);
          } else if (msg.status === 'ready') {
            setError(null);
            if (!sendingRef.current) setWsStatus('ready');
          }
          if (msg.message && msg.status !== 'mode') {
            if (msg.status === 'error' || /Inicia traducción/i.test(msg.message)) {
              setError(msg.message);
            }
          }
        }
      } catch {
        /* ignore */
      }
    };

    ws.onclose = () => {
      if (wsRef.current === ws) wsRef.current = null;
      if (intentionalClose.current) return;
      setWsStatus('disconnected');
      setLiveActive(false);
      window.setTimeout(() => {
        if (!intentionalClose.current) connect();
      }, 800);
    };

    ws.onerror = () => {
      /* onclose retries */
    };
  }, []);

  useEffect(() => {
    connect();
    return () => {
      intentionalClose.current = true;
      mic.stop();
      sendingRef.current = false;
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        ws.close();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connect]);

  const sendAudioChunk = useCallback((b64: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'audio', data: b64 }));
  }, []);

  const onAllowMic = async () => {
    setError(null);
    const ok = await mic.authorize();
    if (!ok) {
      setError('Micrófono denegado. En Safari: Ajustes → Safari → Micrófono, o toca de nuevo.');
    }
  };

  const onStartSending = async () => {
    setError(null);
    if (mic.permission !== 'granted') {
      const ok = await mic.authorize();
      if (!ok) {
        setError('Debes permitir el micrófono para enviar audio.');
        return;
      }
    }
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setError('Sin conexión al servidor. Comprueba la WiFi y pulsa Reconectar.');
      setWsStatus('disconnected');
      return;
    }
    try {
      sendingRef.current = true;
      setSending(true);
      setWsStatus('sending');
      await mic.start(sendAudioChunk);
    } catch {
      sendingRef.current = false;
      setSending(false);
      setWsStatus('ready');
      setError('No se pudo iniciar la captura de audio en el iPhone.');
    }
  };

  const onStopSending = () => {
    mic.stop();
    sendingRef.current = false;
    setSending(false);
    setWsStatus(wsRef.current?.readyState === WebSocket.OPEN ? 'ready' : 'disconnected');
  };

  const statusLabel =
    wsStatus === 'connecting'
      ? 'Conectando…'
      : wsStatus === 'disconnected'
        ? 'Desconectado'
        : wsStatus === 'error'
          ? 'Error'
          : sending
            ? 'Enviando audio'
            : liveActive
              ? 'Listo · traducción activa en Mac'
              : 'Listo · espera a Iniciar en el Mac';

  return (
    <div className="min-h-screen bg-acapomil-bg flex flex-col">
      <header className="flex items-center gap-3 px-5 pt-6 pb-4 border-b border-acapomil-border">
        <Crest className="w-10 h-10 shrink-0" />
        <div className="min-w-0">
          <h1 className="text-base font-bold tracking-[0.12em] truncate">MICRÓFONO REMOTO</h1>
          <p className="text-xs text-acapomil-muted truncate">Traductor ACAPOMIL · misma WiFi</p>
        </div>
      </header>

      <main className="flex-1 flex flex-col items-stretch justify-between px-5 py-6 gap-6 max-w-lg mx-auto w-full">
        <div className="space-y-3">
          <div
            className={`rounded-2xl border px-4 py-4 flex items-center gap-3 ${
              sending
                ? 'border-emerald-500/50 bg-emerald-500/10 listening-glow'
                : 'border-acapomil-border bg-acapomil-card'
            }`}
          >
            <div
              className={`flex h-12 w-12 items-center justify-center rounded-full ${
                sending ? 'bg-emerald-500/20 text-emerald-300' : 'bg-sky-500/15 text-sky-300'
              }`}
            >
              {sending ? <Radio className="h-6 w-6" /> : <Mic className="h-6 w-6" />}
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold">{statusLabel}</p>
              <p className="text-xs text-acapomil-muted mt-0.5">
                {liveActive
                  ? 'El Mac tiene la sesión Gemini abierta'
                  : 'Abre el panel en el Mac y pulsa Iniciar traducción'}
              </p>
            </div>
          </div>

          {error ? (
            <div className="rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-100">
              {error}
            </div>
          ) : null}

          <p className="text-xs text-acapomil-muted leading-relaxed">
            1) Permite el micrófono · 2) En el Mac inicia la traducción · 3) Pulsa Enviar audio y habla.
            La TV muestra los subtítulos por la URL de proyección.
          </p>
        </div>

        <div className="space-y-3 pb-8">
          {mic.permission !== 'granted' ? (
            <button
              type="button"
              onClick={() => void onAllowMic()}
              className="w-full inline-flex items-center justify-center gap-2 rounded-2xl border border-sky-500/40 bg-sky-500/15 px-4 py-5 text-base font-bold text-sky-50 active:scale-[0.98]"
            >
              <Shield className="h-6 w-6" />
              Permitir micrófono
            </button>
          ) : (
            <p className="text-center text-xs text-emerald-300/90 font-medium">
              Micrófono autorizado
            </p>
          )}

          {!sending ? (
            <button
              type="button"
              onClick={() => void onStartSending()}
              className="w-full inline-flex items-center justify-center gap-2 rounded-2xl bg-acapomil-blue hover:bg-acapomil-blue-hover px-4 py-5 text-lg font-bold active:scale-[0.98]"
            >
              <Mic className="h-7 w-7" />
              Enviar audio
            </button>
          ) : (
            <button
              type="button"
              onClick={onStopSending}
              className="w-full inline-flex items-center justify-center gap-2 rounded-2xl bg-red-600 hover:bg-red-500 px-4 py-5 text-lg font-bold active:scale-[0.98]"
            >
              <MicOff className="h-7 w-7" />
              Detener
            </button>
          )}

          {(wsStatus === 'disconnected' || wsStatus === 'error') && (
            <button
              type="button"
              onClick={() => connect()}
              className="w-full inline-flex items-center justify-center gap-2 rounded-xl border border-acapomil-border bg-white/5 px-4 py-3 text-sm font-semibold"
            >
              <RefreshCw className="h-4 w-4" />
              Reconectar
            </button>
          )}
        </div>
      </main>
    </div>
  );
}
