# Traductor ACAPOMIL

Traduccion de voz **EN ↔ ES** en tiempo real para presentaciones y Smart TV.

Arquitectura: **microfono PCM → Gemini Live (streaming) → WebSocket → UI + proyeccion LAN + mic remoto**.

- Subtitulos visibles (original + traduccion)
- Modo proyeccion inalambrica (Samsung TV / navegador en la misma WiFi)
- **Microfono remoto por LAN** (iPhone Safari en otra habitacion)
- Selector de microfono local del Mac (opcional)
- Modos: Ingles→Espanol, Espanol→Ingles, AUTO (conversacion EN ↔ ES)

La clave `GEMINI_API_KEY` vive **solo en el servidor** (archivo `.env`). Nunca se expone al cliente. Uso pensado para **red local (LAN)** unicamente.

## Requisitos

- Node.js 20+
- Microfono y navegador moderno (Chrome / Edge en Mac; Safari en iPhone)
- Mac, TV e iPhone en la **misma WiFi**
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

> El backend escucha en `0.0.0.0` y Vite usa `server.host: true` para que la TV y el iPhone abran la app por IP de LAN.

Tambien puedes correr por separado:

```bash
npm run dev:server
npm run dev:client
```

## Flujo recomendado (Mac + TV + iPhone)

1. Actualiza el repo (git pull) y arranca el entorno de desarrollo en el Mac.
2. Abre el panel de control en el Mac en el puerto 5173.
3. Copia la URL de proyeccion y pegala en el televisor (misma WiFi).
4. Copia la URL de microfono y abrila en Safari del telefono (misma WiFi, otra habitacion).
5. En el telefono: Permitir microfono.
6. En el Mac: elige idiomas, desactiva Microfono local del Mac si solo usas el telefono, y pulsa Iniciar traduccion.
7. En el telefono: pulsa Enviar audio y habla. Los subtitulos aparecen en la TV.

Orden tipico: Mac inicia sesion Gemini; telefono envia PCM; TV recibe partial/final por el relay WS.

Si el telefono envia audio sin sesion activa, el servidor responde: Inicia traduccion en el Mac primero.

### HTTPS / getUserMedia en iPhone

Prueba primero http://192.168.x.x:5173/?mode=mic en Safari (misma WiFi). En muchos iOS recientes el acceso al microfono funciona en red local tras un gesto del usuario.

Si Safari bloquea el microfono por contexto no seguro:

1. En Ajustes > Safari, revisa permisos de microfono para el sitio.
2. Como respaldo, puedes servir Vite con HTTPS autofirmado (vite-plugin-basic-ssl) y aceptar el aviso en el telefono.
3. No hace falta Continuity ni AirPlay: el audio viaja por WebSocket a la sesion Gemini del Mac.

## Proyeccion inalambrica (Samsung TV - sin HDMI)

Como el calendario de oficina: abres una URL en el navegador del televisor.

1. Mac y TV en la **misma WiFi**.
2. En el Mac: git pull (si hace falta) y arranca el entorno de desarrollo.
3. Abre el panel de control en el Mac (puerto 5173 en desarrollo).
4. Copia la **URL de proyeccion** con el boton **Copiar URL TV**.
5. En el Samsung TV: abre el **navegador** y pega esa URL (mode=projection).
6. En la proyeccion, pulsa **pantalla completa** (boton en la cabecera) si el TV no tiene F11.
7. Inicia la traduccion en el Mac; el audio puede venir del Mac o del iPhone remoto.

Los subtitulos llegan por **WebSocket** (relay en el servidor). La pagina de proyeccion envia hello con role projection y recibe los mismos partial / final / status que el control. No hace falta HDMI ni BroadcastChannel entre dispositivos.

**Seguridad:** solo LAN; la clave Gemini permanece en el servidor.

### Si la TV o el iPhone no cargan

- Comprueba que Mac, TV e iPhone estan en la misma red (no WiFi de invitados aislada).
- En la consola del servidor deberias ver la IP LAN.
- El endpoint GET /api/lan lista las IPs usadas para armar las URLs.
- Permite Node en los puertos 5173 y 3001 en el firewall del Mac.

## Produccion (opcional)

```bash
npm run build
npm start
```

El servidor sirve el build de `client/dist` y el WebSocket en el mismo puerto (`PORT`, por defecto 3001, en `0.0.0.0`). En produccion las URLs TV/mic suelen ser el mismo host con ?mode=projection o ?mode=mic.

## Como usar (panel Mac)

1. (Opcional) Autoriza el microfono local, o desactivalo para usar solo el iPhone.
2. Elige el modo de idioma (EN→ES, ES→EN o AUTO).
3. Pulsa **Iniciar traduccion**.
4. Veras subtitulos en vivo (original + traduccion).
5. **Modo proyeccion**: URL en la TV. **Mic remoto**: URL en el iPhone (?mode=mic).

## Arquitectura tecnica

```
iPhone (?mode=mic)     Mac (control)           Servidor Node              Google
------------------     -------------           -------------              ------
getUserMedia           start/stop (+mic opt)
AudioWorklet 16kHz
hello role:mic
audio b64 --WebSocket-----------------------> sesion Live compartida
                                               @google/genai live.connect
                                               sendRealtimeInput(audio)
            <-- status/error --               -- fan-out --> TV (projection)
UI control (Mac)                               ProjectionView
```

- Roles WS: `control` | `projection` | `mic`.
- Una sola sesion Gemini Live activa; control y mic pueden alimentar el mismo stream.
- La proyeccion **prefiere WebSocket**; BroadcastChannel queda como respaldo solo en el mismo navegador/dispositivo.
- **No** se usa Continuity ni la Web Speech API como STT principal.

### Modelos Live

El servidor intenta, en orden:

1. `gemini-3.5-live-translate-preview` (modos EN→ES / ES→EN, con `translationConfig`)
2. `gemini-3.1-flash-live-preview` (AUTO y respaldo; instruccion de sistema de interprete)
3. Otros modelos Live documentados si los anteriores fallan

Si un nombre de modelo no esta disponible en tu proyecto/region, el servidor prueba el siguiente y registra el fallo en consola.

### Protocolo WebSocket (resumen)

Cliente → servidor:

- `{ "type": "hello", "role": "control"|"projection"|"mic" }`
- `{ "type": "start", "mode": "en-es"|"es-en"|"auto", "targetLang"? }` — solo control
- `{ "type": "audio", "data": "<base64 PCM 16-bit LE mono 16kHz>" }` — control o mic
- `{ "type": "audio_end" }` / `{ "type": "stop" }` — stop solo control
- `{ "type": "set_mode", "mode" }` — solo control
- `{ "type": "project", "payload": { ... } }` — sync UI opcional hacia proyeccion

Servidor → cliente:

- `{ "type": "status", "status", "model?", "hasApiKey?", "liveActive?" }` (tambien a mic)
- `{ "type": "partial", "original", "translation" }` (control + projection)
- `{ "type": "final", "id", "original", "translation", "mode", "ts" }`
- `{ "type": "clear" }` (al detener)
- `{ "type": "error", "message" }` — p. ej. *Inicia traduccion en el Mac primero*

API auxiliar:

- `GET /api/lan` → `{ ips, port, clientPort }` para armar las URLs TV y mic

## Limitaciones conocidas (Gemini Live)

- Sesiones de audio limitadas en el tiempo (~15 min sin compresion de contexto); para actos largos, detener e iniciar de nuevo.
- La calidad de la deteccion AUTO depende del modelo; en actos formales conviene fijar EN→ES o ES→EN.
- Latencia de unos segundos (tipico de traduccion simultanea streaming).
- Hace falta `GEMINI_API_KEY` valida con acceso a la API Live / modelos preview.
- Usa auriculares al probar el mic del Mac para evitar eco / autointerrupcion.

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
