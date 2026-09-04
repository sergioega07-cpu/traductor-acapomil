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

function targetLangForMode(mode) {
  if (mode === 'es-en') return 'en';
  return 'es'; // en-es and auto default to Spanish audience
}

function systemInstructionForMode(mode) {
  const common = `Eres un interprete simultaneo EN/ES para presentaciones en vivo.
Reglas estrictas:
- Solo interpreta. No converses, no saludes, no hagas preguntas.
- Responde unicamente con la traduccion hablada del discurso del usuario.
- Mantén el significado, el tono formal institucional y la brevedad.`;
  if (mode === 'en-es') {
    return `${common}\nModo: INGLES a ESPANOL. Traduce solo ingles a espanol. Si oyes espanol, permanece en silencio.`;
  }
  if (mode === 'es-en') {
    return `${common}\nModo: ESPANOL a INGLES. Traduce solo espanol a ingles. Si oyes ingles, permanece en silencio.`;
  }
  return `${common}\nModo: AUTO. Detecta el idioma (ingles o espanol) y traduce al otro idioma.`;
}

/**
 * Abre una sesion Gemini Live y reenvia audio PCM + textos al cliente via callbacks.
 */
export async function openLiveSession({ apiKey, mode, onEvent, onError, onClose }) {
  const ai = new GoogleGenAI({ apiKey });
  const useTranslate = mode === 'en-es' || mode === 'es-en';
  const models = useTranslate ? TRANSLATE_MODELS : FLASH_MODELS;
  let lastError = null;

  for (const model of models) {
    try {
      const config = buildConfig(mode, model);
      const session = await ai.live.connect({
        model,
        config,
        callbacks: {
          onopen: () => {
            onEvent({ type: 'status', status: 'connected', model, mode });
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

function buildConfig(mode, model) {
  const isTranslateModel = model.includes('translate');

  if (isTranslateModel) {
    return {
      responseModalities: [Modality.AUDIO],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      translationConfig: {
        targetLanguageCode: targetLangForMode(mode),
        echoTargetLanguage: mode === 'auto',
      },
    };
  }

  // Flash Live: audio out + transcriptions = subtitulos; TTS del navegador para "Escuchar"
  return {
    responseModalities: [Modality.AUDIO],
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    systemInstruction: {
      parts: [{ text: systemInstructionForMode(mode) }],
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
