// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const authFetch = vi.hoisted(() => vi.fn());
vi.mock('@/utils/helpers', () => ({ API_BASE: '', authFetch }));

import { acknowledgeCallerNotice, fetchCallerNotice } from './callerNotice';

beforeEach(() => authFetch.mockReset());

describe('fetchCallerNotice', () => {
    it('reads whether the notice applies, whether it was seen and which apps', async () => {
        authFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ applies: true, seen: false, providers: ['Google', 7, 'Microsoft'], destinations: ['tables', 1], items: ['app:google', 'dest:tables'] }) });
        expect(await fetchCallerNotice('a 1')).toEqual({ applies: true, seen: false, providers: ['Google', 'Microsoft'], destinations: ['tables'], items: ['app:google', 'dest:tables'] });
        expect(authFetch.mock.calls[0][0]).toBe('/api/automation/a%201/caller-notice');
    });

    it('treats anything unreadable as "does not apply"', async () => {
        authFetch.mockResolvedValue({ ok: true, status: 200, json: async () => null });
        expect(await fetchCallerNotice('a1')).toEqual({ applies: false, seen: false, providers: [], destinations: [], items: [] });
    });

    it('a refusal throws with the server\'s message', async () => {
        authFetch.mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: 'Forbidden', code: 'automation_forbidden' }) });
        await expect(fetchCallerNotice('a1')).rejects.toThrow('Forbidden');
    });
});

describe('acknowledgeCallerNotice', () => {
    it('posts to the seen route', async () => {
        authFetch.mockResolvedValue({ ok: true, status: 200 });
        await acknowledgeCallerNotice('a1', ['app:google']);
        expect(authFetch).toHaveBeenCalledWith('/api/automation/a1/caller-notice/seen', expect.objectContaining({ method: 'POST', body: '{"items":["app:google"]}' }));
    });

    it('fails loudly when the server refuses', async () => {
        authFetch.mockResolvedValue({ ok: false, status: 403 });
        await expect(acknowledgeCallerNotice('a1', [])).rejects.toThrow('Caller notice 403');
    });
});
