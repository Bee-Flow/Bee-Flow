// A fake Bee Flow server for the form test overlay's tests (FormRunOverlay.*,
// ExecutionView.attach): the global fetch is replaced, so the real api/client,
// authFetch and react-query paths run, and nothing is mocked through the
// module system.
//
//   const server = fakeServer((call) => {
//       if (call.path === '/api/automation/runs/r1/form') return { body: { runId: 'r1', status: 'success' } };
//   });
//   ... server.calls.filter(c => c.method === 'POST')
//
// An unanswered request is a 404. A FormData body is kept as it is.
import { vi } from 'vitest';

export interface FakeCall {
    method: string;
    url: string;
    /** The path, without the API base's origin and the query string. */
    path: string;
    /** The parsed JSON body, or the FormData / raw value as sent. */
    body: unknown;
}

export interface FakeReply {
    status?: number;
    body?: unknown;
}

export type FakeHandler = (call: FakeCall) => FakeReply | undefined | null;

/** Saved form scenarios and their limits: the picker on every page asks for them. */
export const NO_SCENARIOS: FakeReply = { body: { scenarios: [], limits: { max: 50 } } };

function parse(body: unknown): unknown {
    if (typeof body !== 'string') return body;
    try { return JSON.parse(body); } catch { return body; }
}

export function fakeServer(handler: FakeHandler) {
    const calls: FakeCall[] = [];
    const fetchMock = vi.fn(async (input: string | URL, init: RequestInit = {}) => {
        const url = String(input);
        const call: FakeCall = { method: (init.method || 'GET').toUpperCase(), url, path: new URL(url, 'http://app.test').pathname, body: parse(init.body) };
        calls.push(call);
        const reply = handler(call) ?? (call.path.endsWith('/form-scenarios') ? NO_SCENARIOS : { status: 404, body: { error: 'Not found' } });
        const status = reply.status ?? 200;
        const json = reply.body ?? {};
        return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    return {
        calls,
        fetchMock,
        /** The writes sent so far, oldest first. */
        posts: () => calls.filter(c => c.method === 'POST'),
    };
}
