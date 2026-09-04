export type TranslateMode = 'en-es' | 'es-en' | 'auto';

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
