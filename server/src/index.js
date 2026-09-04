import http from 'http';
import os from 'os';
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

/** IPv4 LAN addresses (non-internal) for TV / wireless projection URLs */
function getLanIPs() {
  const ifaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      const family = iface.family;
      const isV4 = family === 'IPv4' || family === 4;
      if (isV4 && !iface.internal) {
        ips.push(iface.address);
      }
    }
  }
  return ips;
}

const app = express();
// LAN / Smart TV browsers may open from http://192.168.x.x — allow any origin on private network
app.use(
  cors({
    origin: true,
    credentials: false,
  })
);
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    hasApiKey: Boolean(apiKey),
    service: 'traductor-acapomil',
  });
});

/** Returns LAN IPs so the control UI can show a copyable TV projection URL */
app.get('/api/lan', (_req, res) => {
  res.json({
    ips: getLanIPs(),
    port: PORT,
    /** Vite dev client port (proxy /ws and /api here in development) */
    clientPort: 5173,
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

/** Clients that subscribed as projection (TV / second screen) */
const projectionClients = new Set();

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

/** Fan-out subtitle / status events to all projection sockets */
function broadcastToProjection(payload) {
  for (const client of projectionClients) {
    send(client, payload);
  }
}

/** Send to the control socket and mirror to every projection client */
function sendControlAndProjection(ws, payload) {
  send(ws, payload);
  broadcastToProjection(payload);
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
  /** @type {'control' | 'projection'} */
  let role = 'control';

  send(ws, {
    type: 'status',
    status: 'ready',
    hasApiKey: Boolean(apiKey),
    role,
  });

  const flushTurn = (force = false) => {
    const original = originalBuf.trim();
    let translation = sanitizeTranslationText(translationBuf);
    if (translationBuf.trim() && !translation) {
      console.warn('[flush] dropping invalid translation:', JSON.stringify(translationBuf));
      translationBuf = '';
      translation = '';
    }
    if (!original && !translation) return;
    if (!force && (!original || !translation)) return;
    if (force && original && !translation) {
      console.warn('[flush] turn complete without valid translation; sending original only');
    }
    turnId += 1;
    sendControlAndProjection(ws, {
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
        if (role === 'projection') return;
        if (live) {
          live.sendAudioBase64(Buffer.from(raw).toString('base64'));
        }
        return;
      }

      const msg = JSON.parse(String(raw));

      if (msg.type === 'hello') {
        const nextRole = msg.role === 'projection' ? 'projection' : 'control';
        if (role === 'projection') projectionClients.delete(ws);
        role = nextRole;
        if (role === 'projection') {
          projectionClients.add(ws);
          console.log(`[ws] projection client connected (${projectionClients.size} total)`);
        }
        send(ws, {
          type: 'status',
          status: 'ready',
          hasApiKey: Boolean(apiKey),
          role,
        });
        return;
      }

      // Control can push arbitrary UI sync payloads to projection screens
      if (msg.type === 'project') {
        if (role === 'projection') return;
        const payload = msg.payload != null ? msg.payload : msg;
        broadcastToProjection(
          typeof payload === 'object' && payload.type
            ? payload
            : { type: 'project', payload }
        );
        return;
      }

      // Projection clients only receive; ignore session/audio commands
      if (role === 'projection') return;

      if (msg.type === 'start') {
        if (!apiKey) {
          sendControlAndProjection(ws, {
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
        sendControlAndProjection(ws, { type: 'status', status: 'connecting', mode, targetLang });

        live = await openLiveSession({
          apiKey,
          mode,
          targetLang,
          onEvent: (ev) => {
            if (ev.type === 'status') {
              sendControlAndProjection(ws, ev);
              return;
            }
            if (ev.type === 'interim') {
              if (ev.role === 'translation' && !isValidTranslationText(ev.text)) {
                return;
              }
              sendControlAndProjection(ws, {
                type: 'interim',
                role: ev.role,
                text: ev.text,
                mode,
              });
              return;
            }
            if (ev.type === 'transcript') {
              if (ev.role === 'original') {
                originalBuf = ev.text;
              } else if (ev.role === 'translation') {
                const clean = sanitizeTranslationText(ev.text);
                if (!clean) {
                  return;
                }
                translationBuf = clean;
              }
              sendControlAndProjection(ws, {
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
              sendControlAndProjection(ws, { type: 'turn_complete' });
              return;
            }
            if (ev.type === 'interrupted') {
              sendControlAndProjection(ws, { type: 'interrupted' });
            }
          },
          onError: (message) => {
            sendControlAndProjection(ws, { type: 'error', message: `Gemini Live: ${message}` });
          },
          onClose: (reason) => {
            sendControlAndProjection(ws, { type: 'status', status: 'disconnected', reason });
            live = null;
          },
        });

        sendControlAndProjection(ws, {
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
        sendControlAndProjection(ws, { type: 'status', status: 'stopped' });
        broadcastToProjection({ type: 'clear' });
        return;
      }

      if (msg.type === 'set_mode') {
        mode = normalizeMode(msg.mode);
        targetLang = normalizeTargetLang(msg.targetLang, mode);
        sendControlAndProjection(ws, { type: 'status', status: 'mode', mode, targetLang });
        if (live) {
          sendControlAndProjection(ws, {
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
    if (role === 'projection') {
      projectionClients.delete(ws);
      console.log(`[ws] projection client disconnected (${projectionClients.size} left)`);
    }
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

// Bind 0.0.0.0 so LAN devices (Samsung TV browser) can reach the API/WS
server.listen(PORT, '0.0.0.0', () => {
  const lans = getLanIPs();
  console.log(`[traductor-acapomil] HTTP+WS en http://0.0.0.0:${PORT} (localhost + LAN)`);
  if (lans.length) {
    console.log(`[traductor-acapomil] LAN: ${lans.map((ip) => `http://${ip}:${PORT}`).join(', ')}`);
  }
  console.log(`[traductor-acapomil] GEMINI_API_KEY: ${apiKey ? 'configurada' : 'AUSENTE'}`);
});
