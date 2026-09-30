/**
 * The run log's two scopes go to two different routes, and their answers are
 * read through the allow-list — including the one distinction the strip lives
 * on: a facets body without a rollup is null, not an empty list.
 */

import { api } from '@/core/api/client';

import { getRunFacets, listRuns } from './endpoints';

jest.mock('@/core/api/client', () => {
    const actual = jest.requireActual('@/core/api/client');
    return { ...actual, api: { ...actual.api, get: jest.fn() } };
});

const get = api.get as jest.Mock;

beforeEach(() => get.mockReset());

describe('listRuns', () => {
    it('reads my runs from /_runs/recent and the organisation from /_runs/org', async () => {
        get.mockResolvedValue({ runs: [], nextCursor: null });
        await listRuns('mine', { limit: 50 });
        await listRuns('org', { limit: 50, cursor: 'c1' });
        expect(get.mock.calls.map((c) => [c[0], c[1].query])).toEqual([
            ['/api/automation/_runs/recent', { limit: 50 }],
            ['/api/automation/_runs/org', { limit: 50, cursor: 'c1' }],
        ]);
    });

    it('keeps the allow-listed fields, drops id-less rows and never forwards a payload', async () => {
        get.mockResolvedValue({
            runs: [
                { id: 'r1', automationId: 'a1', automationTitle: 'Invoices', status: 'error', durationMs: '1200', mine: true, triggerPayload: { secret: 1 } },
                { automationId: 'a2' },
                'junk',
            ],
            nextCursor: 'next',
        });
        const page = await listRuns('org', {});
        expect(page.nextCursor).toBe('next');
        expect(page.runs).toHaveLength(1);
        expect(page.runs[0]).toMatchObject({ id: 'r1', automationTitle: 'Invoices', status: 'error', durationMs: 1200, mine: true, automationKind: 'automation' });
        expect(page.runs[0]).not.toHaveProperty('triggerPayload');
    });
});

describe('getRunFacets', () => {
    it('asks the scope’s own facets route with the window', async () => {
        get.mockResolvedValue({ facets: {} });
        await getRunFacets('mine', { range: 24, mode: 'live' });
        await getRunFacets('org', { range: 720 });
        expect(get.mock.calls.map((c) => [c[0], c[1].query])).toEqual([
            ['/api/automation/_runs/facets', { range: 24, mode: 'live' }],
            ['/api/automation/_runs/org/facets', { range: 720 }],
        ]);
    });

    it('reads counts and the rollup, and says null where there is none', async () => {
        get.mockResolvedValueOnce({
            facets: {
                status: { success: '3', error: 1, bogus: 'x' },
                triggerKind: { manual: 4 },
                automations: [{ automationId: 'a1', title: 'Invoices', total: 4, status: { success: 3, error: 1 } }, { title: 'no id' }],
                automationsTotal: 12,
            },
        });
        const facets = await getRunFacets('mine', { range: 24 });
        expect(facets?.status).toEqual({ success: 3, error: 1 });
        expect(facets?.automations?.map((r) => r.automationId)).toEqual(['a1']);
        expect(facets?.automationsTotal).toBe(12);

        get.mockResolvedValueOnce({ facets: { status: {} } });
        expect((await getRunFacets('mine', { range: 24 }))?.automations).toBeNull();

        get.mockResolvedValueOnce({ error: 'nope' });
        expect(await getRunFacets('mine', { range: 24 })).toBeNull();
    });
});
