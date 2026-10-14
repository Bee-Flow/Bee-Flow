import { beforeEach, describe, expect, it, vi } from 'vitest';

const authFetch = vi.fn();
vi.mock('../utils/helpers', () => ({ authFetch: (...a: unknown[]) => authFetch(...a), API_BASE: '/base' }));

import { createJsonResource, type JsonResourceError } from './client';

const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('createJsonResource', () => {
    beforeEach(() => { authFetch.mockReset(); });

    it('prepends the base, sends JSON headers and returns the parsed body', async () => {
        authFetch.mockResolvedValue(json(200, { id: 1 }));
        const request = createJsonResource('/api/things');
        await expect(request('/1', { method: 'POST', body: { a: 1 } })).resolves.toEqual({ id: 1 });
        expect(authFetch).toHaveBeenCalledWith('/api/things/1', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{"a":1}',
        });
    });

    it('sends a GET with the JSON header and no body, and resolves null on an empty answer', async () => {
        authFetch.mockResolvedValue(new Response(null, { status: 204 }));
        await expect(createJsonResource()('/x')).resolves.toBeNull();
        expect(authFetch).toHaveBeenCalledWith('/x', { headers: { 'Content-Type': 'application/json' } });
    });

    it('leaves a string body alone and lets the caller headers win', async () => {
        authFetch.mockResolvedValue(json(200, {}));
        await createJsonResource()('/x', { method: 'PUT', body: '"s"', headers: { 'Content-Type': 'text/plain', A: 'b' } });
        expect(authFetch).toHaveBeenCalledWith('/x', { method: 'PUT', body: '"s"', headers: { 'Content-Type': 'text/plain', A: 'b' } });
    });

    it('sends a FormData body without a Content-Type', async () => {
        authFetch.mockResolvedValue(json(200, {}));
        const form = new FormData();
        await createJsonResource()('/x', { method: 'POST', body: form });
        expect(authFetch.mock.calls[0][1]).toEqual({ method: 'POST', body: form });
    });

    it("contentType 'body' sets the header only with a body; 'none' never", async () => {
        authFetch.mockResolvedValue(json(200, {}));
        const onBody = createJsonResource('', { contentType: 'body' });
        await onBody('/a');
        await onBody('/b', { method: 'POST', body: { x: 1 } });
        await createJsonResource('', { contentType: 'none' })('/c', { method: 'POST', body: { x: 1 } });
        expect(authFetch.mock.calls.map((c) => c[1])).toEqual([
            {},
            { method: 'POST', body: '{"x":1}', headers: { 'Content-Type': 'application/json' } },
            { method: 'POST', body: '{"x":1}' },
        ]);
    });

    it('throws the server error text with status, code and body, once (no retry)', async () => {
        authFetch.mockResolvedValue(json(500, { error: 'Boom', code: 'x_failed' }));
        const err = await createJsonResource()('/x', { method: 'POST', body: {} }).catch((e) => e) as JsonResourceError;
        expect(err.message).toBe('Boom');
        expect(err.status).toBe(500);
        expect(err.code).toBe('x_failed');
        expect(err.body).toEqual({ error: 'Boom', code: 'x_failed' });
        expect(authFetch).toHaveBeenCalledTimes(1);
    });

    it('falls back to "Request failed (<status>)", or the given errorText, on a body without error', async () => {
        authFetch.mockImplementation(async () => new Response('nope', { status: 404 }));
        const a = await createJsonResource()('/x').catch((e) => e) as JsonResourceError;
        expect(a.message).toBe('Request failed (404)');
        expect(a.code).toBeNull();
        expect(a.body).toBeNull();
        const b = await createJsonResource('', { errorText: (s) => `HTTP ${s}` })('/x').catch((e) => e);
        expect(b.message).toBe('HTTP 404');
    });

    it('lets decorate add module fields to the error', async () => {
        authFetch.mockResolvedValue(json(409, { error: 'Taken', field: 'name' }));
        const request = createJsonResource('', { decorate: (err, body) => { err.field = body?.field || null; } });
        const err = await request('/x').catch((e) => e) as JsonResourceError;
        expect(err.field).toBe('name');
    });

    it('retries a 5xx only when asked', async () => {
        authFetch
            .mockResolvedValueOnce(json(503, { error: 'busy' }))
            .mockResolvedValueOnce(json(200, { ok: true }));
        const request = createJsonResource('', { retry: { attempts: 1, base: 0 } });
        await expect(request('/x')).resolves.toEqual({ ok: true });
        expect(authFetch).toHaveBeenCalledTimes(2);
    });
});
