/**
 * twobaApi.mts: one authenticated call to the 2BA API (https://api.2ba.nl/1/json,
 * or /1/streaming for a file upload) with the bearer token of a connection
 * (twobaAuth.mts). A 401 gets one more try with a fresh token; every other
 * failure becomes a TwobaError (twobaTransport.mts). Resolves to the parsed
 * JSON, or null for an empty body.
 *
 * Only what the caller passes goes to 2BA. The tools pass article data (GLN,
 * trade item ids, GTINs, quantities, a project number), a database id and a
 * condition file: never a user name, an e-mail address or an organisation name.
 */

import { accessTokenFor, forgetToken, type TwobaConfig } from './twobaAuth.mts';
import { API_BASE, STREAMING_BASE, TwobaError, errorForStatus, safeText, twobaFetch } from './twobaTransport.mts';

export interface Connection {
    userId: string;
    cfg: TwobaConfig;
}

export interface ApiOptions {
    query?: Record<string, string | number | boolean | undefined>;
    /** A JSON body. */
    json?: unknown;
    /** A multipart body, built fresh per attempt. */
    form?: () => FormData;
    /** The streaming host (uploads) instead of the JSON API. */
    streaming?: boolean;
    timeoutMs?: number;
}

function urlFor(path: string, opts: ApiOptions): string {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query || {})) if (v !== undefined) params.set(k, String(v));
    const qs = params.toString();
    return `${opts.streaming ? STREAMING_BASE : API_BASE}${path}${qs ? `?${qs}` : ''}`;
}

/** One call. `path` starts with '/' and holds no caller text: variable parts go in `query`. */
export async function twobaApi(conn: Connection, method: string, path: string, opts: ApiOptions = {}): Promise<unknown> {
    if (!path.startsWith('/') || path.includes('?')) throw new TwobaError(500, 'twoba_internal', 'internal: bad path.');
    const url = urlFor(path, opts);
    const body = opts.form ?? (opts.json === undefined ? undefined : JSON.stringify(opts.json));
    for (let attempt = 0; ; attempt += 1) {
        const token = await accessTokenFor(conn.userId, conn.cfg, { force: attempt > 0 });
        const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
        if (opts.json !== undefined) headers['Content-Type'] = 'application/json';
        const response = await twobaFetch(url, { method, headers, body, timeoutMs: opts.timeoutMs });
        if (response.status === 401 && attempt === 0) {
            forgetToken(conn.userId);
            continue;
        }
        const text = await safeText(response);
        if (!response.ok) throw errorForStatus(response.status, text);
        if (!text.trim()) return null;
        try {
            return JSON.parse(text) as unknown;
        } catch {
            throw new TwobaError(502, 'twoba_bad_answer', '2BA sent an answer that could not be read.');
        }
    }
}
