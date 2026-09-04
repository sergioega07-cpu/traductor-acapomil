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

  const common = `Eres un interprete simultaneo SOLO entre ingles y espanol para presentaciones en vivo con preguntas y respuestas (ACAPOMIL).

Idiomas permitidos: unicamente ingles (EN) y espanol (ES). No traduzcas hacia ni desde japones, frances, portugues u otros idiomas.

Reglas estrictas:
- Solo interpreta. No converses, no saludes, no hagas preguntas propias.
- Responde unicamente con la traduccion del discurso escuchado (texto/audio de salida = traduccion).
- Mantén el significado, el tono formal institucional y la brevedad.
- Only English and Spanish.
- Si el habla no es ingles ni espanol, intenta mapearlo a EN/ES solo si el sentido es claro; si no, permanece en silencio (no inventes traducciones a otros idiomas).`;

  if (mode === 'en-es') {
    return `${common}

Modo UNIDIRECCIONAL (solo un sentido): INGLES → ESPANOL.
Traduce ingles a espanol. Si oyes espanol, permanece en silencio. Ignora cualquier otro idioma.`;
  }
  if (mode === 'es-en') {
    return `${common}

Modo UNIDIRECCIONAL (solo un sentido): ESPANOL → INGLES.
Traduce espanol a ingles. Si oyes ingles, permanece en silencio. Ignora cualquier otro idioma.`;
  }
  return `${common}

Modo CONVERSACION BIDIRECCIONAL (EN ↔ ES) — por defecto para charlas con Q&A.
- Si oyes INGLES → traduce SIEMPRE a ESPANOL (subtitulos + salida).
- Si oyes ESPANOL → traduce SIEMPRE a INGLES (subtitulos + salida).
- NUNCA permanezcas en silencio solo porque oyes el "otro" idioma: ambos sentidos deben traducirse.
- Esto incluye preguntas del publico en espanol (deben salir en ingles para el orador) y respuestas en ingles (deben salir en espanol para la audiencia).
- Preferencia solo si hay ambiguedad extrema de deteccion: sesgo hacia ${biasLabel}.
- Nunca produzcas salida en un idioma que no sea ingles o espanol.`;
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
            text:
              mode === 'auto'
                ? `Bidirectional EN↔ES conversation mode for live Q&A. If you hear English, translate to Spanish. If you hear Spanish, translate to English. NEVER stay silent because you heard the "other" language — always translate both ways. Audience bias when ambiguous: ${target}. Only English and Spanish.`
                : `Only English and Spanish. One-way mode toward ${target}. Detect which of the two is spoken and translate to the selected target ${target}. Do not translate to or from any other language.`,
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
    onEvent({ type: 'interim', role: 'translation', text: interimOut });
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
    onEvent({
      type: 'transcript',
      role: 'translation',
      text: outputText,
      finished: Boolean(sc.turnComplete || outputObj?.finished),
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
