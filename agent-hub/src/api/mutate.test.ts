import { beforeEach, describe, expect, it, vi } from 'vitest';

const authFetch = vi.fn();
vi.mock('../utils/helpers', () => ({ authFetch: (...a: unknown[]) => authFetch(...a), API_BASE: '/api' }));

import { ApiError, errorBody, mutate, request } from './mutate';

const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('mutate', () => {
    beforeEach(() => {
        authFetch.mockReset();
    });

    it('sends the url and init unchanged and hands back the same Response on 2xx', async () => {
        const res = json(200, { id: 'v1' });
        authFetch.mockResolvedValue(res);
        const init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"a":1}' };
        const out = await mutate('/api/things', init);
        expect(out).toBe(res);
        expect(authFetch).toHaveBeenCalledTimes(1);
        expect(authFetch).toHaveBeenCalledWith('/api/things', init);
        expect(await out.json()).toEqual({ id: 'v1' });
    });

    it('passes a 204 through', async () => {
        const res = new Response(null, { status: 204 });
        authFetch.mockResolvedValue(res);
        await expect(mutate('/api/x', { method: 'DELETE' })).resolves.toBe(res);
    });

    it('throws an ApiError with the server error text on a non-2xx', async () => {
        authFetch.mockResolvedValue(json(403, { error: 'Not allowed', correlationId: 'c1' }));
        const err = await mutate('/api/x', { method: 'DELETE' }).catch((e) => e);
        expect(err).toBeInstanceOf(ApiError);
        expect(err.message).toBe('Not allowed');
        expect(err.status).toBe(403);
        expect(err.body).toEqual({ error: 'Not allowed', correlationId: 'c1' });
    });

    it('falls back to message, then to HTTP <status>, and never retries', async () => {
        authFetch.mockResolvedValueOnce(json(400, { message: 'Bad name' }));
        await expect(mutate('/api/x', { method: 'PUT' })).rejects.toThrow('Bad name');
        authFetch.mockResolvedValueOnce(new Response('<html>oops</html>', { status: 502 }));
        await expect(mutate('/api/x', { method: 'PATCH' })).rejects.toThrow('HTTP 502');
        expect(authFetch).toHaveBeenCalledTimes(2);
    });

    it('lets a network failure through as is', async () => {
        const failure = new Error('Failed to fetch');
        authFetch.mockImplementation(async () => { throw failure; });
        let err: unknown;
        try {
            await mutate('/api/x', { method: 'POST' });
        } catch (e) {
            err = e;
        }
        expect(err).toBe(failure);
    });

    it('errorBody gives the parsed JSON of a refused request, null when it was not JSON', async () => {
        authFetch.mockResolvedValue(json(422, { error: 'Bad', field: 'name' }));
        const err = (await mutate('/api/x', { method: 'POST' }).catch((e) => e)) as ApiError;
        expect(errorBody(err)).toEqual({ error: 'Bad', field: 'name' });
        authFetch.mockResolvedValue(new Response('<html>', { status: 502 }));
        const html = (await mutate('/api/x', { method: 'POST' }).catch((e) => e)) as ApiError;
        expect(errorBody(html) ?? { fallback: true }).toEqual({ fallback: true });
    });

    it('request is mutate under a neutral name', () => {
        expect(request).toBe(mutate);
    });
});
