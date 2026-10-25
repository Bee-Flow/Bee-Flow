// `mutate` for a caller that BRANCHES on the answer instead of catching it:
// the shape of the `const res = await authFetch(...); if (res.ok) {...} else {...}`
// code it replaces. A 2xx comes back as `{ ok: true, res }`, a refusal as
// `{ ok: false, status, body }` (the server's JSON body); a network failure
// still throws, like authFetch did.
//
// `nonJson` is what the old code did with a refusal whose body is not JSON:
// `'throw'` for `await res.json()` (the caller's catch ran), `'empty'` for
// `await res.json().catch(() => ({}))` (body is `{}`).

import type { AuthFetchOptions } from '../utils/helpers';
import { mutate, RefusedError, errorBody, type JsonBody } from './mutate';

export type Settled =
    | { ok: true; res: Response }
    | { ok: false; status: number; body: JsonBody };

export async function settled(url: string, init?: AuthFetchOptions, nonJson: 'throw' | 'empty' = 'throw'): Promise<Settled> {
    try {
        return { ok: true, res: await mutate(url, init) };
    } catch (err) {
        if (!(err instanceof RefusedError)) throw err;
        const body = errorBody(err);
        if (body == null) {
            if (nonJson === 'throw') throw err;
            return { ok: false, status: err.status, body: {} };
        }
        return { ok: false, status: err.status, body };
    }
}
