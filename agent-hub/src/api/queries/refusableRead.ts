// The read shape of a hand-written `request(url).catch(RefusedError -> null)`:
// a refusal (non-2xx) is an answer of null, which the caller renders as
// "nothing to show" or its own message; a network failure rejects, so the
// query is in error. Shared by the admin lists that all read this way.

import { request, RefusedError } from '../mutate';

/** GET `url`; the parsed JSON, or null when the server refused. */
export async function readOrNull<T>(url: string, signal?: AbortSignal): Promise<T | null> {
    try {
        return (await (await request(url, { signal })).json()) as T;
    } catch (err) {
        if (err instanceof RefusedError) return null;
        throw err;
    }
}
