// The `/ai/config/<path>` settings requests the admin AI-config screens send
// (chat model tiers, custom tiers, hidden models, single-model settings,
// Claude settings).
//
// Each helper sends exactly the request the screens used to send inline and
// hands the Response back untouched: callers keep reading `res.ok`, the
// status and the body as before.

import { API_BASE, authFetch } from '../utils/helpers';

/** GET /ai/config/<path> */
export function getAiConfig(path: string): Promise<Response> {
    return authFetch(`${API_BASE}/ai/config/${path}`);
}

/** POST /ai/config/<path> with a JSON body. */
export function postAiConfig(path: string, body: unknown): Promise<Response> {
    return authFetch(`${API_BASE}/ai/config/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}
