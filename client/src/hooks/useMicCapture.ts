import { useCallback, useRef, useState } from 'react';

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function useMicCapture() {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string>('');
  const [permission, setPermission] = useState<'unknown' | 'granted' | 'denied'>('unknown');
  const [capturing, setCapturing] = useState(false);
  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const onChunkRef = useRef<((b64: string) => void) | null>(null);

  const refreshDevices = useCallback(async () => {
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      const mics = list.filter((d) => d.kind === 'audioinput');
      setDevices(mics);
      if (!deviceId && mics[0]?.deviceId) setDeviceId(mics[0].deviceId);
      return mics;
    } catch {
      return [];
    }
  }, [deviceId]);

  const authorize = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      setPermission('granted');
      await refreshDevices();
      return true;
    } catch {
      setPermission('denied');
      return false;
    }
  }, [refreshDevices]);

  const start = useCallback(
    async (onChunk: (b64: string) => void) => {
      onChunkRef.current = onChunk;
      const constraints: MediaStreamConstraints = {
        audio: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;
      setPermission('granted');
      await refreshDevices();

      const ctx = new AudioContext({ sampleRate: 48000 });
      ctxRef.current = ctx;
      await ctx.audioWorklet.addModule('/pcm-processor.js');
      const source = ctx.createMediaStreamSource(stream);
      const worklet = new AudioWorkletNode(ctx, 'pcm-processor');
      workletRef.current = worklet;
      worklet.port.onmessage = (ev) => {
        const ab = ev.data as ArrayBuffer;
        const b64 = arrayBufferToBase64(ab);
        onChunkRef.current?.(b64);
      };
      source.connect(worklet);
      // No conectar a destination para evitar feedback
      setCapturing(true);
    },
    [deviceId, refreshDevices]
  );

  const stop = useCallback(() => {
    workletRef.current?.port.close();
    workletRef.current?.disconnect();
    workletRef.current = null;
    ctxRef.current?.close().catch(() => {});
    ctxRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCapturing(false);
  }, []);

  return {
    devices,
    deviceId,
    setDeviceId,
    permission,
    capturing,
    authorize,
    refreshDevices,
    start,
    stop,
  };
}
