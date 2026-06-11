/**
 * Header source: a web `Headers` object (Next.js / fetch), a Node-style record
 * (`req.headers`), or a plain getter. Lets resolveReachUrl work in any backend.
 */
export type HeaderInput =
  | Headers
  | Record<string, string | string[] | undefined>
  | ((name: string) => string | null | undefined);

function getHeader(h: HeaderInput | undefined, name: string): string | undefined {
  if (!h) return undefined;
  if (typeof h === 'function') return h(name) ?? undefined;
  if (typeof (h as Headers).get === 'function') {
    return (h as Headers).get(name) ?? undefined;
  }
  const rec = h as Record<string, string | string[] | undefined>;
  const key = Object.keys(rec).find((k) => k.toLowerCase() === name.toLowerCase());
  const value = key ? rec[key] : undefined;
  return Array.isArray(value) ? value[0] : value;
}

/** True for addresses a phone on another device cannot reach. */
export function isLocalHost(host: string): boolean {
  let h = host.trim().toLowerCase();
  if (h.startsWith('[')) {
    // Bracketed IPv6, optionally with a port: [::1] or [::1]:3000.
    h = h.slice(1, h.indexOf(']') === -1 ? h.length : h.indexOf(']'));
  } else if ((h.match(/:/g) ?? []).length === 1) {
    // Exactly one colon means host:port. A bare IPv6 address has several, so
    // splitting it here would mangle ::1 into the empty string.
    h = h.split(':')[0]!;
  }
  return h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' || h === '::1' || h.endsWith('.local');
}

export interface ReachUrlOptions {
  /** A URL the operator has explicitly configured (a tailnet/LAN/domain URL). Wins over headers. */
  configuredUrl?: string | null;
  /** Request headers, used to derive the origin the caller reached this on. */
  headers?: HeaderInput;
  /** Fallback host when no host header is present. Defaults to "localhost". */
  defaultHost?: string;
}

/**
 * The best URL a device can use to reach this self hosted app.
 *
 * Order: an explicitly configured URL (e.g. a Tailscale `https://*.ts.net`
 * address the operator pasted in), otherwise the origin the current request
 * arrived on, honouring a reverse proxy's `x-forwarded-*` headers. Returns
 * without a trailing slash.
 *
 * Note: from inside a container the host's LAN IP is not knowable server-side;
 * for the "same Wi-Fi" case prefer the browser's `window.location` on the
 * client (see `clientReachUrl` in the react entry).
 */
export function resolveReachUrl(opts: ReachUrlOptions = {}): string {
  const configured = opts.configuredUrl?.trim();
  if (configured) return configured.replace(/\/+$/, '');

  const host =
    getHeader(opts.headers, 'x-forwarded-host') ??
    getHeader(opts.headers, 'host') ??
    opts.defaultHost ??
    'localhost';
  const protoHeader = getHeader(opts.headers, 'x-forwarded-proto');
  const proto = protoHeader ? protoHeader.split(',')[0]!.trim() : isLocalHost(host) ? 'http' : 'https';
  return `${proto}://${host}`;
}

/** Whether a resolved reach URL is private (LAN/tailnet/loopback) vs public. */
export function isPrivateReachUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    return (
      isLocalHost(host) ||
      host.endsWith('.ts.net') ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    );
  } catch {
    return false;
  }
}
