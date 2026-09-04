/**
 * Build a copyable LAN URL for projection (TV) or remote mic (iPhone) pages.
 */
async function resolveLanModeUrl(mode: 'projection' | 'mic'): Promise<string> {
  const path = `/?mode=${mode}`;
  const host = window.location.hostname;

  if (host && host !== 'localhost' && host !== '127.0.0.1') {
    const port = window.location.port ? `:${window.location.port}` : '';
    return `${window.location.protocol}//${host}${port}${path}`;
  }

  try {
    const res = await fetch('/api/lan');
    if (res.ok) {
      const data = (await res.json()) as { ips?: string[]; clientPort?: number; port?: number };
      const ip = data.ips?.[0];
      if (ip) {
        // In DEV the phone/TV must open the Vite client (5173), which proxies /ws + /api
        const isDev = import.meta.env.DEV;
        const port = isDev ? data.clientPort || 5173 : data.port || 3001;
        return `http://${ip}:${port}${path}`;
      }
    }
  } catch {
    /* fall through */
  }

  return `${window.location.origin}${path}`;
}

/** Samsung TV / second-screen projection page */
export async function resolveProjectionUrl(): Promise<string> {
  return resolveLanModeUrl('projection');
}

/** iPhone Safari remote microphone page (same WiFi as Mac) */
export async function resolveMicUrl(): Promise<string> {
  return resolveLanModeUrl('mic');
}
