export type TranslateMode = 'en-es' | 'es-en' | 'auto';

/** Idioma de origen: auto = Conversación EN↔ES; en/es = solo un sentido */
export type SourceLang = 'auto' | 'es' | 'en';

/** Idioma de destino (solo EN/ES) */
export type TargetLang = 'es' | 'en';

export type AppStatus =
  | 'idle'
  | 'ready'
  | 'connecting'
  | 'listening'
  | 'stopped'
  | 'disconnected'
  | 'error';

export interface HistoryItem {
  id: string;
  original: string;
  translation: string;
  mode: TranslateMode;
  detectedLang?: string;
  ts: string;
}

export interface PartialSubtitles {
  original: string;
  translation: string;
}

export interface ServerMessage {
  type: string;
  status?: string;
  message?: string;
  mode?: TranslateMode | string;
  targetLang?: TargetLang | string;
  model?: string;
  hasApiKey?: boolean;
  reason?: string;
  role?: 'original' | 'translation';
  text?: string;
  original?: string;
  translation?: string;
  id?: string;
  detectedLang?: string;
  ts?: string;
}

/** Deriva el modo WS (compatible) desde el selector origen/destino. */
export function deriveMode(source: SourceLang, target: TargetLang): TranslateMode {
  if (source === 'auto') return 'auto';
  if (source === 'en' && target === 'es') return 'en-es';
  if (source === 'es' && target === 'en') return 'es-en';
  // Si origen === destino (no debería), forzar auto
  return 'auto';
}

/** Idioma de salida TTS preferido según modo + destino UI. */
export function targetLangFromUi(source: SourceLang, target: TargetLang): TargetLang {
  if (source === 'auto') return target;
  return target;
}
