/** Shared fakes for the embed's tests: a JSON reply and a streamed reply, both as fetch answers. */

export const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => '' }) as unknown as Response;

/** A fetch answer whose body streams `text` in one chunk (a 500 when `ok` is false). */
export function streamResponseOf(text: string, ok = true): Response {
    const chunks = [new TextEncoder().encode(text)];
    let i = 0;
    return {
        ok,
        status: ok ? 200 : 500,
        body: { getReader: () => ({ read: () => Promise.resolve(i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }) }) },
    } as unknown as Response;
}
