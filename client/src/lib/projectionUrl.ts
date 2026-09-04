/**
 * Build a copyable URL for the Samsung TV (or any LAN browser) projection page.
 */
export async function resolveProjectionUrl(): Promise<string> {
  const projectionPath = '/?mode=projection';
  const host = window.location.hostname;

  if (host && host !== 'localhost' && host !== '127.0.0.1') {
    const port = window.location.port ? `:${window.location.port}` : '';
    return `${window.location.protocol}//${host}${port}${projectionPath}`;
  }

  try {
    const res = await fetch('/api/lan');
    if (res.ok) {
      const data = (await res.json()) as { ips?: string[]; clientPort?: number; port?: number };
      const ip = data.ips?.[0];
      if (ip) {
        // In DEV the TV must open the Vite client (5173), which proxies /ws + /api
        const isDev = import.meta.env.DEV;
        const port = isDev ? data.clientPort || 5173 : data.port || 3001;
        return `http://${ip}:${port}${projectionPath}`;
      }
    }
  } catch {
    /* fall through */
  }

  return `${window.location.origin}${projectionPath}`;
}
