export function pickVoice(langPref: string): SpeechSynthesisVoice | null {
  if (typeof window === 'undefined' || !window.speechSynthesis) return null;
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return null;

  const pref = langPref.toLowerCase();
  const exact =
    voices.find((v) => v.lang.toLowerCase() === pref) ||
    voices.find((v) => v.lang.toLowerCase().startsWith(pref.split('-')[0]));
  return exact || voices[0] || null;
}

export function speakText(
  text: string,
  lang: string,
  onStart?: () => void,
  onEnd?: () => void
): SpeechSynthesisUtterance | null {
  if (!text?.trim() || typeof window === 'undefined' || !window.speechSynthesis) {
    onEnd?.();
    return null;
  }
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text.trim());
  u.lang = lang;
  const voice = pickVoice(lang);
  if (voice) u.voice = voice;
  u.rate = 1;
  u.pitch = 1;
  u.onstart = () => onStart?.();
  u.onend = () => onEnd?.();
  u.onerror = () => onEnd?.();
  window.speechSynthesis.speak(u);
  return u;
}

export function stopSpeaking() {
  if (typeof window !== 'undefined' && window.speechSynthesis) {
    window.speechSynthesis.cancel();
  }
}

export function langForTranslation(mode: string, detected?: string): string {
  if (mode === 'en-es') return 'es-CL';
  if (mode === 'es-en') return 'en-US';
  if (detected === 'en') return 'es-CL';
  if (detected === 'es') return 'en-US';
  return 'es-CL';
}

export function voiceLabel(lang: string): string {
  if (lang.startsWith('es')) return 'Espanol (es-CL / es-ES)';
  return 'English (en-US / en-GB)';
}
