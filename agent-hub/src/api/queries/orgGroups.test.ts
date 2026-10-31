// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const authFetch = vi.fn();
vi.mock('../../utils/helpers', () => ({ authFetch: (...a: unknown[]) => authFetch(...a), API_BASE: '/b' }));

import { groupRowsOf, readOrgGroups } from './orgGroups';

const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('readOrgGroups', () => {
    beforeEach(() => { authFetch.mockReset(); });

    it('reads /auth/groups at the root and returns the rows', async () => {
        authFetch.mockResolvedValue(json(200, [{ id: 'g1', name: 'Sales' }]));
        await expect(readOrgGroups()).resolves.toEqual([{ id: 'g1', name: 'Sales' }]);
        expect(authFetch).toHaveBeenCalledWith('/b/auth/groups', undefined);
    });

    it('passes the abort signal on', async () => {
        authFetch.mockResolvedValue(json(200, []));
        const { signal } = new AbortController();
        await readOrgGroups(signal);
        expect(authFetch).toHaveBeenCalledWith('/b/auth/groups', { signal });
    });

    it('answers null on a refusal and throws on a network error', async () => {
        authFetch.mockResolvedValueOnce(json(403, { error: 'no' }));
        await expect(readOrgGroups()).resolves.toBeNull();
        authFetch.mockRejectedValueOnce(new TypeError('offline'));
        await expect(readOrgGroups()).rejects.toThrow('offline');
    });

    it('accepts a { groups } envelope and treats anything else as none', () => {
        expect(groupRowsOf({ groups: [{ id: 'a' }] })).toEqual([{ id: 'a' }]);
        expect(groupRowsOf({ nope: 1 })).toEqual([]);
        expect(groupRowsOf(null)).toEqual([]);
    });
});
