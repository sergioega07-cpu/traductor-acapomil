/**
 * Resolve WebSocket URL for control + projection clients.
 * - localhost DEV: direct to backend :3001 (avoids Vite WS proxy quirks on same machine)
 * - LAN / TV (hostname is a private IP or non-loopback): same host via Vite proxy / production
 */
export function wsUrl() {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.hostname;

  if (import.meta.env.DEV) {
    if (host === 'localhost' || host === '127.0.0.1') {
      return 'ws://127.0.0.1:3001/ws';
    }
    // TV / phone on same WiFi opened http://192.168.x.x:5173 — use Vite /ws proxy
    return `${proto}//${window.location.host}/ws`;
  }

  return `${proto}//${window.location.host}/ws`;
}
