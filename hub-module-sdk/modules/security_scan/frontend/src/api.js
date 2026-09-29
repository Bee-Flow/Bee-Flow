/**
 * Module API surface.
 *
 * Every call to the module's own server goes through `/api/mod/security_scan`
 * (the host dispatcher strips that prefix and forwards to the module server).
 * We use plain same-origin fetch — the session cookie authenticates us — so the
 * module never imports the host's authFetch.
 *
 * The one exception is the tiers probe, which is a HOST endpoint (`/ai/config/
 * tiers-for-user`); it is same-origin too, just not under the module prefix.
 */

// Base for the module's own server. The dispatcher mounts the module here and
// strips this prefix, so a module route like `/scans/active` is reached as
// `${API_BASE}/scans/active`.
export const API_BASE = '/api/mod/security_scan';

// Host tiers endpoint (same-origin, NOT under the module prefix). Mounted on the
// host at `/ai` → `/ai/config/tiers-for-user`.
export const HOST_TIERS_URL = '/ai/config/tiers-for-user';

/** Same-origin fetch against the module server. `path` starts with `/`. */
export function apiFetch(path, options = {}) {
    return fetch(`${API_BASE}${path}`, { credentials: 'same-origin', ...options });
}

/** Same-origin fetch against an absolute host path (e.g. the tiers probe). */
export function hostFetch(path, options = {}) {
    return fetch(path, { credentials: 'same-origin', ...options });
}

/**
 * POST `${API_BASE}/toolbox/provision` and stream progress events back.
 *
 * The response body is a stream of progress records. We tolerate both bare
 * newline-delimited JSON (`{"phase":"pull","line":"…","pct":42}\n`) and SSE
 * framing (`data: {…}\n`). Each parsed record is handed to `onEvent`. A line
 * that isn't JSON is surfaced as `{ line }` so raw tool output still shows.
 *
 * Assumed record shape (aligned with the server agent): `{ phase, line, pct }`,
 * optionally a terminal `{ done: true, ok?, error? }`.
 *
 * @param {'build'|'pull'} mode
 * @param {(evt: object) => void} onEvent
 * @param {AbortSignal} [signal]
 */
export async function streamProvision(mode, onEvent, signal) {
    const res = await fetch(`${API_BASE}/toolbox/provision`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
        signal,
    });

    if (!res.ok || !res.body) {
        let msg = `HTTP ${res.status}`;
        try {
            const j = await res.json();
            msg = j?.error || j?.message || msg;
        } catch (_) { /* non-JSON error body */ }
        throw new Error(msg);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    const emitLine = (raw) => {
        let line = raw.trim();
        if (!line) return;
        if (line.startsWith('data:')) line = line.slice(5).trim();
        if (!line || line === '[DONE]') return;
        try { onEvent(JSON.parse(line)); }
        catch (_) { onEvent({ line }); }
    };

    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
            emitLine(buf.slice(0, idx));
            buf = buf.slice(idx + 1);
        }
    }
    if (buf) emitLine(buf);
}
