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

/** IPv4 LAN addresses (non-internal) for TV / wireless projection / remote mic URLs */
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
// LAN / Smart TV / iPhone browsers may open from http://192.168.x.x — allow any origin on private network
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

/** Returns LAN IPs so the control UI can show copyable TV / mic URLs */
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
/** Clients that subscribed as remote mic (iPhone / phone on LAN) */
const micClients = new Set();

/**
 * Single shared live session for the presentation.
 * Control starts/stops; control + mic sockets may feed audio into the same Gemini Live.
 */
let session = {
  live: null,
  mode: 'auto',
  targetLang: 'es',
  originalBuf: '',
  translationBuf: '',
  turnId: 0,
  audioChunkCount: 0,
  lastAudioLogAt: 0,
  /** @type {import('ws').WebSocket | null} */
  controlWs: null,
};

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function broadcastToProjection(payload) {
  for (const client of projectionClients) {
    send(client, payload);
  }
}

function broadcastToMic(payload) {
  for (const client of micClients) {
    send(client, payload);
  }
}

/** Send to the owning control socket and mirror to every projection client */
function sendControlAndProjection(payload) {
  if (session.controlWs) send(session.controlWs, payload);
  broadcastToProjection(payload);
}

/** Status / errors also reach remote mic pages */
function sendControlProjectionAndMic(payload) {
  sendControlAndProjection(payload);
  if (payload.type === 'status' || payload.type === 'error') {
    broadcastToMic(payload);
  }
}

function resetSessionBuffers() {
  session.originalBuf = '';
  session.translationBuf = '';
  session.audioChunkCount = 0;
  session.lastAudioLogAt = 0;
}

function closeLiveSession() {
  if (session.live) {
    try {
      session.live.close();
    } catch (_) {}
    session.live = null;
  }
}

function flushTurn(force = false) {
  const original = session.originalBuf.trim();
  let translation = sanitizeTranslationText(session.translationBuf);
  if (session.translationBuf.trim() && !translation) {
    console.warn('[flush] dropping invalid translation:', JSON.stringify(session.translationBuf));
    session.translationBuf = '';
    translation = '';
  }
  if (!original && !translation) return;
  if (!force && (!original || !translation)) return;
  if (force && original && !translation) {
    console.warn('[flush] turn complete without valid translation; sending original only');
  }
  session.turnId += 1;
  sendControlAndProjection({
    type: 'final',
    id: `t-${Date.now()}-${session.turnId}`,
    original,
    translation,
    mode: session.mode,
    detectedLang: guessLang(original, session.mode),
    ts: new Date().toISOString(),
  });
  session.originalBuf = '';
  session.translationBuf = '';
}

/**
 * Feed PCM base64 into the active Gemini Live session.
 * @returns {boolean} true if accepted
 */
function feedAudioBase64(dataB64, fromWs) {
  if (!session.live) {
    const now = Date.now();
    if (!fromWs._lastNoLiveErr || now - fromWs._lastNoLiveErr > 3000) {
      fromWs._lastNoLiveErr = now;
      send(fromWs, {
        type: 'error',
        message: 'Inicia traducción en el Mac primero',
      });
    }
    return false;
  }
  fromWs._lastNoLiveErr = 0;
  if (!dataB64) return false;
  session.audioChunkCount += 1;
  const now = Date.now();
  if (now - session.lastAudioLogAt >= 2000) {
    console.log(`[audio] chunks received: ${session.audioChunkCount} (session total)`);
    session.lastAudioLogAt = now;
  }
  session.live.sendAudioBase64(dataB64);
  return true;
}

wss.on('connection', (ws) => {
  /** @type {'control' | 'projection' | 'mic'} */
  let role = 'control';

  send(ws, {
    type: 'status',
    status: 'ready',
    hasApiKey: Boolean(apiKey),
    role,
    liveActive: Boolean(session.live),
  });

  ws.on('message', async (raw, isBinary) => {
    try {
      if (isBinary) {
        if (role === 'projection') return;
        feedAudioBase64(Buffer.from(raw).toString('base64'), ws);
        return;
      }

      const msg = JSON.parse(String(raw));

      if (msg.type === 'hello') {
        const requested =
          msg.role === 'projection' ? 'projection' : msg.role === 'mic' ? 'mic' : 'control';
        if (role === 'projection') projectionClients.delete(ws);
        if (role === 'mic') micClients.delete(ws);
        role = requested;
        if (role === 'projection') {
          projectionClients.add(ws);
          console.log(`[ws] projection client connected (${projectionClients.size} total)`);
        } else if (role === 'mic') {
          micClients.add(ws);
          console.log(`[ws] mic client connected (${micClients.size} total)`);
        }
        send(ws, {
          type: 'status',
          status: 'ready',
          hasApiKey: Boolean(apiKey),
          role,
          liveActive: Boolean(session.live),
        });
        // If translation already running, tell mic/projection immediately
        if (session.live && (role === 'mic' || role === 'projection')) {
          send(ws, {
            type: 'status',
            status: 'listening',
            mode: session.mode,
            targetLang: session.targetLang,
            model: session.live.model,
            liveActive: true,
          });
        }
        return;
      }

      // Control can push arbitrary UI sync payloads to projection screens
      if (msg.type === 'project') {
        if (role !== 'control') return;
        const payload = msg.payload != null ? msg.payload : msg;
        broadcastToProjection(
          typeof payload === 'object' && payload.type
            ? payload
            : { type: 'project', payload }
        );
        return;
      }

      // Projection: receive-only
      if (role === 'projection') return;

      // Mic: only audio (+ hello already handled)
      if (role === 'mic') {
        if (msg.type === 'audio') {
          feedAudioBase64(msg.data, ws);
        } else if (msg.type === 'audio_end') {
          if (session.live) session.live.sendAudioStreamEnd();
        } else if (msg.type === 'start' || msg.type === 'stop' || msg.type === 'set_mode') {
          send(ws, {
            type: 'error',
            message: 'Inicia o detén la traducción desde el Mac (panel de control).',
          });
        }
        return;
      }

      // —— control role below ——
      // Keep control ownership on the Mac panel that issues commands
      session.controlWs = ws;

      if (msg.type === 'start') {
        if (!apiKey) {
          sendControlProjectionAndMic({
            type: 'error',
            message:
              'Falta GEMINI_API_KEY en el servidor. Copia .env.example a .env y agrega tu clave de Google AI Studio.',
          });
          return;
        }
        closeLiveSession();
        session.controlWs = ws;
        session.mode = normalizeMode(msg.mode);
        session.targetLang = normalizeTargetLang(msg.targetLang, session.mode);
        resetSessionBuffers();
        sendControlProjectionAndMic({
          type: 'status',
          status: 'connecting',
          mode: session.mode,
          targetLang: session.targetLang,
          liveActive: false,
        });

        session.live = await openLiveSession({
          apiKey,
          mode: session.mode,
          targetLang: session.targetLang,
          onEvent: (ev) => {
            if (ev.type === 'status') {
              sendControlProjectionAndMic(ev);
              return;
            }
            if (ev.type === 'interim') {
              if (ev.role === 'translation' && !isValidTranslationText(ev.text)) {
                return;
              }
              sendControlAndProjection({
                type: 'interim',
                role: ev.role,
                text: ev.text,
                mode: session.mode,
              });
              return;
            }
            if (ev.type === 'transcript') {
              if (ev.role === 'original') {
                session.originalBuf = ev.text;
              } else if (ev.role === 'translation') {
                const clean = sanitizeTranslationText(ev.text);
                if (!clean) {
                  return;
                }
                session.translationBuf = clean;
              }
              sendControlAndProjection({
                type: 'partial',
                original: session.originalBuf,
                translation: session.translationBuf,
                mode: session.mode,
                role: ev.role,
              });
              return;
            }
            if (ev.type === 'turn_complete') {
              flushTurn(true);
              sendControlAndProjection({ type: 'turn_complete' });
              return;
            }
            if (ev.type === 'interrupted') {
              sendControlAndProjection({ type: 'interrupted' });
            }
          },
          onError: (message) => {
            sendControlProjectionAndMic({ type: 'error', message: `Gemini Live: ${message}` });
          },
          onClose: (reason) => {
            sendControlProjectionAndMic({
              type: 'status',
              status: 'disconnected',
              reason,
              liveActive: false,
            });
            session.live = null;
          },
        });

        sendControlProjectionAndMic({
          type: 'status',
          status: 'listening',
          mode: session.mode,
          targetLang: session.targetLang,
          model: session.live.model,
          liveActive: true,
        });
        return;
      }

      if (msg.type === 'audio') {
        feedAudioBase64(msg.data, ws);
        return;
      }

      if (msg.type === 'audio_end') {
        if (session.live) session.live.sendAudioStreamEnd();
        return;
      }

      if (msg.type === 'stop') {
        if (session.live) {
          try {
            session.live.sendAudioStreamEnd();
          } catch (_) {}
          flushTurn(true);
          closeLiveSession();
        }
        sendControlProjectionAndMic({ type: 'status', status: 'stopped', liveActive: false });
        broadcastToProjection({ type: 'clear' });
        return;
      }

      if (msg.type === 'set_mode') {
        session.mode = normalizeMode(msg.mode);
        session.targetLang = normalizeTargetLang(msg.targetLang, session.mode);
        sendControlProjectionAndMic({
          type: 'status',
          status: 'mode',
          mode: session.mode,
          targetLang: session.targetLang,
        });
        if (session.live) {
          sendControlProjectionAndMic({
            type: 'status',
            status: 'mode',
            mode: session.mode,
            targetLang: session.targetLang,
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
      return;
    }
    if (role === 'mic') {
      micClients.delete(ws);
      console.log(`[ws] mic client disconnected (${micClients.size} left)`);
      return;
    }
    // Control disconnect: end live session if this socket owned it
    if (session.controlWs === ws) {
      closeLiveSession();
      session.controlWs = null;
      broadcastToProjection({ type: 'status', status: 'disconnected', liveActive: false });
      broadcastToMic({ type: 'status', status: 'disconnected', liveActive: false });
      broadcastToProjection({ type: 'clear' });
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

// Bind 0.0.0.0 so LAN devices (Samsung TV / iPhone) can reach the API/WS
server.listen(PORT, '0.0.0.0', () => {
  const lans = getLanIPs();
  console.log(`[traductor-acapomil] HTTP+WS en http://0.0.0.0:${PORT} (localhost + LAN)`);
  if (lans.length) {
    console.log(`[traductor-acapomil] LAN: ${lans.map((ip) => `http://${ip}:${PORT}`).join(', ')}`);
  }
  console.log(`[traductor-acapomil] GEMINI_API_KEY: ${apiKey ? 'configurada' : 'AUSENTE'}`);
});
