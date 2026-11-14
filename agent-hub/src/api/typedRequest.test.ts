import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { apiFetch, apiJson, apiRequest, apiUrl } from './typedRequest';
import { RefusedError } from './mutate';
import { API_BASE } from '../utils/helpers';

// The network is the global fetch that authFetch ends in; authFetch itself (session,
// client and cache headers) runs for real.
const fetchMock = vi.fn();
const sent = (i = 0) => fetchMock.mock.calls[i] as [string, RequestInit];

const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('apiUrl', () => {
    it('puts API_BASE before the path and encodes each path parameter', () => {
        expect(apiUrl('PATCH /agents/categories/{id}', { params: { id: 'a b/c' } }))
            .toBe(API_BASE + '/agents/categories/a%20b%2Fc');
    });

    it('writes the query the way a template literal with encodeURIComponent does, leaving out empty values', () => {
        expect(apiUrl('GET /agents/conversations/search', { query: { q: 'a&b c', limit: 20, agentId: undefined } }))
            .toBe(API_BASE + '/agents/conversations/search?q=a%26b%20c&limit=20');
    });

    it('sends a URLSearchParams as it is', () => {
        expect(apiUrl('GET /agents', { query: new URLSearchParams({ a: 'x y' }) })).toBe(API_BASE + '/agents?a=x+y');
    });

    it('refuses a path parameter left out at run time', () => {
        // @ts-expect-error -- the type requires params; this checks the run-time guard behind it
        expect(() => apiUrl('PATCH /agents/categories/{id}', {})).toThrow(/needs the path parameter "id"/);
    });
});

describe('the request functions', () => {
    beforeEach(() => {
        fetchMock.mockReset();
        vi.stubGlobal('fetch', fetchMock);
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('sends a GET without a method or a body, as a hand-written authFetch(url) does', async () => {
        fetchMock.mockResolvedValue(json(200, []));
        await apiRequest('GET /agents');
        const [url, init] = sent();
        expect(url).toBe(API_BASE + '/agents');
        expect(init.method).toBeUndefined();
        expect(init.body).toBeUndefined();
    });

    it('passes the caller init (a signal) through, still without a method', async () => {
        const signal = new AbortController().signal;
        fetchMock.mockResolvedValue(json(200, []));
        await apiFetch('GET /agents', { init: { signal } });
        expect(sent()[1]).toMatchObject({ signal });
        expect(sent()[1].method).toBeUndefined();
    });

    it('sends a JSON body with the method, the JSON content type and the caller headers', async () => {
        fetchMock.mockResolvedValue(json(200, { id: 'c1' }));
        await apiRequest('POST /agents/categories', { body: { name: 'Sales' }, init: { headers: { 'X-A': '1' } } });
        const [url, init] = sent();
        expect(url).toBe(API_BASE + '/agents/categories');
        expect(init).toMatchObject({ method: 'POST', body: '{"name":"Sales"}' });
        expect(init.headers).toMatchObject({ 'Content-Type': 'application/json', 'X-A': '1' });
    });

    it('sends a method without a body, and no content type', async () => {
        fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
        await apiRequest('DELETE /agents/categories/{id}', { params: { id: 7 } });
        const [url, init] = sent();
        expect(url).toBe(API_BASE + '/agents/categories/7');
        expect(init.method).toBe('DELETE');
        expect(init.body).toBeUndefined();
        expect(init.headers).not.toHaveProperty('Content-Type');
    });

    it('apiRequest and apiJson throw the RefusedError of mutate on a non-2xx; apiFetch hands the Response back', async () => {
        fetchMock.mockImplementation(async () => json(403, { error: 'Not allowed' }));
        await expect(apiRequest('GET /agents')).rejects.toBeInstanceOf(RefusedError);
        await expect(apiJson('GET /agents')).rejects.toThrow('Not allowed');
        const res = await apiFetch('GET /agents');
        expect(res.status).toBe(403);
    });

    it('apiJson resolves to the parsed body, typed as the caller declares', async () => {
        fetchMock.mockResolvedValue(json(200, [{ id: 'a1' }]));
        const rows: Array<{ id: string }> = await apiJson('GET /agents');
        expect(rows[0].id).toBe('a1');
    });

    it('checks keys, params and bodies against the contract at compile time', () => {
        // Typechecked, never run: the run-time half is the tests above.
        const wrongCalls = () => [
            // @ts-expect-error -- not an operation of the server
            apiRequest('GET /no/such/route'),
            // @ts-expect-error -- a closed body schema: an unknown key is refused
            apiRequest('POST /agents/categories', { body: { name: 'x', colour: 'red' } }),
            // @ts-expect-error -- the path has a parameter, so options are required
            apiRequest('DELETE /agents/categories/{id}'),
        ];
        expect(typeof wrongCalls).toBe('function');
    });
});
