import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { WebSocketServer } from 'ws';
import { isValidTranslationText, openLiveSession, sanitizeTranslationText } from './geminiLive.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const PORT = Number(process.env.PORT || 3001);
const apiKey = process.env.GEMINI_API_KEY || '';

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    hasApiKey: Boolean(apiKey),
    service: 'traductor-acapomil',
  });
});

const clientDist = path.resolve(__dirname, '../../client/dist');
app.use(express.static(clientDist));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/ws')) return next();
  res.sendFile(path.join(clientDist, 'index.html'), (err) => {
    if (err) next();
  });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

wss.on('connection', (ws) => {
  let live = null;
  let mode = 'auto';
  let targetLang = 'es';
  let originalBuf = '';
  let translationBuf = '';
  let turnId = 0;
  let audioChunkCount = 0;
  let lastAudioLogAt = 0;

  send(ws, {
    type: 'status',
    status: 'ready',
    hasApiKey: Boolean(apiKey),
  });

  const flushTurn = (force = false) => {
    const original = originalBuf.trim();
    let translation = sanitizeTranslationText(translationBuf);
    // Never flush a turn whose "translation" is a language code / garbage
    if (translationBuf.trim() && !translation) {
      console.warn('[flush] dropping invalid translation:', JSON.stringify(translationBuf));
      translationBuf = '';
      translation = '';
    }
    if (!original && !translation) return;
    // Avoid finals that only have garbage/empty translation unless forced with original only
    if (!force && (!original || !translation)) return;
    if (force && original && !translation) {
      // Keep original for display but do not invent a translation — client won't TTS empty
      console.warn('[flush] turn complete without valid translation; sending original only');
    }
    turnId += 1;
    send(ws, {
      type: 'final',
      id: `t-${Date.now()}-${turnId}`,
      original,
      translation,
      mode,
      detectedLang: guessLang(original, mode),
      ts: new Date().toISOString(),
    });
    originalBuf = '';
    translationBuf = '';
  };

  ws.on('message', async (raw, isBinary) => {
    try {
      if (isBinary) {
        if (live) {
          live.sendAudioBase64(Buffer.from(raw).toString('base64'));
        }
        return;
      }

      const msg = JSON.parse(String(raw));

      if (msg.type === 'start') {
        if (!apiKey) {
          send(ws, {
            type: 'error',
            message:
              'Falta GEMINI_API_KEY en el servidor. Copia .env.example a .env y agrega tu clave de Google AI Studio.',
          });
          return;
        }
        if (live) {
          live.close();
          live = null;
        }
        mode = normalizeMode(msg.mode);
        targetLang = normalizeTargetLang(msg.targetLang, mode);
        originalBuf = '';
        translationBuf = '';
        audioChunkCount = 0;
        lastAudioLogAt = 0;
        send(ws, { type: 'status', status: 'connecting', mode, targetLang });

        live = await openLiveSession({
          apiKey,
          mode,
          targetLang,
          onEvent: (ev) => {
            if (ev.type === 'status') {
              send(ws, ev);
              return;
            }
            if (ev.type === 'interim') {
              if (ev.role === 'translation' && !isValidTranslationText(ev.text)) {
                return;
              }
              send(ws, {
                type: 'interim',
                role: ev.role,
                text: ev.text,
                mode,
              });
              return;
            }
            if (ev.type === 'transcript') {
              if (ev.role === 'original') {
                // Los transcripts de Live suelen ser acumulativos por turno
                originalBuf = ev.text;
              } else if (ev.role === 'translation') {
                const clean = sanitizeTranslationText(ev.text);
                if (!clean) {
                  // Keep previous valid translationBuf; do not overwrite with "es"
                  return;
                }
                translationBuf = clean;
              }
              send(ws, {
                type: 'partial',
                original: originalBuf,
                translation: translationBuf,
                mode,
                role: ev.role,
              });
              return;
            }
            if (ev.type === 'turn_complete') {
              flushTurn(true);
              send(ws, { type: 'turn_complete' });
              return;
            }
            if (ev.type === 'interrupted') {
              send(ws, { type: 'interrupted' });
            }
          },
          onError: (message) => {
            send(ws, { type: 'error', message: `Gemini Live: ${message}` });
          },
          onClose: (reason) => {
            send(ws, { type: 'status', status: 'disconnected', reason });
            live = null;
          },
        });

        send(ws, {
          type: 'status',
          status: 'listening',
          mode,
          targetLang,
          model: live.model,
        });
        return;
      }

      if (msg.type === 'audio') {
        if (live && msg.data) {
          audioChunkCount += 1;
          const now = Date.now();
          if (now - lastAudioLogAt >= 2000) {
            console.log(`[audio] chunks received: ${audioChunkCount} (session total)`);
            lastAudioLogAt = now;
          }
          live.sendAudioBase64(msg.data);
        }
        return;
      }

      if (msg.type === 'audio_end') {
        if (live) live.sendAudioStreamEnd();
        return;
      }

      if (msg.type === 'stop') {
        if (live) {
          try {
            live.sendAudioStreamEnd();
          } catch (_) {}
          flushTurn(true);
          live.close();
          live = null;
        }
        send(ws, { type: 'status', status: 'stopped' });
        return;
      }

      if (msg.type === 'set_mode') {
        mode = normalizeMode(msg.mode);
        targetLang = normalizeTargetLang(msg.targetLang, mode);
        send(ws, { type: 'status', status: 'mode', mode, targetLang });
        // Cambio de modo con sesion activa: el cliente debe detener e iniciar de nuevo.
        if (live) {
          send(ws, {
            type: 'status',
            status: 'mode',
            mode,
            targetLang,
            message: 'Modo actualizado. Detén e inicia de nuevo para aplicar el cambio en Gemini Live.',
          });
        }
      }
    } catch (err) {
      console.error(err);
      send(ws, {
        type: 'error',
        message: err?.message || 'Error procesando mensaje WebSocket',
      });
    }
  });

  ws.on('close', () => {
    if (live) {
      live.close();
      live = null;
    }
  });
});

function normalizeMode(mode) {
  if (mode === 'es-en' || mode === 'es→en' || mode === 'ES_EN') return 'es-en';
  if (mode === 'en-es' || mode === 'en→es' || mode === 'EN_ES') return 'en-es';
  return 'auto';
}

function normalizeTargetLang(targetLang, mode) {
  if (targetLang === 'en' || targetLang === 'es') return targetLang;
  if (mode === 'es-en') return 'en';
  return 'es';
}

function guessLang(text, mode) {
  if (mode === 'en-es') return 'en';
  if (mode === 'es-en') return 'es';
  const sample = (text || '').toLowerCase();
  const esHits = (sample.match(/[áéíóúñ¿¡]|(\b(el|la|de|que|y|en|los|se|del|las|un|por|con|para|una|es|al)\b)/g) || []).length;
  const enHits = (sample.match(/\b(the|and|is|to|of|in|that|it|for|on|with|as|was|are|this)\b/g) || []).length;
  if (esHits > enHits) return 'es';
  if (enHits > esHits) return 'en';
  return 'auto';
}

server.listen(PORT, () => {
  console.log(`[traductor-acapomil] HTTP+WS en http://localhost:${PORT}`);
  console.log(`[traductor-acapomil] GEMINI_API_KEY: ${apiKey ? 'configurada' : 'AUSENTE'}`);
});
