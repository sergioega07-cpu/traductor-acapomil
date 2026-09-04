/** Best-effort speechSynthesis helpers: score premium/natural voices, wait for voiceschanged.
 *  Long-utterance fix: chunk text + Chrome resume interval so speech doesn't cut off early.
 */

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

/** Target chunk length for Chrome speechSynthesis (cuts off long utterances). */
const CHUNK_MIN = 180;
const CHUNK_MAX = 220;

export type VoiceChoice = {
  name: string;
  lang: string;
  voiceURI: string;
  localService: boolean;
};

let voicesReadyPromise: Promise<SpeechSynthesisVoice[]> | null = null;

/** Active speak session state — cleared by stopSpeaking. */
let chunkQueue: string[] = [];
let resumeIntervalId: number | null = null;
let speakGeneration = 0;
let sessionOnEnd: (() => void) | null = null;

function synth(): SpeechSynthesis | null {
  if (typeof window === 'undefined' || !window.speechSynthesis) return null;
  return window.speechSynthesis;
}

function clearResumeInterval() {
  if (resumeIntervalId != null) {
    window.clearInterval(resumeIntervalId);
    resumeIntervalId = null;
  }
}

function startResumeInterval() {
  clearResumeInterval();
  const s = synth();
  if (!s) return;
  // Chrome bug: speechSynthesis pauses/stops long utterances silently.
  resumeIntervalId = window.setInterval(() => {
    if (s.speaking) s.resume();
  }, 10000);
}

/**
 * Split text into ~180–220 char chunks at punctuation / word boundaries.
 * Keeps sentences intact when possible so TTS sounds natural.
 */
export function splitIntoChunks(text: string, minLen = CHUNK_MIN, maxLen = CHUNK_MAX): string[] {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) return [];
  if (cleaned.length <= maxLen) return [cleaned];

  const chunks: string[] = [];
  let remaining = cleaned;

  while (remaining.length > maxLen) {
    // Prefer sentence-ending punctuation in the sweet spot, else any punctuation, else space.
    const window = remaining.slice(0, maxLen);
    const searchFrom = Math.min(minLen, window.length);
    let cut = -1;
    const sentenceEnd = /[.!?…。！？][\s"')\]]*$/;
    // Walk backwards from maxLen looking for a sentence boundary past minLen
    for (let i = window.length - 1; i >= searchFrom; i--) {
      const candidate = window.slice(0, i + 1);
      if (sentenceEnd.test(candidate) || /[.!?…。！？]\s/.test(window.slice(Math.max(0, i - 1), i + 2))) {
        // Prefer ending right after punctuation (+ optional closing quote/space)
        if (/[.!?…。！？]/.test(window[i]) || (/\s/.test(window[i]) && /[.!?…。！？]/.test(window[i - 1] || ''))) {
          cut = i + 1;
          // Include trailing whitespace after punctuation
          while (cut < window.length && /\s/.test(window[cut])) cut++;
          break;
        }
      }
    }

    if (cut < 0) {
      // Soft punctuation: comma, semicolon, colon, dash
      for (let i = window.length - 1; i >= searchFrom; i--) {
        if (/[,;:，；：—–-]/.test(window[i]) && (i + 1 >= window.length || /\s/.test(window[i + 1]))) {
          cut = i + 1;
          while (cut < window.length && /\s/.test(window[cut])) cut++;
          break;
        }
      }
    }

    if (cut < 0) {
      // Last resort: break on whitespace
      const lastSpace = window.lastIndexOf(' ');
      if (lastSpace >= searchFrom) {
        cut = lastSpace + 1;
      } else {
        cut = maxLen;
      }
    }

    const piece = remaining.slice(0, cut).trim();
    if (piece) chunks.push(piece);
    remaining = remaining.slice(cut).trim();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
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

function speakNextChunk(
  gen: number,
  lang: string,
  preferredVoiceURI: string | null | undefined,
  isFirst: boolean,
  onStart?: () => void
) {
  if (gen !== speakGeneration) return;
  const s = synth();
  if (!s) {
    finishSession(gen);
    return;
  }

  const next = chunkQueue.shift();
  if (!next) {
    finishSession(gen);
    return;
  }

  const u = new SpeechSynthesisUtterance(next);
  u.lang = lang;
  u.rate = 1.03;
  u.pitch = 1.0;
  u.volume = 1;

  const voice = pickVoice(lang, preferredVoiceURI);
  if (voice) {
    u.voice = voice;
    u.lang = voice.lang || lang;
  }

  u.onstart = () => {
    if (gen !== speakGeneration) return;
    if (isFirst) onStart?.();
  };
  u.onend = () => {
    if (gen !== speakGeneration) return;
    speakNextChunk(gen, lang, preferredVoiceURI, false, onStart);
  };
  u.onerror = () => {
    if (gen !== speakGeneration) return;
    // Skip failed chunk and continue so a single error doesn't kill the rest.
    speakNextChunk(gen, lang, preferredVoiceURI, false, onStart);
  };

  s.speak(u);
}

function finishSession(gen: number) {
  if (gen !== speakGeneration) return;
  clearResumeInterval();
  chunkQueue = [];
  const cb = sessionOnEnd;
  sessionOnEnd = null;
  cb?.();
}

/**
 * Speak text with Chrome-safe chunking.
 * Returns the first utterance (or a pending placeholder) for API compatibility.
 */
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

  // Cancel any in-flight session before starting a new one.
  stopSpeaking();

  const gen = ++speakGeneration;
  sessionOnEnd = onEnd ?? null;
  chunkQueue = splitIntoChunks(text.trim());
  startResumeInterval();

  const startSpeaking = () => {
    if (gen !== speakGeneration) return;
    speakNextChunk(gen, lang, preferredVoiceURI, true, onStart);
  };

  const current = listVoices();
  if (current.length) {
    startSpeaking();
  } else {
    waitForVoices().then(() => {
      if (gen !== speakGeneration) return;
      startSpeaking();
    });
  }

  // Placeholder utterance so callers still get a non-null ref when possible.
  const pending = new SpeechSynthesisUtterance(text.trim());
  pending.lang = lang;
  pending.rate = 1.03;
  pending.pitch = 1.0;
  return pending;
}

export function stopSpeaking() {
  speakGeneration += 1;
  chunkQueue = [];
  clearResumeInterval();
  sessionOnEnd = null;
  const s = synth();
  if (s) s.cancel();
}


/** Normalize text for TTS dedupe comparisons. */
export function normalizeSpeakText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function textsLookIdentical(a: string, b: string): boolean {
  const na = normalizeSpeakText(a);
  const nb = normalizeSpeakText(b);
  return Boolean(na) && na === nb;
}

/**
 * Skip speak when text matches last spoken, or is only a short mid-speak
 * prefix extension (< +25% chars) unless this is a new final turn.
 */
export function shouldSkipDuplicateSpeak(
  text: string,
  lastSpoken: string,
  options?: { midSpeak?: boolean; isFinal?: boolean }
): boolean {
  const next = normalizeSpeakText(text);
  const prev = normalizeSpeakText(lastSpoken);
  if (!next) return true;
  if (next === prev) return true;
  if (
    options?.midSpeak &&
    !options?.isFinal &&
    prev &&
    next.startsWith(prev) &&
    next.length < Math.ceil(prev.length * 1.25)
  ) {
    return true;
  }
  return false;
}

/** Wait (do not speak) while translation is missing or still mirrors the original. */
export function shouldWaitForRealTranslation(
  mode: string,
  original: string | undefined,
  translation: string | undefined,
  _targetLang?: string
): boolean {
  const o = original?.trim();
  const t = translation?.trim();
  if (!t) return true; // nothing to speak yet
  if (o && textsLookIdentical(o, t)) return true; // still echoing source
  // Speak only when translation clearly differs from original
  void mode;
  return false;
}

export function isSpeaking(): boolean {
  const s = synth();
  return Boolean(s && (s.speaking || s.pending));
}

export function langForTranslation(
  mode: string,
  detected?: string,
  targetLang?: string
): string {
  // Forced one-way modes: TTS is always the fixed target
  if (mode === 'en-es') return 'es-CL';
  if (mode === 'es-en') return 'en-US';
  // Conversación / auto: speak the OTHER language from what was heard
  if (detected === 'en') return 'es-CL';
  if (detected === 'es') return 'en-US';
  // Ambiguous: audience bias from UI target
  if (targetLang === 'en') return 'en-US';
  if (targetLang === 'es') return 'es-CL';
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
