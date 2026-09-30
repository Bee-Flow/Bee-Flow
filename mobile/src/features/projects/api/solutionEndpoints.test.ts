/**
 * The builder's reads, failing SHUT: a summary without its list is "could not
 * be read", not "you have none"; a tally the server sent as null stays null;
 * the checks without a boolean `blocked` are refused; a picker list that did
 * not come back is an error, not an empty shelf.
 */

import { api } from '@/core/api/client';

import { getCompleteness, getProjectGraph, getSolutionSummary, listCandidates } from './solutionEndpoints';

jest.mock('@/core/api/client', () => ({
    api: { get: jest.fn(), post: jest.fn(), put: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

const get = api.get as jest.Mock;

beforeEach(() => get.mockReset());

describe('getSolutionSummary', () => {
    it('reads each row, keeping every unread tally as null', async () => {
        get.mockResolvedValueOnce({
            projects: [
                {
                    id: 'p1',
                    name: 'Intake',
                    permission: 'editor',
                    counts: { apps: 2, automations: null, datatables: '3' },
                    runs: { today: 4, failed: 1 },
                    completeness: { blocked: false, complete: true, findings: 1, errors: 0, warnings: 1 },
                    update: { installedVersion: 1, latestVersion: 2, available: 'yes' },
                },
                { id: 'p2', runs: null, completeness: null, update: null },
                { name: 'no id' },
                'junk',
            ],
            unavailable: ['runs', 3],
            hasMore: true,
        });
        const summary = await getSolutionSummary();
        expect(summary.unavailable).toEqual(['runs']);
        expect(summary.hasMore).toBe(true);
        expect(summary.rows.map((r) => r.id)).toEqual(['p1', 'p2']);
        const [first, second] = summary.rows;
        expect(first?.counts).toEqual({ apps: 2, automations: null, datatables: 3 });
        expect(first?.runs).toEqual({ today: 4, failed: 1 });
        expect(first?.completeness).toMatchObject({ blocked: false, complete: true, warnings: 1 });
        expect(first?.update?.available).toBeNull();
        expect([second?.runs, second?.completeness, second?.update]).toEqual([null, null, null]);
    });

    it('reads a body without a list as nothing read at all', async () => {
        get.mockResolvedValueOnce({ unavailable: ['blueprints'] });
        expect(await getSolutionSummary()).toEqual({ rows: [], unavailable: ['blueprints', 'all'], hasMore: false });
    });
});

describe('getProjectGraph', () => {
    it('keeps the completeness verdict three-valued', async () => {
        get.mockResolvedValueOnce({ nodes: [{ id: 'app:a', type: 'app', name: 'A' }], edges: [{ from: 'app:a', to: null, kind: 'runs' }], complete: false, unavailable: ['apps'] });
        const graph = await getProjectGraph('p1');
        expect(get).toHaveBeenCalledWith('/api/projects/p1/graph', expect.anything());
        expect(graph.complete).toBe(false);
        expect(graph.edges[0]).toEqual({ from: 'app:a', to: null, kind: 'runs', targetId: null, problem: null });
        get.mockResolvedValueOnce({});
        expect((await getProjectGraph('p1')).complete).toBeNull();
    });
});

describe('getCompleteness', () => {
    it('reads findings with their deep links', async () => {
        get.mockResolvedValueOnce({
            blocked: true,
            complete: true,
            findings: [{ code: 'kb.empty', severity: 'error', message: 'Empty', deepLink: '/app/studio/knowledge/k1', targetRef: { kind: 'kb', id: 'k1' } }],
        });
        const c = await getCompleteness('p1');
        expect(c.blocked).toBe(true);
        expect(c.findings[0]).toMatchObject({ deepLink: '/app/studio/knowledge/k1', targetRef: { kind: 'kb', id: 'k1' }, blockedAt: null });
    });

    it('refuses an answer that does not say whether it is blocked', async () => {
        get.mockResolvedValueOnce({ findings: [] });
        await expect(getCompleteness('p1')).rejects.toThrow();
    });
});

describe('listCandidates', () => {
    it.each([
        ['notebook', '/api/notebooks', { notebooks: [{ id: 'n1', name: 'Notes' }] }],
        ['app', '/api/studio-apps', { apps: [{ id: 'n1', name: 'Notes' }] }],
        ['automation', '/api/automation', { automations: [{ id: 'n1', title: 'Notes' }] }],
        ['webpage', '/api/webpages', { webpages: [{ id: 'n1', name: 'Notes' }] }],
        ['datatable', '/api/datatables', { datatables: [{ id: 'n1', name: 'Notes' }], scope: {} }],
        ['agent', '/agents', [{ id: 'n1', name: 'Notes' }]],
        ['knowledge_base', '/api/kb', [{ id: 'n1', name: 'Notes' }, { name: 'no id' }]],
    ])('reads %s from %s', async (kind, path, body) => {
        get.mockResolvedValueOnce(body);
        expect(await listCandidates(kind)).toEqual([{ id: 'n1', label: 'Notes' }]);
        expect(get).toHaveBeenCalledWith(path, expect.anything());
    });

    it('throws for a list that did not come back, and offers nothing for a kind it does not know', async () => {
        get.mockResolvedValueOnce({ error: 'nope' });
        await expect(listCandidates('app')).rejects.toThrow();
        expect(await listCandidates('approval')).toEqual([]);
    });
});
