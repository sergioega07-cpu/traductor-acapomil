import type { HistoryItem, PartialSubtitles, TranslateMode, AppStatus } from './types';

export const CHANNEL_NAME = 'traductor-acapomil';

export type SyncMessage =
  | { kind: 'partial'; partial: PartialSubtitles; mode: TranslateMode }
  | { kind: 'final'; item: HistoryItem }
  | { kind: 'status'; status: AppStatus; mode: TranslateMode }
  | { kind: 'history'; items: HistoryItem[] }
  | { kind: 'clear' }
  | { kind: 'speak'; text: string; lang: string; id?: string }
  | { kind: 'speak_stop' }
  | { kind: 'speak_follow'; on: boolean }
  | { kind: 'ping' };

export function createSyncChannel(onMessage: (msg: SyncMessage) => void) {
  if (typeof BroadcastChannel === 'undefined') {
    return {
      post: (_msg: SyncMessage) => {},
      close: () => {},
    };
  }
  const bc = new BroadcastChannel(CHANNEL_NAME);
  bc.onmessage = (ev) => {
    if (ev.data) onMessage(ev.data as SyncMessage);
  };
  return {
    post: (msg: SyncMessage) => bc.postMessage(msg),
    close: () => bc.close(),
  };
}
