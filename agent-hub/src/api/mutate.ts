// A checked mutation. `authFetch` resolves on every HTTP answer, 4xx and 5xx
// included, so a POST/PUT/PATCH/DELETE caller that does not read `res.ok`
// shows success when the server refused. `mutate` is `authFetch` with that
// check built in: on a 2xx it hands back the very same Response (the success
// path of a converted caller is unchanged), on anything else it throws an
// `ApiError` carrying the server's `{ error }` text, so the caller's existing
// catch (toast, error state) shows it.
//
// Unlike `apiClient` it takes the URL and RequestInit exactly as `authFetch`
// does and never retries: a mutation is not idempotent, and a converted call
// site must send the same request it sent before.
//
// `node scripts/count-ratchet.mjs unchecked-mutation agent-hub --list` shows
// the call sites that still ignore the answer. `API_BASE` and `authFetch` are
// re-exported so a converted caller can keep a single HTTP import.

import type { AuthFetchOptions } from '../utils/helpers';
import { API_BASE, authFetch } from '../utils/helpers';
import { ApiError } from './client';

/** The server's error text from a non-2xx body, or `HTTP <status>`. */
async function errorText(res: Response): Promise<{ message: string; body: unknown }> {
    let body: unknown = null;
    try {
        body = await res.json();
    } catch {
        /* not JSON */
    }
    const b = body as { error?: unknown; message?: unknown } | null;
    const fromBody =
        (typeof b?.error === 'string' && b.error) ||
        (typeof b?.message === 'string' && b.message) ||
        '';
    return { message: fromBody || `HTTP ${res.status}`, body };
}

export async function mutate(url: string, init: AuthFetchOptions = {}): Promise<Response> {
    const res: Response = await authFetch(url, init);
    if (res.ok) return res;
    const { message, body } = await errorText(res);
    throw new ApiError(message, { status: res.status, body });
}

export { ApiError, API_BASE, authFetch };
