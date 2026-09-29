import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Mocks ──────────────────────────────────────────────────────────────────
// One mutable api object the mocked hook returns; methods are reassigned
// fresh (vi.fn) per test so call assertions stay isolated.
const { apiMock } = vi.hoisted(() => ({ apiMock: {} }));

vi.mock('../../../../hooks/useAutomationApi', () => ({ default: () => apiMock }));

import useExecutions, { statusFilterToServer, sanitizeStoredFilters } from './useExecutions.js';
import scopedStorage, { setCurrentUser } from '../../../../utils/scopedStorage';

// ── Fixtures ─────────────────────────────────────────────────────────────────
const iso = () => new Date().toISOString();

const RUNS = [
    { id: 'r1', status: 'success', startedAt: '2026-06-27T10:00:00.000Z', automationId: 'a1', automationTitle: 'Auto' },
    { id: 'r2', status: 'success', startedAt: '2026-06-27T09:00:00.000Z', automationId: 'a1', automationTitle: 'Auto' },
];

beforeEach(() => {
    apiMock.listRecentRuns = vi.fn().mockResolvedValue({ runs: RUNS, nextCursor: null });
    apiMock.listRuns = vi.fn().mockResolvedValue({ runs: [], nextCursor: null });
    apiMock.listStepRuns = vi.fn().mockResolvedValue({ runs: [], nextCursor: null });
    apiMock.getRunFacets = vi.fn().mockResolvedValue({ facets: {} });
    apiMock.listOrgRuns = vi.fn().mockResolvedValue({ runs: [{ id: 'o1', mine: false }], nextCursor: null });
    apiMock.getOrgRunFacets = vi.fn().mockResolvedValue({ facets: { automations: [] } });
});

// ── statusFilterToServer ─────────────────────────────────────────────────────
describe('statusFilterToServer', () => {
    it('maps each filter to its server status set', () => {
        expect(statusFilterToServer('all')).toBeUndefined();
        expect(statusFilterToServer('running')).toEqual(['running', 'queued']);
        expect(statusFilterToServer('awaiting')).toEqual(['awaiting_approval', 'awaiting_confirm', 'awaiting_form']);
        expect(statusFilterToServer('cancelled')).toEqual(['cancelled']);
        expect(statusFilterToServer('error')).toEqual(['error']);
        expect(statusFilterToServer('success')).toEqual(['success']);
    });

    it('maps an unknown chip value to "no filter" instead of forwarding it to the server', () => {
        expect(statusFilterToServer('exploded')).toBeUndefined();
        expect(statusFilterToServer('DROP TABLE runs')).toBeUndefined();
    });
});

// ── sanitizeStoredFilters ────────────────────────────────────────────────────
describe('sanitizeStoredFilters', () => {
    it('adopts only known fields with known values', () => {
        expect(sanitizeStoredFilters({ status: 'error', range: '7d', mode: 'both', trigger: 'cron', automationId: 'a1' }))
            .toEqual({ status: 'error', range: '7d', mode: 'both', trigger: 'cron', automationId: 'a1' });
    });

    it('strips unknown fields — nothing outside the explicit list survives a round-trip', () => {
        expect(sanitizeStoredFilters({ status: 'error', bogus: 'x', __proto__foo: 1 }))
            .toEqual({ status: 'error' });
    });

    it('drops known fields carrying unknown or mistyped values', () => {
        expect(sanitizeStoredFilters({ status: 'exploded', range: '99d', mode: 'chaos', trigger: 42, automationId: null }))
            .toBeNull();
        expect(sanitizeStoredFilters({ status: 'success', mode: 7 })).toEqual({ status: 'success' });
    });

    it('rejects non-object shapes outright (valid JSON is not a filter blob)', () => {
        expect(sanitizeStoredFilters(null)).toBeNull();
        expect(sanitizeStoredFilters('error')).toBeNull();
        expect(sanitizeStoredFilters(['error'])).toBeNull();
        expect(sanitizeStoredFilters(7)).toBeNull();
    });
});

// ── stored-filter hydration ──────────────────────────────────────────────────
describe('useExecutions — stored filter hydration', () => {
    beforeEach(() => {
        localStorage.clear();
        setCurrentUser('runs-test-user');
    });
    afterEach(() => {
        localStorage.clear();
        setCurrentUser(null);
    });

    it('adopts a valid stored filter and keeps defaults for the rest', async () => {
        scopedStorage.setItem('runsFilters.global', JSON.stringify({ status: 'error', range: '7d' }));
        const { result } = renderHook(() => useExecutions({ scope: 'global' }));
        await waitFor(() => expect(result.current.filters.status).toBe('error'));
        expect(result.current.filters.range).toBe('7d');
        expect(result.current.filters.mode).toBe('live'); // untouched default
    });

    it('renders with defaults when the stored blob is corrupt or hostile', async () => {
        scopedStorage.setItem('runsFilters.global', '{definitely not json');
        const { result } = renderHook(() => useExecutions({ scope: 'global' }));
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current.filters).toEqual({ status: 'all', range: '24h', trigger: null, automationId: null, mode: 'live' });
    });

    it('does not let an unknown stored field live on into the next serialisation', async () => {
        scopedStorage.setItem('runsFilters.global', JSON.stringify({ status: 'error', zombie: 'field' }));
        const { result } = renderHook(() => useExecutions({ scope: 'global' }));
        await waitFor(() => expect(result.current.filters.status).toBe('error'));
        expect('zombie' in result.current.filters).toBe(false);
        act(() => { result.current.setFilters(prev => ({ ...prev, range: '7d' })); });
        expect(JSON.parse(scopedStorage.getItem('runsFilters.global'))).not.toHaveProperty('zombie');
    });
});

// ── hook ─────────────────────────────────────────────────────────────────────
describe('useExecutions — runScope (whose runs)', () => {
    it('defaults to the user-scoped endpoints when no runScope is passed', async () => {
        const { result } = renderHook(() => useExecutions({ scope: 'global' }));
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(apiMock.listRecentRuns).toHaveBeenCalled();
        expect(apiMock.listOrgRuns).not.toHaveBeenCalled();
        expect(apiMock.getRunFacets).toHaveBeenCalled();
        expect(apiMock.getOrgRunFacets).not.toHaveBeenCalled();
        expect(result.current.runScope).toBe('mine');
    });

    it('runScope="org" reads the SEPARATE org endpoints, never the user-scoped ones', async () => {
        const { result } = renderHook(() => useExecutions({ scope: 'global', runScope: 'org' }));
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(apiMock.listOrgRuns).toHaveBeenCalled();
        expect(apiMock.listRecentRuns).not.toHaveBeenCalled();
        await waitFor(() => expect(apiMock.getOrgRunFacets).toHaveBeenCalled());
        expect(apiMock.getRunFacets).not.toHaveBeenCalled();
        expect(result.current.runScope).toBe('org');
        expect(result.current.rows.map(r => r.id)).toEqual(['o1']);
    });

    it('a per-routine or per-Step surface stays personal even when handed "org"', async () => {
        // A stray 'org' — from a stale prop, or a screen that forgot which
        // surface it was mounting — must not turn the builder's own history
        // tab into "this routine's runs by anyone".
        for (const scope of ['automation', 'step']) {
            apiMock.listOrgRuns.mockClear();
            const { result } = renderHook(() => useExecutions({ scope, automationId: 'a1', stepId: 's1', runScope: 'org' }));
            await waitFor(() => expect(result.current.loading).toBe(false));
            expect(apiMock.listOrgRuns, `${scope} must not read the org list`).not.toHaveBeenCalled();
            expect(result.current.runScope).toBe('mine');
        }
    });

    it('an unknown runScope value narrows to "mine" rather than widening', async () => {
        for (const bad of ['ORG', 'everyone', 1, true, null]) {
            apiMock.listOrgRuns.mockClear();
            const { result } = renderHook(() => useExecutions({ scope: 'global', runScope: bad }));
            await waitFor(() => expect(result.current.loading).toBe(false));
            expect(apiMock.listOrgRuns, `${JSON.stringify(bad)} must not reach the org list`).not.toHaveBeenCalled();
            expect(result.current.runScope).toBe('mine');
        }
    });

    it('a refused org read surfaces as an error, and never as an empty list', async () => {
        // The server 403s a caller without manage_automations rather than
        // quietly answering with their own runs. The hook must carry that
        // through: "no runs in your organisation" and "you may not read your
        // organisation's runs" are different screens.
        apiMock.listOrgRuns = vi.fn().mockRejectedValue(new Error('Reading the organisation\'s runs requires the manage_automations permission.'));
        const { result } = renderHook(() => useExecutions({ scope: 'global', runScope: 'org' }));
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current.error).toBeTruthy();
        expect(result.current.rows).toEqual([]);
        expect(result.current.hasMore).toBe(false);
    });

    it('clears the facets when a facets read fails, rather than showing the other scope\'s numbers', async () => {
        apiMock.getOrgRunFacets = vi.fn().mockRejectedValue(new Error('403'));
        const { result } = renderHook(() => useExecutions({ scope: 'global', runScope: 'org' }));
        await waitFor(() => expect(result.current.loading).toBe(false));
        await waitFor(() => expect(result.current.facets).toBeNull());
    });

    it('the persisted filter blob cannot carry a scope back in', async () => {
        // runScope is a prop, not a filter, precisely because storage outlives
        // a permission. Even a blob that names one must not be adopted.
        localStorage.clear();
        setCurrentUser('runs-scope-user');
        scopedStorage.setItem('runsFilters.global', JSON.stringify({ status: 'error', runScope: 'org', scope: 'org' }));
        const { result } = renderHook(() => useExecutions({ scope: 'global' }));
        await waitFor(() => expect(result.current.filters.status).toBe('error'));
        expect(apiMock.listOrgRuns).not.toHaveBeenCalled();
        expect(result.current.runScope).toBe('mine');
        expect(result.current.filters.runScope).toBeUndefined();
        setCurrentUser(null);
        localStorage.clear();
    });
});

describe('useExecutions — load + live merge', () => {
    const renderLoaded = async () => {
        const view = renderHook(() => useExecutions({ scope: 'global' }));
        await waitFor(() => expect(view.result.current.loading).toBe(false));
        await waitFor(() => expect(view.result.current.rows).toHaveLength(2));
        return view;
    };

    it('initial load yields the mocked runs', async () => {
        const { result } = await renderLoaded();
        expect(result.current.rows.map(r => r.id)).toEqual(['r1', 'r2']);
        expect(result.current.rows[0].status).toBe('success');
    });

    it('run.started PREPENDS a new running row', async () => {
        const { result } = await renderLoaded();
        act(() => {
            result.current.applyEvent('run.started', {
                runId: 'r3', automationId: 'a1', title: 'Auto', status: 'running', at: iso(),
            });
        });
        expect(result.current.rows).toHaveLength(3);
        expect(result.current.rows[0].id).toBe('r3');
        expect(result.current.rows[0].status).toBe('running');
    });

    it('run.finished PATCHES the existing row and does not add a row', async () => {
        const { result } = await renderLoaded();
        act(() => {
            result.current.applyEvent('run.finished', { runId: 'r1', status: 'success', durationMs: 1200 });
        });
        expect(result.current.rows).toHaveLength(2);
        const r1 = result.current.rows.find(r => r.id === 'r1');
        expect(r1.durationMs).toBe(1200);
    });

    it('run.started for an existing run does not duplicate; updates in place', async () => {
        const { result } = await renderLoaded();
        act(() => {
            result.current.applyEvent('run.started', {
                runId: 'r2', automationId: 'a1', title: 'Auto', status: 'running', at: iso(),
            });
        });
        expect(result.current.rows).toHaveLength(2);
        const r2 = result.current.rows.find(r => r.id === 'r2');
        expect(r2.status).toBe('running');
    });

    it('step.* events are a no-op on the list', async () => {
        const { result } = await renderLoaded();
        const before = result.current.rows;
        act(() => {
            result.current.applyEvent('step.started', { runId: 'r1', stepId: 's1' });
            result.current.applyEvent('step.finished', { runId: 'r1', stepId: 's1' });
            result.current.applyEvent('step.heartbeat', { runId: 'r1', stepId: 's1' });
        });
        expect(result.current.rows).toBe(before);
        expect(result.current.rows).toHaveLength(2);
    });
});
