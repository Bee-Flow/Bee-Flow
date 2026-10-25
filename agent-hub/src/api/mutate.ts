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
import { logger } from '../utils/logger';

/** The server's error text from a non-2xx body, or `HTTP <status>`. */
async function errorText(res: Response): Promise<{ message: string; body: unknown }> {
    let body: unknown = null;
    try {
        body = await res.json();
    } catch (err) { logger.debug('not JSON', err); }
    const b = body as { error?: unknown; message?: unknown } | null;
    const fromBody =
        (typeof b?.error === 'string' && b.error) ||
        (typeof b?.message === 'string' && b.message) ||
        '';
    return { message: fromBody || `HTTP ${res.status}`, body };
}

/**
 * What mutate() throws for a refused request: an ApiError whose `status` is always set, so a catch
 * that narrows with `instanceof RefusedError` reads `err.status` as a number, like `res.status`.
 */
export class RefusedError extends ApiError {}
// The type of `status` only, as an interface merge: a `declare` field is a syntax the mobile package's
// Babel (which loads this file in its lockstep tests) does not accept.
export interface RefusedError {
    status: number;
}

export async function mutate(url: string, init?: AuthFetchOptions): Promise<Response> {
    // The call is passed on exactly as written: a GET without options reaches authFetch(url), not authFetch(url, {}).
    const res: Response = init === undefined ? await authFetch(url) : await authFetch(url, init);
    if (res.ok) return res;
    const { message, body } = await errorText(res);
    throw new RefusedError(message, { status: res.status, body });
}

/** What `await res.json()` resolves to (`any` in lib.dom): the shape callers already annotate. */
export type JsonBody = Awaited<ReturnType<Response['json']>>;

/**
 * The JSON body of a refused request, as `await res.json()` gave it: mutate() has already read it,
 * so a caller that wanted `await res.json().catch(() => X)` writes `errorBody(err) ?? X` (null when
 * the body was not JSON).
 */
export function errorBody(err: ApiError): JsonBody | null {
    return (err.body ?? null) as JsonBody | null;
}

/** The same checked request under a name that does not say "mutation": for a GET whose answer is checked. */
export const request = mutate;

export { ApiError, API_BASE, authFetch };
