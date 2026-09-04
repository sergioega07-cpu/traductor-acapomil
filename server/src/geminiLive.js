import { GoogleGenAI, Modality } from '@google/genai';

const TRANSLATE_MODELS = [
  'gemini-3.5-live-translate-preview',
  'gemini-3.1-flash-live-preview',
];

const FLASH_MODELS = [
  'gemini-3.1-flash-live-preview',
  'gemini-2.5-flash-native-audio-preview-12-2025',
  'gemini-live-2.5-flash-preview',
  'gemini-2.0-flash-live-001',
];

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
  const biasLabel = bias === 'en' ? 'ingles' : 'espanol';

  const common = `Eres un interprete simultaneo SOLO entre ingles y espanol para presentaciones en vivo (ACAPOMIL).

Idiomas permitidos: unicamente ingles (EN) y espanol (ES). No traduzcas hacia ni desde japones, frances, portugues u otros idiomas.

Reglas estrictas:
- Solo interpreta. No converses, no saludes, no hagas preguntas.
- Responde unicamente con la traduccion hablada del discurso del usuario.
- Mantén el significado, el tono formal institucional y la brevedad.
- Only English and Spanish. Detect which of the two is spoken and translate to the other (or to the selected target).
- Si el habla no es ingles ni espanol, intenta mapearlo a EN/ES solo si el sentido es claro; si no, permanece en silencio (no inventes traducciones a otros idiomas).`;

  if (mode === 'en-es') {
    return `${common}

Modo: INGLES → ESPANOL.
Traduce solo ingles a espanol. Si oyes espanol, permanece en silencio. Ignora cualquier otro idioma.`;
  }
  if (mode === 'es-en') {
    return `${common}

Modo: ESPANOL → INGLES.
Traduce solo espanol a ingles. Si oyes ingles, permanece en silencio. Ignora cualquier otro idioma.`;
  }
  return `${common}

Modo: AUTO (deteccion EN/ES) con sesgo de salida hacia ${biasLabel}.
Detecta cual de los dos idiomas (ingles o espanol) se habla y traduce al otro.
Preferencia de idioma de salida cuando haya ambiguedad: ${biasLabel}.
Nunca produzcas salida en un idioma que no sea ingles o espanol.`;
}

/**
 * Abre una sesion Gemini Live y reenvia audio PCM + textos al cliente via callbacks.
 * @param {{ apiKey: string, mode: string, targetLang?: string, onEvent: Function, onError: Function, onClose: Function }} opts
 */
export async function openLiveSession({ apiKey, mode, targetLang, onEvent, onError, onClose }) {
  const ai = new GoogleGenAI({ apiKey });
  const useTranslate = mode === 'en-es' || mode === 'es-en';
  const models = useTranslate ? TRANSLATE_MODELS : FLASH_MODELS;
  let lastError = null;

  for (const model of models) {
    try {
      const config = buildConfig(mode, model, targetLang);
      const session = await ai.live.connect({
        model,
        config,
        callbacks: {
          onopen: () => {
            onEvent({ type: 'status', status: 'connected', model, mode, targetLang: normalizeTargetLang(targetLang, mode) });
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
    return {
      responseModalities: [Modality.AUDIO],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      translationConfig: {
        targetLanguageCode: target,
        // En auto, permitir eco del idioma objetivo segun sesgo EN/ES
        echoTargetLanguage: mode === 'auto',
      },
      // Refuerzo textual: solo EN↔ES (algunos modelos translate lo respetan como contexto)
      systemInstruction: {
        parts: [
          {
            text: `Only English and Spanish. Detect which of the two is spoken and translate to the other (or to the selected target ${target}). Do not translate to or from any other language.`,
          },
        ],
      },
    };
  }

  // Flash Live: audio out + transcriptions = subtitulos; TTS del navegador para "Escuchar"
  return {
    responseModalities: [Modality.AUDIO],
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    systemInstruction: {
      parts: [{ text: systemInstructionForMode(mode, targetLang) }],
    },
  };
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

  // Interim (si el modelo lo envia)
  const interimIn = sc.interimInputTranscription?.text;
  if (interimIn) {
    onEvent({ type: 'interim', role: 'original', text: interimIn });
  }
  const interimOut = sc.interimOutputTranscription?.text;
  if (interimOut) {
    onEvent({ type: 'interim', role: 'translation', text: interimOut });
  }

  // Final / acumulado input = original
  const inputText = sc.inputTranscription?.text;
  if (inputText) {
    onEvent({
      type: 'transcript',
      role: 'original',
      text: inputText,
      finished: Boolean(sc.turnComplete || sc.inputTranscription?.finished),
    });
  }

  // Output transcription = traduccion (subtitulos)
  const outputText = sc.outputTranscription?.text;
  if (outputText) {
    onEvent({
      type: 'transcript',
      role: 'translation',
      text: outputText,
      finished: Boolean(sc.turnComplete || sc.outputTranscription?.finished),
    });
  }

  // Texto en modelTurn (por si algun modelo responde TEXT)
  const parts = sc.modelTurn?.parts || [];
  for (const part of parts) {
    if (part.text) {
      onEvent({
        type: 'transcript',
        role: 'translation',
        text: part.text,
        finished: Boolean(sc.turnComplete),
      });
    }
    // Ignoramos audio inline de Gemini; usamos speechSynthesis en el cliente
  }

  if (sc.turnComplete) {
    onEvent({ type: 'turn_complete' });
  }
}
