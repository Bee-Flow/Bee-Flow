// A programmable server for the builder's run tests, through authFetch's own
// transport seam (utils/helpers setDemoTransport) rather than a module mock.
//
//   const server = installRunTransport((url, req) => {
//       if (url.endsWith('/runs/r1')) return json({ run: { id: 'r1', status: 'success' } });
//   });
//   ...
//   server.uninstall();
//
// A URL the route does not answer gets a 404, and every request is recorded
// (url, method, parsed JSON body) in `server.calls`.
import { setDemoTransport } from '@/utils/helpers';

export interface RecordedCall { url: string; method: string; body: unknown }
export type RunRoute = (url: string, req: RecordedCall) => Response | Promise<Response> | undefined | null;

/** A JSON Response with that status. */
export function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function parsed(body: unknown): unknown {
    if (typeof body !== 'string' || !body) return undefined;
    try { return JSON.parse(body); } catch { return body; }
}

export function installRunTransport(route: RunRoute) {
    const calls: RecordedCall[] = [];
    setDemoTransport(async (url: string, init: { method?: string; body?: unknown } = {}) => {
        const call = { url, method: String(init.method || 'GET').toUpperCase(), body: parsed(init.body) };
        calls.push(call);
        return (await route(url, call)) ?? json({ error: 'Not found' }, 404);
    });
    return {
        calls,
        /** The URLs requested so far, in order. */
        urls: () => calls.map(c => c.url),
        uninstall: () => { setDemoTransport(null); },
    };
}
