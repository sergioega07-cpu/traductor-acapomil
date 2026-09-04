# Traductor ACAPOMIL

Traduccion de voz **EN ↔ ES** en tiempo real para presentaciones y Smart TV.

Arquitectura: **microfono PCM → Gemini Live (streaming) → WebSocket → UI + proyeccion LAN**.

- Subtitulos visibles (original + traduccion)
- Modo proyeccion inalambrica (Samsung TV / navegador en la misma WiFi)
- Selector de microfono
- Modos: Ingles→Espanol, Espanol→Ingles, AUTO (conversacion EN ↔ ES)

La clave `GEMINI_API_KEY` vive **solo en el servidor** (archivo `.env`). Nunca se expone al cliente. Uso pensado para **red local (LAN)** unicamente.

## Requisitos

- Node.js 20+
- Microfono y navegador moderno (Chrome / Edge recomendados)
- Clave de API de [Google AI Studio](https://aistudio.google.com/apikey)

## Instalacion

```bash
git clone https://github.com/sergioega07-cpu/traductor-acapomil.git
cd traductor-acapomil
git pull
cp .env.example .env
# Edita .env y pega tu GEMINI_API_KEY=

npm install
npm install --prefix server
npm install --prefix client
```

## Ejecutar en desarrollo

Desde la raiz del repo:

```bash
npm run dev
```

Esto levanta:

- **Servidor** Express + WebSocket en `0.0.0.0:3001` (ruta `/ws`) — accesible en LAN
- **Cliente** Vite en `0.0.0.0:5173` (proxy de `/api` y `/ws` al servidor)

Abre el panel de control en el Mac: `http://localhost:5173`.

> El backend escucha en `0.0.0.0` y Vite usa `server.host: true` para que la TV abra la app por IP de LAN.

Tambien puedes correr por separado:

```bash
npm run dev:server
npm run dev:client
```

## Proyeccion inalambrica (Samsung TV - sin HDMI)

Como el calendario de oficina: abres una URL en el navegador del televisor.

1. Mac y TV en la **misma WiFi**.
2. En el Mac: git pull (si hace falta) y arranca el entorno de desarrollo.
3. Abre el panel de control en el Mac (puerto 5173 en desarrollo).
4. Copia la **URL de proyeccion** con el boton **Copiar URL TV**.
5. En el Samsung TV: abre el **navegador** y pega esa URL (mode=projection).
6. En la proyeccion, pulsa **pantalla completa** (boton en la cabecera) si el TV no tiene F11.
7. En el Mac: autoriza el microfono y pulsa **Iniciar traduccion**.

Los subtitulos llegan por **WebSocket** (relay en el servidor). La pagina de proyeccion envia hello con role projection y recibe los mismos partial / final / status que el control. No hace falta HDMI ni BroadcastChannel entre dispositivos.

**Seguridad:** solo LAN; la clave Gemini permanece en el servidor.

### Si la TV no carga

- Comprueba que Mac y TV estan en la misma red (no WiFi de invitados aislada).
- En la consola del servidor deberias ver la IP LAN.
- El endpoint de LAN lista las IPs usadas para armar la URL.
- Permite Node en los puertos 5173 y 3001 en el firewall del Mac.

## Produccion (opcional)

```bash
npm run build
npm start
```

El servidor sirve el build de `client/dist` y el WebSocket en el mismo puerto (`PORT`, por defecto 3001, en `0.0.0.0`). En produccion la URL TV suele ser el mismo host con mode=projection.

## Como usar (panel Mac)

1. Autoriza el microfono (boton o selector de dispositivo).
2. Elige el modo de idioma (EN→ES, ES→EN o AUTO).
3. Pulsa **Iniciar traduccion** y habla.
4. Veras subtitulos en vivo (original + traduccion).
5. **Modo proyeccion**: ventana local o URL en la TV (ver seccion inalambrica arriba).

## Arquitectura tecnica

```
Mac (control + mic)              Servidor Node                 Google
------------------              -------------                 ------
getUserMedia
AudioWorklet → PCM 16kHz
base64/JSON  ──WebSocket──►  @google/genai live.connect
                             sendRealtimeInput(audio)
                             ◄── inputTranscription
                             ◄── outputTranscription
            ◄── partial/final ──
                             ── fan-out ──►  TV (role: projection)
UI control                                   ProjectionView
```

- La proyeccion **prefiere WebSocket**; BroadcastChannel queda como respaldo solo en el mismo navegador/dispositivo.
- **No** se usa la Web Speech API del navegador como STT principal.
- Un solo camino de streaming Live.

### Modelos Live

El servidor intenta, en orden:

1. `gemini-3.5-live-translate-preview` (modos EN→ES / ES→EN, con `translationConfig`)
2. `gemini-3.1-flash-live-preview` (AUTO y respaldo; instruccion de sistema de interprete)
3. Otros modelos Live documentados si los anteriores fallan

Si un nombre de modelo no esta disponible en tu proyecto/region, el servidor prueba el siguiente y registra el fallo en consola.

### Protocolo WebSocket (resumen)

Cliente → servidor:

- `{ "type": "hello", "role": "control"|"projection" }`
- `{ "type": "start", "mode": "en-es"|"es-en"|"auto", "targetLang"? }`
- `{ "type": "audio", "data": "<base64 PCM 16-bit LE mono 16kHz>" }`
- `{ "type": "audio_end" }` / `{ "type": "stop" }`
- `{ "type": "set_mode", "mode" }`
- `{ "type": "project", "payload": { ... } }` — sync UI opcional hacia proyeccion

Servidor → cliente (control y todos los projection):

- `{ "type": "status", "status", "model?", "hasApiKey?" }`
- `{ "type": "partial", "original", "translation" }`
- `{ "type": "final", "id", "original", "translation", "mode", "ts" }`
- `{ "type": "clear" }` (al detener)
- `{ "type": "error", "message" }`

API auxiliar:

- `GET /api/lan` → `{ ips, port, clientPort }` para armar la URL TV

## Limitaciones conocidas (Gemini Live)

- Sesiones de audio limitadas en el tiempo (~15 min sin compresion de contexto); para actos largos, detener e iniciar de nuevo.
- La calidad de la deteccion AUTO depende del modelo; en actos formales conviene fijar EN→ES o ES→EN.
- Latencia de unos segundos (tipico de traduccion simultanea streaming).
- Hace falta `GEMINI_API_KEY` valida con acceso a la API Live / modelos preview.
- Usa auriculares al probar para evitar eco / autointerrupcion.

## Estructura

```
traductor-acapomil/
  client/          React + TypeScript + Vite + Tailwind
  server/          Express + ws + @google/genai
  .env.example
  package.json     scripts concurrentes
```

## Licencia

Uso interno ACAPOMIL.
