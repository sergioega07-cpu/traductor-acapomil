# Traductor ACAPOMIL

Traduccion de voz **EN ↔ ES** en tiempo real para presentaciones y Smart TV.

Arquitectura: **microfono PCM → Gemini Live (streaming) → WebSocket → UI**.

- Subtitulos visibles (original + traduccion)
- Modo proyeccion (pantalla completa / TV)
- "Escuchar subtitulo" con TTS del navegador (`speechSynthesis`)
- Selector de microfono, historial de sesion, copiar / limpiar
- Modos: Ingles→Espanol, Espanol→Ingles, AUTO (deteccion de idioma)

La clave `GEMINI_API_KEY` vive **solo en el servidor** (archivo `.env`). Nunca se expone al cliente.

## Requisitos

- Node.js 20+
- Microfono y navegador moderno (Chrome / Edge recomendados)
- Clave de API de [Google AI Studio](https://aistudio.google.com/apikey)

## Instalacion

```bash
git clone https://github.com/sergioega07-cpu/traductor-acapomil.git
cd traductor-acapomil
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

- **Servidor** Express + WebSocket en `http://localhost:3001` (ruta `/ws`)
- **Cliente** Vite en `http://localhost:5173` (proxy de `/api` y `/ws` al servidor)

Abre `http://localhost:5173`.

Tambien puedes correr por separado:

```bash
npm run dev:server
npm run dev:client
```

## Produccion (opcional)

```bash
npm run build
npm start
```

El servidor sirve el build de `client/dist` y el WebSocket en el mismo puerto (`PORT`, por defecto 3001).

## Como usar

1. Autoriza el microfono (boton o selector de dispositivo).
2. Elige el modo de idioma (EN→ES, ES→EN o AUTO).
3. Pulsa **Iniciar traduccion** y habla.
4. Veras subtitulos en vivo (original + traduccion) y el historial por turnos.
5. Pulsa **Escuchar** en una tarjeta o **Escuchar subtitulo** para TTS local.
6. **Modo proyeccion**: abre una ventana grande (ideal para TV / proyector). Se sincroniza con la ventana de control mediante `BroadcastChannel`.

### Modo proyeccion

- Boton **MODO PROYECCION** en la UI de control, o abre `/?mode=projection`.
- Muestra la traduccion en tipografia grande, apta para fullscreen (F11).
- Incluye control **Escuchar subtitulo** para el presentador.

## Arquitectura tecnica

```
Navegador                     Servidor Node                    Google
---------                     -------------                    ------
getUserMedia
AudioWorklet → PCM 16kHz
base64/JSON  ──WebSocket──►  @google/genai live.connect
                             sendRealtimeInput(audio)
                             ◄── inputTranscription (original)
                             ◄── outputTranscription (traduccion)
            ◄── partial/final ──
UI + BroadcastChannel
speechSynthesis (TTS opcional)
```

- **No** se usa la Web Speech API del navegador como STT principal.
- Un solo camino de streaming Live (sin duplicar REST + Live por el mismo turno).
- TTS opcional: `window.speechSynthesis` en el cliente. El audio nativo de Gemini se ignora a proposito para subtitulos + control local de voz.

### Modelos Live

El servidor intenta, en orden:

1. `gemini-3.5-live-translate-preview` (modos EN→ES / ES→EN, con `translationConfig`)
2. `gemini-3.1-flash-live-preview` (AUTO y respaldo; instruccion de sistema de interprete)
3. Otros modelos Live documentados si los anteriores fallan

Si un nombre de modelo no esta disponible en tu proyecto/region, el servidor prueba el siguiente y registra el fallo en consola.

### Protocolo WebSocket (resumen)

Cliente → servidor:

- `{ "type": "start", "mode": "en-es"|"es-en"|"auto" }`
- `{ "type": "audio", "data": "<base64 PCM 16-bit LE mono 16kHz>" }`
- `{ "type": "audio_end" }` / `{ "type": "stop" }`
- `{ "type": "set_mode", "mode" }`

Servidor → cliente:

- `{ "type": "status", "status", "model?", "hasApiKey?" }`
- `{ "type": "partial", "original", "translation" }`
- `{ "type": "final", "id", "original", "translation", "mode", "ts" }`
- `{ "type": "error", "message" }`

## Limitaciones conocidas (Gemini Live)

- Sesiones de audio limitadas en el tiempo (~15 min sin compresion de contexto); para actos largos, detener e iniciar de nuevo.
- La calidad de la deteccion AUTO depende del modelo; en actos formales conviene fijar EN→ES o ES→EN.
- Latencia de unos segundos (tipico de traduccion simultanea streaming).
- El TTS del navegador depende de las voces instaladas en el SO.
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
