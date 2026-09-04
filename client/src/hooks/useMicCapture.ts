import { useCallback, useEffect, useRef, useState } from 'react';

const MIC_PREF_KEY = 'acapomil-mic-pref';

type MicPref = { deviceId: string; label: string };

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

function hasUsefulLabel(label: string): boolean {
  return Boolean(label && label.trim() && label !== 'Default');
}

function isVirtualMic(label: string): boolean {
  return /blackhole|virtual|teams|zoom|aggregate|loopback/i.test(label || '');
}

function isContinuityMic(label: string): boolean {
  return /iphone|ipad|continuity/i.test(label || '');
}

/** Continuity/iPhone first, then real mics, virtual last. */
function deviceSortScore(label: string): number {
  const l = label || '';
  if (isContinuityMic(l)) {
    if (/continuity/i.test(l)) return 0;
    if (/iphone|ipad/i.test(l)) return 1;
    return 2;
  }
  if (isVirtualMic(l)) return 100;
  if (/apple/i.test(l)) return 10;
  if (hasUsefulLabel(l)) return 20;
  return 50;
}

function sortMics(mics: MediaDeviceInfo[]): MediaDeviceInfo[] {
  return mics.slice().sort((a, b) => {
    const sa = deviceSortScore(a.label);
    const sb = deviceSortScore(b.label);
    if (sa !== sb) return sa - sb;
    return (a.label || '').localeCompare(b.label || '', undefined, { sensitivity: 'base' });
  });
}

function loadMicPref(): MicPref | null {
  try {
    const raw = localStorage.getItem(MIC_PREF_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as MicPref;
    if (parsed && typeof parsed.deviceId === 'string' && typeof parsed.label === 'string') {
      return parsed;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function saveMicPref(deviceId: string, label: string) {
  try {
    localStorage.setItem(MIC_PREF_KEY, JSON.stringify({ deviceId, label }));
  } catch {
    /* ignore */
  }
}

function labelsMatch(a: string, b: string): boolean {
  const na = (a || '').trim().toLowerCase();
  const nb = (b || '').trim().toLowerCase();
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

function pickPreferredMic(mics: MediaDeviceInfo[], pref: MicPref | null): MediaDeviceInfo | undefined {
  if (!pref) return undefined;

  const byId = mics.find((d) => d.deviceId === pref.deviceId);
  if (byId) return byId;

  if (pref.label) {
    const byLabel = mics.find((d) => labelsMatch(d.label, pref.label));
    if (byLabel) return byLabel;
  }

  if (pref.label && isContinuityMic(pref.label)) {
    return mics.find((d) => isContinuityMic(d.label));
  }

  return undefined;
}

/** Best auto-select candidate: Continuity > real labeled > never virtual first. */
function pickAutoMic(mics: MediaDeviceInfo[]): MediaDeviceInfo | undefined {
  if (!mics.length) return undefined;
  const continuity = mics.find((d) => isContinuityMic(d.label));
  if (continuity) return continuity;
  const real = mics.find((d) => isLabeledMic(d) && !isVirtualMic(d.label));
  if (real) return real;
  const labeled = mics.find(isLabeledMic);
  if (labeled) return labeled;
  return mics[0];
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

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export function useMicCapture() {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceIdState] = useState<string>('');
  const [permission, setPermission] = useState<'unknown' | 'granted' | 'denied'>('unknown');
  const [capturing, setCapturing] = useState(false);
  const [scanning, setScanning] = useState(false);
  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const silentGainRef = useRef<GainNode | null>(null);
  const onChunkRef = useRef<((b64: string) => void) | null>(null);
  const deviceIdRef = useRef<string>('');
  const preferredLabelRef = useRef<string>('');
  const preferredWasContinuityRef = useRef(false);

  useEffect(() => {
    const pref = loadMicPref();
    if (pref) {
      preferredLabelRef.current = pref.label;
      preferredWasContinuityRef.current = isContinuityMic(pref.label);
      if (pref.deviceId) {
        deviceIdRef.current = pref.deviceId;
        setDeviceIdState(pref.deviceId);
      }
    }
  }, []);

  const applyDeviceSelection = useCallback((id: string, label: string) => {
    deviceIdRef.current = id;
    setDeviceIdState(id);
    if (label) {
      preferredLabelRef.current = label;
      preferredWasContinuityRef.current = isContinuityMic(label);
      saveMicPref(id, label);
    } else if (id) {
      saveMicPref(id, preferredLabelRef.current || '');
    }
  }, []);

  const setDeviceId = useCallback(
    (id: string) => {
      const label =
        devices.find((d) => d.deviceId === id)?.label ||
        (id === deviceIdRef.current ? preferredLabelRef.current : '');
      applyDeviceSelection(id, label);
    },
    [applyDeviceSelection, devices]
  );

  const refreshDevices = useCallback(async () => {
    try {
      if (!navigator.mediaDevices?.enumerateDevices) return [];
      const list = await navigator.mediaDevices.enumerateDevices();
      // Show ALL audioinput devices — never hide Continuity or anything else.
      const mics = sortMics(list.filter((d) => d.kind === 'audioinput'));
      setDevices(mics);

      const pref = loadMicPref();
      const preferredLabel = preferredLabelRef.current || pref?.label || '';
      const preferredWasContinuity =
        preferredWasContinuityRef.current ||
        (preferredLabel ? isContinuityMic(preferredLabel) : false);

      const current = deviceIdRef.current;
      const stillPresent = Boolean(current && mics.some((d) => d.deviceId === current));

      // Re-select Continuity by preferred label even if deviceId changed.
      const matchedPref = pickPreferredMic(mics, {
        deviceId: current || pref?.deviceId || '',
        label: preferredLabel || pref?.label || '',
      });

      if (matchedPref && isContinuityMic(matchedPref.label) && preferredWasContinuity) {
        if (matchedPref.deviceId !== current) {
          applyDeviceSelection(matchedPref.deviceId, matchedPref.label);
        }
        return mics;
      }

      if (stillPresent) {
        const cur = mics.find((d) => d.deviceId === current);
        if (cur?.label && cur.label !== preferredLabelRef.current) {
          preferredLabelRef.current = cur.label;
          preferredWasContinuityRef.current = isContinuityMic(cur.label);
          saveMicPref(current, cur.label);
        }
        return mics;
      }

      // Current Continuity vanished temporarily: do NOT switch to BlackHole/virtual.
      if (current && !stillPresent && preferredWasContinuity) {
        const continuityBack = mics.find((d) => isContinuityMic(d.label));
        if (continuityBack) {
          applyDeviceSelection(continuityBack.deviceId, continuityBack.label);
          return mics;
        }
        // Keep previous id (stale) so UI doesn't jump to virtual; wait for devicechange.
        return mics;
      }

      if (current && !stillPresent) {
        // Non-Continuity disappeared: prefer saved label match, else real mic (not virtual).
        if (matchedPref && !isVirtualMic(matchedPref.label)) {
          applyDeviceSelection(matchedPref.deviceId, matchedPref.label);
          return mics;
        }
        const auto = pickAutoMic(mics);
        if (auto && !isVirtualMic(auto.label)) {
          applyDeviceSelection(auto.deviceId, auto.label);
        } else if (auto) {
          // Only fall back to virtual if nothing else exists.
          const real = mics.find((d) => isLabeledMic(d) && !isVirtualMic(d.label));
          if (real) {
            applyDeviceSelection(real.deviceId, real.label);
          } else {
            applyDeviceSelection(auto.deviceId, auto.label);
          }
        } else {
          applyDeviceSelection('', '');
        }
        return mics;
      }

      if (!current && mics.length) {
        if (matchedPref) {
          applyDeviceSelection(matchedPref.deviceId, matchedPref.label);
        } else {
          const auto = pickAutoMic(mics);
          if (auto) applyDeviceSelection(auto.deviceId, auto.label);
        }
      }
      return mics;
    } catch {
      return [];
    }
  }, [applyDeviceSelection]);

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

  /** Authorize + poll for Continuity/iPhone/iPad mic (~5s). */
  const scanPhoneMic = useCallback(async () => {
    setScanning(true);
    try {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => t.stop());
        setPermission('granted');
      } catch {
        setPermission('denied');
        return null;
      }

      const deadline = Date.now() + 5000;
      let found: MediaDeviceInfo | null = null;

      while (Date.now() < deadline) {
        const list = await navigator.mediaDevices.enumerateDevices();
        const mics = sortMics(list.filter((d) => d.kind === 'audioinput'));
        setDevices(mics);
        found = mics.find((d) => isContinuityMic(d.label)) || null;
        if (found) break;
        await sleep(500);
      }

      await refreshDevices();

      if (found) {
        applyDeviceSelection(found.deviceId, found.label);
        preferredWasContinuityRef.current = true;
        return found;
      }
      return null;
    } finally {
      setScanning(false);
    }
  }, [applyDeviceSelection, refreshDevices]);

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
    scanning,
    authorize,
    refreshDevices,
    scanPhoneMic,
    start,
    stop,
  };
}
