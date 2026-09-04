import { useCallback, useEffect, useRef, useState } from 'react';

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function isLabeledMic(d: MediaDeviceInfo): boolean {
  return Boolean(d.label && d.label.trim() && d.label !== 'Default');
}

/** Continuity / iPhone / iPad mics first so they are easy to pick. */
function continuityScore(label: string): number {
  const l = (label || '').toLowerCase();
  if (/continuity/.test(l)) return 0;
  if (/iphone|ipad/.test(l)) return 1;
  if (/apple/.test(l)) return 2;
  return 3;
}

function sortMics(mics: MediaDeviceInfo[]): MediaDeviceInfo[] {
  return mics.slice().sort((a, b) => {
    const sa = continuityScore(a.label);
    const sb = continuityScore(b.label);
    if (sa !== sb) return sa - sb;
    return (a.label || '').localeCompare(b.label || '', undefined, { sensitivity: 'base' });
  });
}

async function getMicStream(deviceId: string): Promise<MediaStream> {
  const base: Omit<MediaTrackConstraints, 'deviceId'> = {
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };

  if (!deviceId) {
    return navigator.mediaDevices.getUserMedia({ audio: { ...base } });
  }

  // Prefer exact so Continuity/iPhone selection sticks; fall back if OS rejects.
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: { ...base, deviceId: { exact: deviceId } },
    });
  } catch {
    /* continue */
  }

  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: { ...base, deviceId: { ideal: deviceId } },
    });
  } catch {
    /* continue */
  }

  return navigator.mediaDevices.getUserMedia({ audio: { ...base } });
}

export function useMicCapture() {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceIdState] = useState<string>('');
  const [permission, setPermission] = useState<'unknown' | 'granted' | 'denied'>('unknown');
  const [capturing, setCapturing] = useState(false);
  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const silentGainRef = useRef<GainNode | null>(null);
  const onChunkRef = useRef<((b64: string) => void) | null>(null);
  const deviceIdRef = useRef<string>('');

  const setDeviceId = useCallback((id: string) => {
    deviceIdRef.current = id;
    setDeviceIdState(id);
  }, []);

  const refreshDevices = useCallback(async () => {
    try {
      if (!navigator.mediaDevices?.enumerateDevices) return [];
      const list = await navigator.mediaDevices.enumerateDevices();
      const mics = sortMics(list.filter((d) => d.kind === 'audioinput'));
      setDevices(mics);

      const current = deviceIdRef.current;
      const stillPresent = current && mics.some((d) => d.deviceId === current);

      if (stillPresent) {
        return mics;
      }

      if (current && !stillPresent) {
        const labeled = mics.find(isLabeledMic) || mics[0];
        setDeviceId(labeled?.deviceId || '');
        return mics;
      }

      if (!current && mics[0]?.deviceId) {
        const labeled = mics.find(isLabeledMic) || mics[0];
        setDeviceId(labeled.deviceId);
      }
      return mics;
    } catch {
      return [];
    }
  }, [setDeviceId]);

  useEffect(() => {
    void refreshDevices();
    const md = navigator.mediaDevices;
    if (!md?.addEventListener) return;
    const onChange = () => {
      void refreshDevices();
    };
    md.addEventListener('devicechange', onChange);
    return () => {
      md.removeEventListener('devicechange', onChange);
    };
  }, [refreshDevices]);

  const authorize = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      setPermission('granted');
      await refreshDevices();
      // Continuity devices often appear only after labels are unlocked
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
      const id = deviceIdRef.current;
      const stream = await getMicStream(id);
      streamRef.current = stream;
      setPermission('granted');
      await refreshDevices();

      // Let the browser pick the native rate; pcm-processor uses global sampleRate
      const ctx = new AudioContext();
      ctxRef.current = ctx;
      if (ctx.state === 'suspended') {
        await ctx.resume();
      }

      await ctx.audioWorklet.addModule('/pcm-processor.js');
      const source = ctx.createMediaStreamSource(stream);
      const worklet = new AudioWorkletNode(ctx, 'pcm-processor');
      workletRef.current = worklet;
      worklet.port.onmessage = (ev) => {
        const ab = ev.data as ArrayBuffer;
        const b64 = arrayBufferToBase64(ab);
        onChunkRef.current?.(b64);
      };

      // Chrome may not run process() unless the graph reaches destination.
      // Mute with GainNode(0) so we get PCM without speaker feedback.
      const silent = ctx.createGain();
      silent.gain.value = 0;
      silentGainRef.current = silent;
      source.connect(worklet);
      worklet.connect(silent);
      silent.connect(ctx.destination);

      setCapturing(true);
    },
    [refreshDevices]
  );

  const stop = useCallback(() => {
    workletRef.current?.port.close();
    workletRef.current?.disconnect();
    workletRef.current = null;
    silentGainRef.current?.disconnect();
    silentGainRef.current = null;
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
