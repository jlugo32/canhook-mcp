import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { HostError } from '../../contracts/index.js';

// Map the PHP internal API's typed errors to readable messages the agent can relay.
const MESSAGES: Record<string, string> = {
  plan_limit: 'Plan limit reached — upgrade your plan to do this.',
  relay_disabled: 'Relay requires a paid plan.',
  ssrf_blocked: 'Destination blocked by the SSRF guard (private/reserved IP addresses are not allowed).',
  not_found: 'Not found.',
  unauthorized: 'The internal API rejected this request.',
};

export interface InternalApiOptions {
  /** Loopback base, e.g. http://127.0.0.1/internal — PHP 404s non-loopback callers. */
  baseUrl: string;
  /** Public vhost name; OLS routes loopback requests by Host. */
  hostHeader: string;
  secret: string;
}

export type InternalCall = (
  userId: number,
  method: 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
) => Promise<any>;

// node:http instead of fetch: undici's fetch silently drops a custom Host
// header, but OLS needs Host to route the canhook vhost on loopback requests.
function rawRequest(
  url: URL,
  method: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; text: string }> {
  const lib = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = lib(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers,
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: data }));
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/**
 * Client for the CanHook PHP internal write API. Adds the shared secret and the
 * introspection-derived user id. The SSRF guard and plan limits live only in
 * PHP; this client has no outbound-URL logic of its own.
 */
export function createInternalApi(opts: InternalApiOptions): InternalCall {
  return async (userId, method, path, body) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const res = await rawRequest(new URL(opts.baseUrl + path), method, {
      Host: opts.hostHeader,
      'Content-Type': 'application/json',
      'X-Internal-Secret': opts.secret,
      'X-CanHook-User': String(userId),
      ...(payload !== undefined ? { 'Content-Length': String(Buffer.byteLength(payload)) } : {}),
    }, payload);
    let json: any = {};
    try {
      json = JSON.parse(res.text);
    } catch {
      json = {};
    }
    const ok = res.status >= 200 && res.status < 300;
    if (!ok || (json && json.error)) {
      const code = (json && json.error) || 'error';
      const message = (json && json.message) || MESSAGES[code] || `Request failed (HTTP ${res.status}).`;
      throw new HostError(code, message);
    }
    return json;
  };
}
