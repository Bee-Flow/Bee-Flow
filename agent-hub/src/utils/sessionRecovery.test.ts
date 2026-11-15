import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { apiPathOf, createSessionRecovery, shouldRecoverFrom401 } from './sessionRecovery';

const EMBED_BASE = '/index.php/apps/app_api/proxy/bee_flow';

describe('shouldRecoverFrom401', () => {
    it.each([
        // [url, apiBase, expected]
        ['/api/agents', '', true],
        ['/api/agents?next=/setup/', '', true],
        ['/api/agents?return=/auth/login', '', true],
        ['/api/search?q=/api/health', '', true],
        ['/api/agents#/auth/', '', true],
        ['/api/oauth/apps', '', true],
        ['/api/languages', '', true],
        ['/api/healthcheck', '', true],
        ['/api/integrations/auth/x', '', true],
        ['/auth/user', '', false],
        ['/auth/my-permissions?x=1', '', false],
        ['/api/health', '', false],
        ['/api/health/schema', '', false],
        ['/api/languages/user/locales', '', false],
        ['/setup/diagnostics', '', false],
        ['http://localhost:3001/api/agents', 'http://localhost:3001', true],
        ['http://localhost:3001/auth/user', 'http://localhost:3001', false],
        [`${EMBED_BASE}/api/agents`, EMBED_BASE, true],
        [`${EMBED_BASE}/setup/diagnostics`, EMBED_BASE, false],
        [`${EMBED_BASE}/auth/user`, EMBED_BASE, false],
        // The embed's prefix is recognised by its marker even when the base
        // the caller was built with is a different one.
        [`${EMBED_BASE}/setup/diagnostics`, '', false],
        ['/exapps/bee_flow/auth/user', '', false],
        ['/exapps/bee_flow/api/agents', '', true],
    ] as const)('%s (base %j) -> %s', (url, apiBase, expected) => {
        expect(shouldRecoverFrom401(url, apiBase)).toBe(expected);
    });

    it('leaves a URL it cannot read alone', () => {
        expect(shouldRecoverFrom401('http://[', '')).toBe(false);
    });
});

describe('apiPathOf', () => {
    it('drops the API base, the query string and the fragment', () => {
        expect(apiPathOf(`${EMBED_BASE}/api/agents?x=1#top`, EMBED_BASE)).toBe('/api/agents');
        expect(apiPathOf('http://localhost:3001/api/agents?x=1', 'http://localhost:3001/')).toBe('/api/agents');
        expect(apiPathOf('/nextcloud/exapps/bee_flow/api/agents')).toBe('/api/agents');
    });
});

describe('createSessionRecovery', () => {
    const RELOAD_FLAG = 'bf_auth_reload_at';
    let reload: ReturnType<typeof vi.fn>;

    const answer = (status: number, body: unknown = {}): Response => new Response(JSON.stringify(body), { status });

    beforeEach(() => {
        sessionStorage.clear();
        reload = vi.fn();
        vi.stubGlobal('location', { ...window.location, reload });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('reloads when the session check says nobody is signed in', async () => {
        const recover = createSessionRecovery(async () => answer(200, { authenticated: false, user: null }));
        await recover('/api/agents');
        expect(reload).toHaveBeenCalledTimes(1);
        expect(sessionStorage.getItem(RELOAD_FLAG)).not.toBeNull();
    });

    it('reloads when the session check itself answers 401', async () => {
        const recover = createSessionRecovery(async () => answer(401, { error: 'Not authenticated' }));
        await recover('/api/agents');
        expect(reload).toHaveBeenCalledTimes(1);
    });

    it('leaves the page alone when the session is still valid', async () => {
        const recover = createSessionRecovery(async () => answer(200, { authenticated: true, user: { id: 'u1' } }));
        await recover('/api/agents');
        expect(reload).not.toHaveBeenCalled();
        expect(sessionStorage.getItem(RELOAD_FLAG)).toBeNull();
    });

    it.each([
        ['a network failure', async () => { throw new TypeError('Failed to fetch'); }],
        ['a 502', async () => answer(502)],
        ['a body that is not JSON', async () => new Response('<html>', { status: 200 })],
        ['a body without the flag', async () => answer(200, {})],
    ] as const)('leaves the page alone when the check ends in %s', async (_name, fetchSession) => {
        const recover = createSessionRecovery(fetchSession);
        await recover('/api/agents');
        expect(reload).not.toHaveBeenCalled();
    });

    it('shares one check and one reload between simultaneous 401s', async () => {
        let release: (res: Response) => void = () => {};
        const fetchSession = vi.fn((_apiPath: string) => new Promise<Response>((resolve) => { release = resolve; }));
        const recover = createSessionRecovery(fetchSession);

        const pending = Array.from({ length: 10 }, (_, i) => recover(`/api/thing/${i}`));
        release(answer(200, { authenticated: false }));
        await Promise.all(pending);

        expect(fetchSession).toHaveBeenCalledTimes(1);
        expect(fetchSession).toHaveBeenCalledWith('/auth/user');
        expect(reload).toHaveBeenCalledTimes(1);
    });

    it('checks again for a later 401 once the first check has finished', async () => {
        const fetchSession = vi.fn(async () => answer(200, { authenticated: true }));
        const recover = createSessionRecovery(fetchSession);
        await recover('/api/a');
        await recover('/api/b');
        expect(fetchSession).toHaveBeenCalledTimes(2);
    });

    it('does not check or reload within the cooldown of an earlier reload', async () => {
        sessionStorage.setItem(RELOAD_FLAG, String(Date.now() - 5_000));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const fetchSession = vi.fn(async () => answer(200, { authenticated: false }));
        const recover = createSessionRecovery(fetchSession);
        await recover('/api/agents');
        expect(fetchSession).not.toHaveBeenCalled();
        expect(reload).not.toHaveBeenCalled();
        warn.mockRestore();
    });
});
