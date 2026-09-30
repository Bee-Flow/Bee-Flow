/**
 * What each filter sends, and who may open what — the web's useExecutions
 * query and runScope rules, pinned on the phone.
 */

import {
    DEFAULT_FILTERS,
    EVERYTHING,
    canOpenRun,
    isNarrowed,
    normaliseRunScope,
    runHref,
    runQuery,
    statusCount,
    statusFilterToServer,
} from './filters';
import type { RunFacets } from './types';

const NOW = Date.parse('2026-09-24T12:00:00Z');

describe('statusFilterToServer', () => {
    it('maps each chip to the server statuses and nothing else', () => {
        expect(statusFilterToServer('all')).toBeUndefined();
        expect(statusFilterToServer(null)).toBeUndefined();
        expect(statusFilterToServer('running')).toEqual(['running', 'queued']);
        expect(statusFilterToServer('awaiting')).toEqual(['awaiting_approval', 'awaiting_confirm', 'awaiting_form']);
        expect(statusFilterToServer('cancelled')).toEqual(['cancelled']);
        expect(statusFilterToServer('error')).toEqual(['error']);
        expect(statusFilterToServer('success')).toEqual(['success']);
        expect(statusFilterToServer('paused')).toBeUndefined();
    });
});

describe('runQuery', () => {
    it('asks for the last day of live runs by default', () => {
        expect(runQuery(DEFAULT_FILTERS, null, NOW)).toEqual({
            limit: 50,
            since: '2026-09-23T12:00:00.000Z',
            mode: 'live',
        });
    });

    it('carries the cursor, the status set, the trigger and the routine', () => {
        expect(
            runQuery({ status: 'awaiting', range: '7d', trigger: 'form', automationId: 'a1', mode: 'dry_run' }, 'c2', NOW),
        ).toEqual({
            limit: 50,
            cursor: 'c2',
            status: 'awaiting_approval,awaiting_confirm,awaiting_form',
            trigger: 'form',
            automationId: 'a1',
            since: '2026-09-17T12:00:00.000Z',
            mode: 'dry_run',
        });
    });

    it('sends no window for "all" and no mode for "both"', () => {
        expect(runQuery(EVERYTHING, null, NOW)).toEqual({ limit: 50 });
    });
});

describe('statusCount', () => {
    const facets = { status: { success: 4, error: 2, running: 1, queued: 2, awaiting_form: 1, awaiting_confirm: 1 } } as unknown as RunFacets;

    it('adds the statuses behind each chip', () => {
        expect(statusCount(facets, 'all')).toBe(11);
        expect(statusCount(facets, 'running')).toBe(3);
        expect(statusCount(facets, 'awaiting')).toBe(2);
        expect(statusCount(facets, 'error')).toBe(2);
        expect(statusCount(facets, 'cancelled')).toBe(0);
    });

    it('is null until there are facets', () => {
        expect(statusCount(null, 'all')).toBeNull();
    });
});

describe('isNarrowed', () => {
    it('knows the default narrows and "everything" does not', () => {
        expect(isNarrowed(DEFAULT_FILTERS)).toBe(true);
        expect(isNarrowed(EVERYTHING)).toBe(false);
        expect(isNarrowed({ ...EVERYTHING, trigger: 'manual' })).toBe(true);
    });
});

describe('scope', () => {
    it('widens only for the exact string "org"', () => {
        expect(normaliseRunScope('org')).toBe('org');
        for (const v of [undefined, null, 'ORG', 'organisation', 1, {}]) expect(normaliseRunScope(v)).toBe('mine');
    });

    it('opens an org row only when the server stamped it mine', () => {
        expect(canOpenRun('org', { mine: true })).toBe(true);
        expect(canOpenRun('org', { mine: false })).toBe(false);
        expect(canOpenRun('org', {})).toBe(false);
        expect(canOpenRun('mine', {})).toBe(true);
    });

    it('opens a run on its automation’s run screen', () => {
        expect(runHref({ id: 'r 1', automationId: 'a/1' })).toBe('/automations/a%2F1/runs?runId=r%201');
    });
});
