import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../utils/helpers', () => ({ authFetch: vi.fn() }));

import { authFetch } from '../../../../utils/helpers';
import { API, API_DSR, OPTS, fetchJson, jsonInit, json, downloadUrl, asObject, asArray } from './api';

beforeEach(() => authFetch.mockReset());

describe('compliance data/api — the one network seam', () => {
    it('points at /api/compliance and /api/dsr', () => {
        expect(API.endsWith('/api/compliance')).toBe(true);
        expect(API_DSR.endsWith('/api/dsr')).toBe(true);
        expect(OPTS).toEqual({ credentials: 'include' });
    });

    it('fetchJson goes through authFetch (the demo transport seam), merges init over OPTS and parses json', async () => {
        authFetch.mockResolvedValue({ ok: true, json: async () => ({ a: 1 }) });
        const out = await fetchJson(`${API}/overview`, { method: 'POST' });
        expect(out).toEqual({ a: 1 });
        expect(authFetch).toHaveBeenCalledWith(`${API}/overview`, { credentials: 'include', method: 'POST' });
    });

    it('fetchJson throws "<status> <statusText>" on a non-2xx', async () => {
        authFetch.mockResolvedValue({ ok: false, status: 403, statusText: 'Forbidden', json: async () => ({}) });
        await expect(fetchJson(`${API}/checks`)).rejects.toThrow('403 Forbidden');
    });

    it('fetchJson keeps the status and the server\'s code and sentence on the thrown error', async () => {
        authFetch.mockResolvedValue({ ok: false, status: 400, statusText: 'Bad Request', json: async () => ({ error: 'until must be in the future.', code: 'invalid_request' }) });
        const err = await fetchJson(`${API}/checks/x/state`).catch((e) => e);
        expect(err.message).toBe('400 Bad Request');
        expect(err).toMatchObject({ status: 400, code: 'invalid_request', serverMessage: 'until must be in the future.' });
    });

    it('fetchJson still throws "<status> <statusText>" when the refusal has no JSON body', async () => {
        authFetch.mockResolvedValue({ ok: false, status: 502, statusText: 'Bad Gateway', json: async () => { throw new SyntaxError('Unexpected token <'); } });
        const err = await fetchJson(`${API}/overview`).catch((e) => e);
        expect(err.message).toBe('502 Bad Gateway');
        expect(err).toMatchObject({ status: 502, code: null, serverMessage: null });
    });

    it('jsonInit/json build a JSON write; an undefined body still sends "{}"', () => {
        expect(jsonInit('PUT', { x: 1 })).toEqual({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"x":1}' });
        expect(json()).toEqual({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    });

    it('downloadUrl hides exports for the public demo', () => {
        expect(downloadUrl(true, '/x.pdf')).toBe('/x.pdf');
        expect(downloadUrl(false, '/x.pdf')).toBeNull();
    });

    it('asObject/asArray treat the nav-test "[]" mock and junk as not-loaded, never as zero', () => {
        expect(asObject({ counts: {} })).toEqual({ counts: {} });
        expect(asObject([])).toBeNull();
        expect(asObject(null)).toBeNull();
        expect(asObject('x')).toBeNull();
        expect(asArray([1])).toEqual([1]);
        expect(asArray({})).toBeNull();
        expect(asArray(undefined)).toBeNull();
    });
});
