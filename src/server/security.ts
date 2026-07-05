/**
 * Security middleware — DNS-rebinding / CSRF defence (design §7).
 *
 * The server binds loopback only and ships no auth. To stop a malicious web
 * page from driving the local API via the browser, every request must carry a
 * `Host` header pointing at loopback; state-changing requests (POST) must also
 * carry a same-origin `Origin`. CORS is never opened.
 */

import type { MiddlewareHandler } from 'hono';

/** Hostnames accepted as loopback. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

export interface SecurityOptions {
  /** Port the server listens on; used to validate the `Host`/`Origin` port. */
  port: number;
}

/**
 * Extract the hostname from a `Host` header value, handling IPv6 brackets and
 * optional `:port`. Returns `{ host, port }` or null when unparseable.
 */
function parseHostHeader(value: string): { host: string; port?: string } | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  // IPv6 literal, e.g. [::1]:8787
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    if (end === -1) return null;
    const host = trimmed.slice(1, end);
    const rest = trimmed.slice(end + 1);
    const port = rest.startsWith(':') ? rest.slice(1) : undefined;
    return { host, port };
  }
  const colon = trimmed.indexOf(':');
  if (colon === -1) return { host: trimmed };
  return { host: trimmed.slice(0, colon), port: trimmed.slice(colon + 1) };
}

/** True when the `Host` header targets loopback on the expected port. */
export function isHostAllowed(hostHeader: string | undefined, port: number): boolean {
  if (!hostHeader) return false;
  const parsed = parseHostHeader(hostHeader);
  if (!parsed) return false;
  if (!LOOPBACK_HOSTS.has(parsed.host)) return false;
  // If a port is present it must match; an absent port is tolerated.
  if (parsed.port !== undefined && parsed.port !== String(port)) return false;
  return true;
}

/** True when the `Origin` header is same-origin loopback on the expected port. */
export function isOriginAllowed(originHeader: string | undefined, port: number): boolean {
  if (!originHeader) return false;
  let url: URL;
  try {
    url = new URL(originHeader);
  } catch {
    return false;
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) return false;
  if (url.port && url.port !== String(port)) return false;
  return true;
}

/** True for requests that mutate state and therefore require Origin validation. */
function isStateChanging(method: string): boolean {
  const m = method.toUpperCase();
  return m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE';
}

export function createSecurityMiddleware(options: SecurityOptions): MiddlewareHandler {
  const { port } = options;
  return async (c, next) => {
    if (!isHostAllowed(c.req.header('host'), port)) {
      return c.text('Forbidden: invalid Host header', 403);
    }
    if (isStateChanging(c.req.method) && !isOriginAllowed(c.req.header('origin'), port)) {
      return c.text('Forbidden: invalid Origin header', 403);
    }
    await next();
  };
}
