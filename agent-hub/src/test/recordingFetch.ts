// A global `fetch` stub that records every request (method, address, JSON
// body) and answers through the test's own function: the network seam for a
// panel test, instead of mocking a module. Restore with vi.unstubAllGlobals().

import { vi } from 'vitest';

export interface RecordedCall {
    method: string;
    url: string;
    body: unknown;
}

/** A JSON answer as the api client reads it. */
export function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Stub `fetch`; `answer` gets each call and returns its response. The returned list fills as requests are made. */
export function stubRecordingFetch(answer: (call: RecordedCall) => Response): RecordedCall[] {
    const calls: RecordedCall[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
        const call: RecordedCall = {
            method: init?.method ?? 'GET',
            url: String(url),
            body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        };
        calls.push(call);
        return answer(call);
    }));
    return calls;
}
