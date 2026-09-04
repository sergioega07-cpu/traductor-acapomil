import { GoogleGenAI, Modality } from '@google/genai';

/**
 * Prefer Flash Live with explicit translate instructions — systemInstruction is
 * respected and output transcription tends to be full sentences.
 * Translate-preview is audio-first, drops system instructions, and has been
 * observed returning language tags ("es"/"en") instead of sentences.
 */
const FLASH_MODELS = [
  'gemini-3.1-flash-live-preview',
  'gemini-2.5-flash-native-audio-preview-12-2025',
  'gemini-live-2.5-flash-preview',
  'gemini-2.0-flash-live-001',
];

const TRANSLATE_FALLBACK_MODELS = [
  'gemini-3.5-live-translate-preview',
];

/** Language-code / nonsense translations that must never be shown or TTS'd */
const INVALID_TRANSLATION_RE = /^(es|en|esp|ing|spa|eng|es-es|en-us|en-gb|español|espanol|english|ingles|inglés)$/i;

export function isValidTranslationText(text) {
  if (typeof text !== 'string') return false;
  const t = text.trim();
  if (!t) return false;
  if (t.length <= 2) return false;
  if (INVALID_TRANSLATION_RE.test(t)) return false;
  // Bare language tags with punctuation/spaces: "es.", " en "
  if (/^[.\s,;:!?\-_/()]*?(es|en|esp|ing)[.\s,;:!?\-_/()]*$/i.test(t) && t.length <= 6) {
    return false;
  }
  return true;
}

export function sanitizeTranslationText(text) {
  if (!isValidTranslationText(text)) return '';
  return text.trim();
}

/** Normalize optional target bias for auto mode: 'es' | 'en' */
function normalizeTargetLang(targetLang, mode) {
  if (targetLang === 'en' || targetLang === 'es') return targetLang;
  if (mode === 'es-en') return 'en';
  return 'es'; // en-es and auto default to Spanish audience
}

function targetLangForMode(mode, targetLang) {
  return normalizeTargetLang(targetLang, mode);
}

function systemInstructionForMode(mode, targetLang) {
  const bias = normalizeTargetLang(targetLang, mode);
  const biasLabel = bias === 'en' ? 'English' : 'Spanish';
  const otherLabel = bias === 'en' ? 'Spanish' : 'English';

  const common = `You are a simultaneous interpreter ONLY between English and Spanish for live presentations with Q&A (ACAPOMIL).

CRITICAL OUTPUT RULES (never break these):
- Your ONLY output must be the FULL translated sentence in the target language.
- NEVER output language codes or tags such as "es", "en", "esp", "ing", "ES", "EN".
- NEVER echo partial language tags, ISO codes, or locale strings.
- NEVER answer with a single word that is only a language name ("Spanish", "English", "español").
- Output fluent, natural, complete sentences — not fragments, not codes.
- Do not converse, greet, explain, or ask questions. Interpret only.
- Allowed languages: English and Spanish only.

The output audio transcription / text you produce IS the translation shown as subtitles. It must be a real sentence people can read aloud.`;

  if (mode === 'en-es') {
    return `${common}

ONE-WAY mode: English → Spanish.
Translate every English utterance into a complete Spanish sentence.
If you hear Spanish, stay silent. Ignore other languages.`;
  }
  if (mode === 'es-en') {
    return `${common}

ONE-WAY mode: Spanish → English.
Translate every Spanish utterance into a complete English sentence.
If you hear English, stay silent. Ignore other languages.`;
  }
  return `${common}

BIDIRECTIONAL conversation mode (EN ↔ ES) — default for talks with Q&A:
- If you hear ENGLISH → translate ALWAYS into a complete SPANISH sentence.
- If you hear SPANISH → translate ALWAYS into a complete ENGLISH sentence.
- NEVER stay silent just because you heard the "other" language — both directions must be translated.
- Audience questions in Spanish must become English; English answers must become Spanish.
- Only if language detection is extremely ambiguous, bias toward ${biasLabel} (vs ${otherLabel}).
- Never produce output that is not a full English or Spanish sentence.`;
}

/**
 * Abre una sesion Gemini Live y reenvia audio PCM + textos al cliente via callbacks.
 * @param {{ apiKey: string, mode: string, targetLang?: string, onEvent: Function, onError: Function, onClose: Function }} opts
 */
export async function openLiveSession({ apiKey, mode, targetLang, onEvent, onError, onClose }) {
  const ai = new GoogleGenAI({ apiKey });
  // Flash first for all modes (real sentences via systemInstruction).
  // Translate-preview only as connect fallback for one-way modes.
  const models =
    mode === 'en-es' || mode === 'es-en'
      ? [...FLASH_MODELS, ...TRANSLATE_FALLBACK_MODELS]
      : FLASH_MODELS;
  let lastError = null;

  for (const model of models) {
    try {
      const config = buildConfig(mode, model, targetLang);
      const session = await ai.live.connect({
        model,
        config,
        callbacks: {
          onopen: () => {
            onEvent({
              type: 'status',
              status: 'connected',
              model,
              mode,
              targetLang: normalizeTargetLang(targetLang, mode),
            });
          },
          onmessage: (message) => handleMessage(message, onEvent),
          onerror: (e) => {
            const msg = e?.message || String(e);
            onError(msg);
          },
          onclose: (e) => {
            onClose(e?.reason || 'closed');
          },
        },
      });

      return {
        model,
        sendAudioBase64(b64) {
          session.sendRealtimeInput({
            audio: { data: b64, mimeType: 'audio/pcm;rate=16000' },
          });
        },
        sendAudioStreamEnd() {
          try {
            session.sendRealtimeInput({ audioStreamEnd: true });
          } catch (_) {
            /* ignore */
          }
        },
        close() {
          try {
            session.close();
          } catch (_) {
            /* ignore */
          }
        },
      };
    } catch (err) {
      lastError = err;
      console.warn(`[gemini] modelo ${model} fallo:`, err?.message || err);
    }
  }

  throw lastError || new Error('No se pudo conectar a Gemini Live con ningun modelo conocido');
}

function buildConfig(mode, model, targetLang) {
  const isTranslateModel = model.includes('translate');
  const target = targetLangForMode(mode, targetLang);

  if (isTranslateModel) {
    // Translate API: AUDIO only; systemInstruction often ignored.
    // Still request both transcriptions — output transcription = translation text.
    return {
      responseModalities: [Modality.AUDIO],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      translationConfig: {
        targetLanguageCode: target,
        // auto: echo when input already matches target so conversation doesn't go silent
        echoTargetLanguage: mode === 'auto',
      },
    };
  }

  // Flash Live: AUDIO + transcriptions. Explicit instruction forces full-sentence translation.
  // TEXT modality alone is not used — we need streaming speech interpretation with captions.
  return {
    responseModalities: [Modality.AUDIO],
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    systemInstruction: {
      parts: [{ text: systemInstructionForMode(mode, targetLang) }],
    },
  };
}

function pickText(...candidates) {
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c;
    if (c && typeof c.text === 'string' && c.text.trim()) return c.text;
  }
  return '';
}

function handleMessage(message, onEvent) {
  const sc = message?.serverContent;
  if (!sc) {
    if (message?.setupComplete) {
      onEvent({ type: 'status', status: 'setup_complete' });
    }
    return;
  }

  if (sc.interrupted) {
    onEvent({ type: 'interrupted' });
  }

  // Interim (si el modelo lo envia) — also accept alternate field names
  const interimIn = pickText(
    sc.interimInputTranscription,
    sc.interim_input_transcription,
    message?.interimInputTranscription,
    message?.inputAudioTranscription?.interim
  );
  if (interimIn) {
    onEvent({ type: 'interim', role: 'original', text: interimIn });
  }
  const interimOut = pickText(
    sc.interimOutputTranscription,
    sc.interim_output_transcription,
    message?.interimOutputTranscription,
    message?.outputAudioTranscription?.interim
  );
  if (interimOut) {
    const clean = sanitizeTranslationText(interimOut);
    if (clean) {
      onEvent({ type: 'interim', role: 'translation', text: clean });
    }
    // Drop invalid interim (e.g. "es") so UI never flashes language codes
  }

  // Final / acumulado input = original (+ alternate names e.g. inputAudioTranscription)
  const inputObj =
    sc.inputTranscription ||
    sc.input_transcription ||
    sc.inputAudioTranscription ||
    sc.input_audio_transcription ||
    message?.inputAudioTranscription ||
    message?.inputTranscription;
  const inputText = pickText(inputObj);
  if (inputText) {
    onEvent({
      type: 'transcript',
      role: 'original',
      text: inputText,
      finished: Boolean(sc.turnComplete || inputObj?.finished),
    });
  }

  // Output transcription = traduccion (subtitulos)
  const outputObj =
    sc.outputTranscription ||
    sc.output_transcription ||
    sc.outputAudioTranscription ||
    sc.output_audio_transcription ||
    message?.outputAudioTranscription ||
    message?.outputTranscription;
  const outputText = pickText(outputObj);
  if (outputText) {
    const clean = sanitizeTranslationText(outputText);
    if (clean) {
      onEvent({
        type: 'transcript',
        role: 'translation',
        text: clean,
        finished: Boolean(sc.turnComplete || outputObj?.finished),
      });
    } else {
      console.warn('[gemini] ignored invalid translation text:', JSON.stringify(outputText));
    }
  }

  // Texto en modelTurn (por si algun modelo responde TEXT)
  const parts = sc.modelTurn?.parts || [];
  for (const part of parts) {
    if (part.text) {
      const clean = sanitizeTranslationText(part.text);
      if (clean) {
        onEvent({
          type: 'transcript',
          role: 'translation',
          text: clean,
          finished: Boolean(sc.turnComplete),
        });
      } else {
        console.warn('[gemini] ignored invalid modelTurn text:', JSON.stringify(part.text));
      }
    }
    // Ignoramos audio inline de Gemini; usamos speechSynthesis en el cliente
  }

  if (sc.turnComplete) {
    onEvent({ type: 'turn_complete' });
  }
}
