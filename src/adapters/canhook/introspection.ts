import crypto from 'node:crypto';
import type { Introspection, TokenIntrospector } from '../../contracts/index.js';

export interface IntrospectionOptions {
  url: string;
  secret: string;
  cacheTtlMs: number;
}

/** RFC 7662 response as the CanHook PHP authorization server returns it. */
type Rfc7662 = { active: boolean; sub?: number | string; scope?: string; client_id?: string; aud?: string | string[]; exp?: number };

const INACTIVE: Introspection = { active: false, scopes: [] };

/**
 * Validate bearer tokens by introspection against the CanHook authorization
 * server. Results are cached briefly, keyed by sha256(token), so a revoked
 * token stops working within the cache window — not indefinitely.
 */
export function createIntrospector(opts: IntrospectionOptions): TokenIntrospector & { clearCache(): void } {
  const cache = new Map<string, { value: Introspection; until: number }>();

  return {
    async introspect(token: string): Promise<Introspection> {
      if (!token) return INACTIVE;
      const key = crypto.createHash('sha256').update(token).digest('hex');
      const now = Date.now();
      const hit = cache.get(key);
      if (hit && hit.until > now) return hit.value;

      let value: Introspection = INACTIVE;
      try {
        const res = await fetch(opts.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-Introspection-Secret': opts.secret,
          },
          body: new URLSearchParams({ token }),
        });
        if (res.ok) {
          const json = (await res.json()) as Rfc7662;
          if (json?.active && json.sub) {
            value = {
              active: true,
              userId: Number(json.sub),
              scopes: (json.scope ?? '').split(' ').filter(Boolean),
              clientId: json.client_id,
              audience: json.aud === undefined ? undefined : ([] as string[]).concat(json.aud),
              expiresAt: json.exp,
            };
          }
        }
      } catch {
        value = INACTIVE;
      }
      cache.set(key, { value, until: now + opts.cacheTtlMs });
      return value;
    },
    clearCache() {
      cache.clear();
    },
  };
}
