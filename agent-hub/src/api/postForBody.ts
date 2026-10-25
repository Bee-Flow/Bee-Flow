// A request whose caller acts on the answer's JSON body whatever the status:
// the server explains a refusal in the body (`code`, `error`, `attemptsLeft`),
// and the screen shows that, not a generic failure. `mutate` throws on a
// non-2xx; this turns the refusal back into `{ ok: false, body }`. A body that
// is not JSON reads as `{}`; a network failure still throws.

import { mutate, errorBody, RefusedError, type JsonBody } from './mutate';

export async function postForBody(url: string, init: Parameters<typeof mutate>[1]): Promise<{ ok: boolean; body: JsonBody }> {
    try {
        const res = await mutate(url, init);
        return { ok: true, body: await res.json().catch(() => ({})) };
    } catch (err) {
        if (!(err instanceof RefusedError)) throw err;
        return { ok: false, body: errorBody(err) ?? {} };
    }
}
