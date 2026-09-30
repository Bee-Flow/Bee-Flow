/**
 * The Compliance Center's one network seam (redesign, Sep 2026).
 *
 * Every hook under data/ reads and writes through `fetchJson` — never a bare
 * fetch. authFetch already sends `credentials: 'include'`, so behaviour in the
 * product is unchanged; but it is also the single seam the public demo
 * transport (demo/ComplianceDemo.jsx + demo/fixtures/compliance.js) can
 * intercept. A bare fetch here would go to the real /api/compliance as an
 * anonymous visitor from the demo at /__demo__, which is exactly the failure
 * the transport is built to make impossible.
 *
 * Downloads are the one thing the transport cannot stand in for: a PDF or zip
 * is a plain `<a href download>` — a browser navigation — so the demo hides
 * the affordance instead of handing a visitor a 401 page. `downloadUrl` is
 * that switch; the pages already treat a null url as "no download button".
 */
import { authFetch } from '../../../../utils/helpers';

export const API = (import.meta.env.VITE_API_URL || '') + '/api/compliance';
export const API_DSR = (import.meta.env.VITE_API_URL || '') + '/api/dsr';
export const OPTS = Object.freeze({ credentials: 'include' });

/**
 * A refused request throws an Error whose message stays `"<status> <statusText>"`
 * (callers test it with /^404\b/), and which also carries what the server
 * said: `status`, `code` and `serverMessage` from its `{ error, code }` body,
 * so a control can word the refusal instead of saying only "failed".
 */
export async function fetchJson(url, init) {
    const r = await authFetch(url, { ...OPTS, ...(init || {}) });
    if (!r.ok) {
        const err = new Error(`${r.status} ${r.statusText}`);
        let body = null;
        try { body = typeof r.json === 'function' ? await r.json() : null; } catch { body = null; }
        err.status = r.status;
        err.code = body && typeof body.code === 'string' ? body.code : null;
        err.serverMessage = body && typeof body.error === 'string' ? body.error : null;
        throw err;
    }
    return r.json();
}

/** `{ method, headers, body }` for a JSON write; `body` undefined → `'{}'` so an empty POST still parses server-side. */
export function jsonInit(method, body) {
    return {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? '{}' : JSON.stringify(body),
    };
}

/** Shorthand for the common case. */
export const json = (body) => jsonInit('POST', body);

/** A download url, or null when exports are switched off (the public demo). */
export function downloadUrl(exportsEnabled, url) {
    return exportsEnabled ? url : null;
}

/**
 * Tolerant unwrap for the aggregate endpoints (/counts, /attention,
 * /deadlines, /frameworks, /calendar). Before the backend for one of them has
 * landed — and in the nav test, which mocks every non-/overview url as `[]` —
 * the body is an array or junk. A hook must then render NOTHING for that data
 * (never a "0"), so this returns null for anything that is not a plain object.
 */
export function asObject(body) {
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
}

/** Same rule for list endpoints: anything that is not an array reads as "not loaded". */
export function asArray(body) {
    return Array.isArray(body) ? body : null;
}
