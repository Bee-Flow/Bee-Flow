/**
 * The two shared readers: "who uses this" and the org's groups. Both keep
 * "could not be read" apart from "none".
 */

import { api } from './client';
import { fetchOrgGroups, readOrgGroups } from './orgGroups';
import { readUsageAnswer } from './usage';

jest.mock('./client', () => {
    const actual = jest.requireActual('./client');
    return { ...actual, api: { ...actual.api, get: jest.fn() } };
});

describe('readUsageAnswer', () => {
    it('reads rows (ids as text) and the unchecked kinds', () => {
        expect(readUsageAnswer({ usage: [{ kind: 'agent', id: 3, title: null, role: 'chat', foreign: true }, 'x'], unchecked: ['app', '', 4] })).toEqual({
            usage: [{ kind: 'agent', id: '3', title: null, role: 'chat', foreign: true, siteLabel: null, stepId: null }],
            unchecked: ['app'],
        });
    });

    it('reads nothing into nothing', () => {
        expect(readUsageAnswer(null)).toEqual({ usage: [], unchecked: [] });
    });
});

describe('org groups', () => {
    it('keeps named groups with an id, and says null for a body that is not a list', () => {
        expect(readOrgGroups([{ id: 'g', name: 'Sales' }, { name: 'x' }])).toEqual([{ id: 'g', name: 'Sales' }]);
        expect(readOrgGroups({ error: 'no' })).toBeNull();
    });

    it('turns a refusal into null, never []', async () => {
        (api.get as jest.Mock).mockRejectedValueOnce(new Error('403'));
        expect(await fetchOrgGroups()).toBeNull();
        (api.get as jest.Mock).mockResolvedValueOnce([]);
        expect(await fetchOrgGroups()).toEqual([]);
        expect(api.get).toHaveBeenLastCalledWith('/auth/groups', { signal: undefined, retry: false });
    });
});
