import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * authFetch reloads the page on a 401 only when the session is really gone.
 * It asks GET /auth/user first: a session that is still valid means one
 * endpoint refused (an integration test call whose upstream answered 401, a
 * route with its own gate), and reloading would throw away whatever the
 * person was typing without bringing them anywhere new.
 */
const RELOAD_FLAG = 'bf_auth_reload_at';

type Route = { status: number; body?: unknown };

let authFetch: typeof import('./helpers').authFetch;
let reload: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;

/** Answer by pathname; anything unlisted is a 200 with an empty object. */
const respond = (routes: Record<string, Route>) => {
    fetchMock = vi.fn(async (url: string) => {
        const { pathname } = new URL(url, 'http://localhost');
        const route = routes[pathname] || { status: 200 };
        return new Response(JSON.stringify(route.body ?? {}), { status: route.status });
    });
    vi.stubGlobal('fetch', fetchMock);
};

const calledPaths = (): string[] => fetchMock.mock.calls.map(([url]) => new URL(String(url), 'http://localhost').pathname);

beforeEach(async () => {
    vi.resetModules();
    sessionStorage.clear();
    reload = vi.fn();
    // An in-app route: on a public marketing path the reload is suppressed
    // outright, which would make every case pass for the wrong reason.
    vi.stubGlobal('location', { reload, origin: 'http://localhost', href: 'http://localhost/app/agents', pathname: '/app/agents' });
    ({ authFetch } = await import('./helpers'));
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('authFetch 401: session check before the reload', () => {
    it('hands the 401 to the caller when the session is still valid', async () => {
        respond({
            '/api/x': { status: 401, body: { error: 'Upstream refused the credentials' } },
            '/auth/user': { status: 200, body: { authenticated: true, user: { id: 'u1' } } },
        });

        const res = await authFetch('/api/x');

        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: 'Upstream refused the credentials' });
        expect(calledPaths()).toEqual(['/api/x', '/auth/user']);
        expect(reload).not.toHaveBeenCalled();
        expect(sessionStorage.getItem(RELOAD_FLAG)).toBeNull();
    });

    it('reloads once when the session check says nobody is signed in', async () => {
        respond({
            '/api/x': { status: 401 },
            '/auth/user': { status: 200, body: { authenticated: false, user: null } },
        });

        const res = await authFetch('/api/x');

        expect(res.status).toBe(401);
        expect(reload).toHaveBeenCalledTimes(1);
    });

    it('reloads once when both the call and the session check answer 401', async () => {
        respond({ '/api/x': { status: 401 }, '/auth/user': { status: 401 } });

        await authFetch('/api/x');

        expect(calledPaths()).toEqual(['/api/x', '/auth/user']);
        expect(reload).toHaveBeenCalledTimes(1);
    });

    it('gives ten simultaneous 401s one session check and one reload', async () => {
        respond({ '/api/x': { status: 401 }, '/auth/user': { status: 200, body: { authenticated: false } } });

        await Promise.all(Array.from({ length: 10 }, () => authFetch('/api/x')));

        expect(calledPaths().filter((path) => path === '/auth/user')).toHaveLength(1);
        expect(reload).toHaveBeenCalledTimes(1);
    });

    it('does not take a path that only appears in the query string for an exempt route', async () => {
        respond({ '/api/x': { status: 401 }, '/auth/user': { status: 200, body: { authenticated: false } } });

        await authFetch('/api/x?return=/setup/&from=/auth/login');

        expect(reload).toHaveBeenCalledTimes(1);
    });

    it('sends the embed session token along with the session check', async () => {
        sessionStorage.setItem('bf_session_token', 'embed-token');
        respond({ '/api/x': { status: 401 }, '/auth/user': { status: 200, body: { authenticated: true } } });

        await authFetch('/api/x');

        const [, init] = fetchMock.mock.calls[1] as [string, { headers: Record<string, string> }];
        expect(init.headers['X-Session-Token']).toBe('embed-token');
        expect(reload).not.toHaveBeenCalled();
    });
});
