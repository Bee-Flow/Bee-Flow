/**
 * The server reports its build SHA on /api/health only to a signed-in caller,
 * so the probe can carry the session headers; the onboarding probe sends none.
 */
import { checkHealth } from '@/core/api/server';

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

function stubFetch(body: unknown) {
    const calls: RequestInit[] = [];
    global.fetch = jest.fn(async (_url: unknown, init?: RequestInit) => {
        calls.push(init ?? {});
        return { ok: true, status: 200, json: async () => body } as unknown as Response;
    }) as unknown as typeof fetch;
    return calls;
}

it('passes the given session headers and reads appVersion', async () => {
    const calls = stubFetch({ status: 'ok', appVersion: 'abc123' });
    const result = await checkHealth('https://bee.example.com', 1000, { 'X-Session-Token': 't0k' });
    expect(result).toEqual({ ok: true, appVersion: 'abc123' });
    expect((calls[0].headers as Record<string, string>)['X-Session-Token']).toBe('t0k');
    expect((calls[0].headers as Record<string, string>).Accept).toBe('application/json');
});

it('sends no session header by default', async () => {
    const calls = stubFetch({ status: 'ok', appVersion: '' });
    await checkHealth('https://bee.example.com');
    expect((calls[0].headers as Record<string, string>)['X-Session-Token']).toBeUndefined();
});
