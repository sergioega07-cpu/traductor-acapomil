/** Best-effort speechSynthesis helpers: score premium/natural voices, wait for voiceschanged. */

const QUALITY_BONUS = [
  /premium/i,
  /enhanced/i,
  /natural/i,
  /neural/i,
  /online/i,
  /google/i,
  /microsoft/i,
  /samantha/i,
  /victoria/i,
  /karen/i,
  /moira/i,
  /daniel/i,
  /paulina/i,
  /sabina/i,
  /jorge/i,
  /monica/i,
  /esperanza/i,
  /paloma/i,
  /dalia/i,
  /elvira/i,
  /alvaro/i,
  /laura/i,
  /pablo/i,
  /aria/i,
  /jenny/i,
  /guy/i,
  /sara/i,
  /catalina/i,
];

const QUALITY_PENALTY = [
  /compact/i,
  /eloquence/i,
  /novelty/i,
  /whisper/i,
  /bad\s*news/i,
  /good\s*news/i,
  /bells/i,
  /boing/i,
  /bubbles/i,
  /cellos/i,
  /organ/i,
  /trinoids/i,
  /zarvox/i,
  /albert/i,
  /fred/i,
  /junior/i,
  /kathy/i,
  /ralph/i,
  /princess/i,
  /grandma/i,
  /grandpa/i,
  /elderly/i,
  /old\b/i,
];

/** Preferred locale order within a language family. */
const ES_LOCALE_RANK = [
  'es-419',
  'es-cl',
  'es-mx',
  'es-us',
  'es-ar',
  'es-co',
  'es-pe',
  'es-ve',
  'es-uy',
  'es-ec',
  'es-cr',
  'es-es',
];

const EN_LOCALE_RANK = ['en-us', 'en-gb', 'en-au', 'en-ie', 'en-za', 'en-in'];

export type VoiceChoice = {
  name: string;
  lang: string;
  voiceURI: string;
  localService: boolean;
};

let voicesReadyPromise: Promise<SpeechSynthesisVoice[]> | null = null;

function synth(): SpeechSynthesis | null {
  if (typeof window === 'undefined' || !window.speechSynthesis) return null;
  return window.speechSynthesis;
}

export function waitForVoices(): Promise<SpeechSynthesisVoice[]> {
  const s = synth();
  if (!s) return Promise.resolve([]);

  const existing = s.getVoices();
  if (existing.length) return Promise.resolve(existing);

  if (voicesReadyPromise) return voicesReadyPromise;

  voicesReadyPromise = new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      s.removeEventListener('voiceschanged', onChange);
      resolve(s.getVoices());
    };
    const onChange = () => finish();
    s.addEventListener('voiceschanged', onChange);
    // Some browsers populate asynchronously without a reliable event; poll briefly.
    let tries = 0;
    const timer = window.setInterval(() => {
      tries += 1;
      if (s.getVoices().length || tries >= 20) {
        window.clearInterval(timer);
        finish();
      }
    }, 100);
  });

  return voicesReadyPromise;
}

export function listVoices(): SpeechSynthesisVoice[] {
  const s = synth();
  return s ? s.getVoices() : [];
}

function langFamily(lang: string): 'es' | 'en' | 'other' {
  const base = lang.toLowerCase().split(/[-_]/)[0] || '';
  if (base === 'es') return 'es';
  if (base === 'en') return 'en';
  return 'other';
}

function normalizeLang(lang: string): string {
  return lang.toLowerCase().replace('_', '-');
}

function localeRank(voiceLang: string, prefFamily: 'es' | 'en' | 'other'): number {
  const vl = normalizeLang(voiceLang);
  const rank = prefFamily === 'es' ? ES_LOCALE_RANK : prefFamily === 'en' ? EN_LOCALE_RANK : [];
  const idx = rank.findIndex((r) => vl === r || vl.startsWith(r));
  if (idx >= 0) return 100 - idx * 3;
  if (vl.startsWith(prefFamily === 'other' ? '' : prefFamily)) return 40;
  return 0;
}

function qualityScore(voice: SpeechSynthesisVoice): number {
  const label = `${voice.name} ${voice.voiceURI}`;
  let score = 0;
  for (const re of QUALITY_BONUS) {
    if (re.test(label)) score += 25;
  }
  for (const re of QUALITY_PENALTY) {
    if (re.test(label)) score -= 80;
  }
  // Remote/cloud neural voices often sound healthier than tiny local compact ones.
  if (!voice.localService) score += 15;
  if (voice.default) score += 2;
  return score;
}

export function scoreVoice(voice: SpeechSynthesisVoice, langPref: string): number {
  const pref = normalizeLang(langPref);
  const family = langFamily(pref);
  const vl = normalizeLang(voice.lang);
  const vFamily = langFamily(vl);

  let score = qualityScore(voice);

  if (vl === pref) score += 120;
  else if (vl.startsWith(pref.split('-')[0])) score += 70;
  else if (family !== 'other' && vFamily === family) score += 50;
  else score -= 200; // wrong language family

  score += localeRank(vl, family);
  return score;
}

/** Ranked voices for a language preference (best first). Never returns unrelated junk first. */
export function voicesForLang(langPref: string): SpeechSynthesisVoice[] {
  const voices = listVoices();
  const family = langFamily(langPref);
  const scored = voices
    .map((v) => ({ v, s: scoreVoice(v, langPref) }))
    .filter(({ s, v }) => {
      if (family === 'other') return true;
      return langFamily(v.lang) === family && s > -100;
    })
    .sort((a, b) => b.s - a.s);
  return scored.map((x) => x.v);
}

export function toVoiceChoice(v: SpeechSynthesisVoice): VoiceChoice {
  return {
    name: v.name,
    lang: v.lang,
    voiceURI: v.voiceURI,
    localService: v.localService,
  };
}

/**
 * Pick the best available voice for langPref.
 * If preferredURI is set and still present, use it.
 * Never blindly returns voices[0].
 */
export function pickVoice(
  langPref: string,
  preferredURI?: string | null
): SpeechSynthesisVoice | null {
  const voices = listVoices();
  if (!voices.length) return null;

  if (preferredURI) {
    const exact = voices.find((v) => v.voiceURI === preferredURI || v.name === preferredURI);
    if (exact) return exact;
  }

  const ranked = voicesForLang(langPref);
  if (ranked.length) return ranked[0];

  // Soft fallback: best score among all voices for the same language family,
  // even if quality filters were harsh — still never voices[0] blindly.
  const family = langFamily(langPref);
  const sameFamily = voices
    .filter((v) => langFamily(v.lang) === family || family === 'other')
    .map((v) => ({ v, s: scoreVoice(v, langPref) }))
    .sort((a, b) => b.s - a.s);
  if (sameFamily.length) return sameFamily[0].v;

  return null;
}

export function speakText(
  text: string,
  lang: string,
  onStart?: () => void,
  onEnd?: () => void,
  preferredVoiceURI?: string | null
): SpeechSynthesisUtterance | null {
  const s = synth();
  if (!text?.trim() || !s) {
    onEnd?.();
    return null;
  }

  const utter = (voicesLoaded: boolean) => {
    s.cancel();
    const u = new SpeechSynthesisUtterance(text.trim());
    u.lang = lang;
    // Healthier, natural delivery — slightly brisker than elderly-sounding defaults.
    u.rate = 1.03;
    u.pitch = 1.0;
    u.volume = 1;

    const voice = pickVoice(lang, preferredVoiceURI);
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang || lang;
    } else if (!voicesLoaded) {
      // Voices not ready yet; speak with lang only (browser default for that lang).
    }

    u.onstart = () => onStart?.();
    u.onend = () => onEnd?.();
    u.onerror = () => onEnd?.();
    s.speak(u);
    return u;
  };

  const current = listVoices();
  if (current.length) {
    return utter(true);
  }

  // Wait for voiceschanged, then speak with a scored voice.
  waitForVoices().then(() => {
    utter(true);
  });
  // Return a placeholder utterance so callers still get a non-null ref when possible.
  const pending = new SpeechSynthesisUtterance(text.trim());
  pending.lang = lang;
  pending.rate = 1.03;
  pending.pitch = 1.0;
  return pending;
}

export function stopSpeaking() {
  const s = synth();
  if (s) s.cancel();
}

export function langForTranslation(
  mode: string,
  detected?: string,
  targetLang?: string
): string {
  if (targetLang === 'en') return 'en-US';
  if (targetLang === 'es') return 'es-CL';
  if (mode === 'en-es') return 'es-CL';
  if (mode === 'es-en') return 'en-US';
  if (detected === 'en') return 'es-CL';
  if (detected === 'es') return 'en-US';
  return 'es-CL';
}

export function voiceLabel(lang: string): string {
  if (lang.startsWith('es')) return 'Espanol (LatAm / CL / MX / US)';
  return 'English (en-US neural)';
}

export function formatVoiceOption(v: SpeechSynthesisVoice): string {
  const tags: string[] = [];
  const label = `${v.name} ${v.voiceURI}`;
  if (/neural|premium|enhanced|natural/i.test(label)) tags.push('natural');
  if (/google/i.test(label)) tags.push('Google');
  if (/microsoft/i.test(label)) tags.push('Microsoft');
  if (!v.localService) tags.push('online');
  const tagStr = tags.length ? ` · ${tags.join(', ')}` : '';
  return `${v.name} (${v.lang})${tagStr}`;
}
