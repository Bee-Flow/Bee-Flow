// The `/api/languages` requests the admin Languages panel sends (locales,
// GUI strings, prompts, e-mail templates).
//
// Each helper sends exactly the request the panel used to send inline and
// hands the Response back untouched: callers keep reading `res.ok`, the
// status and the body as before.

import { API_BASE, authFetch } from '../utils/helpers';

export const LANGUAGES_API = `${API_BASE}/api/languages`;

const urlOf = (path: string) => (path ? `${LANGUAGES_API}/${path}` : LANGUAGES_API);

/** GET /api/languages[/<path>] */
export function getLanguages(path = ''): Promise<Response> {
    return authFetch(urlOf(path));
}

/** A body-less write, e.g. DELETE /api/languages/:code or PUT /:code/default. */
export function sendLanguages(method: 'DELETE' | 'PUT', path: string): Promise<Response> {
    return authFetch(urlOf(path), { method });
}

/** A JSON write to /api/languages[/<path>]. */
export function sendLanguagesJson(method: 'POST' | 'PUT' | 'PATCH', path: string, body: unknown): Promise<Response> {
    return authFetch(urlOf(path), {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}
