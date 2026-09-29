import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { __resetBatchClient } from './dataBatchClient';
import { DataProvider } from './DataContext';
import useAppDataSource from './useAppDataSource';

/**
 * The join between react-query and the coalescer.
 *
 * dataBatchClient.test.js proves the transport never turns a batch-level
 * failure into data. This file proves the OTHER half: that when it hands back
 * NOT_BATCHED, the binding is actually fetched the old way and the viewer sees
 * their rows — on a public page, in a demo, and against a server that has never
 * heard of /data/batch.
 */

vi.mock('../../../../../utils/helpers', () => ({
    API_BASE: '',
    authFetch: vi.fn(),
}));


import { authFetch } from '../../../../../utils/helpers';

const observed = [];
vi.mock('@tanstack/react-query', async () => {
    const actual = await vi.importActual('@tanstack/react-query');
    return {
        ...actual,
        useQuery: (opts) => {
            observed.push(opts);
            return { data: undefined, isError: false, isSuccess: false, error: null };
        },
    };
});

function wrapper({ children }) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return (
        <QueryClientProvider client={client}>
            <DataProvider appId="app_1">{children}</DataProvider>
        </QueryClientProvider>
    );
}

function reply(status, body, headers = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (k) => headers[k] ?? null },
        json: async () => body,
    };
}

/** Run the queryFn the hook configured — that is where fetchBinding lives. */
function fetchFor(binding, opts = {}) {
    observed.length = 0;
    renderHook(() => useAppDataSource(binding, opts), { wrapper });
    return observed[observed.length - 1].queryFn();
}

const urlsCalled = () => authFetch.mock.calls.map((c) => c[0]);

beforeEach(() => {
    __resetBatchClient();
    authFetch.mockReset();
    vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe('the batch path', () => {
    it('serves a records binding from the batch, without touching /records', async () => {
        // The descriptor id is the binding's cache key, so read it off the call
        // rather than guessing at the key format.
        authFetch.mockImplementation(async (_url, o) => {
            const id = JSON.parse(o.body).reads[0].id;
            return reply(200, { results: [{ id, ok: true, data: { records: [{ id: 'r1' }] } }] });
        });

        const rows = await fetchFor({ kind: 'records', tableId: 'tbl_a' });
        expect(rows).toEqual([{ id: 'r1' }]);
        expect(urlsCalled()).toEqual(['/api/studio-apps/app_1/data/batch']);
    });

    it('takes the first row for a single-record binding, as the direct path does', async () => {
        authFetch.mockImplementation(async (_url, o) => {
            const id = JSON.parse(o.body).reads[0].id;
            return reply(200, { results: [{ id, ok: true, data: { records: [{ id: 'r1' }, { id: 'r2' }] } }] });
        });
        await expect(fetchFor({ kind: 'record', tableId: 'tbl_a' })).resolves.toEqual({ id: 'r1' });
    });

    it('keeps a per-read 404 fail-soft: an empty list, never an error', async () => {
        authFetch.mockImplementation(async (_url, o) => {
            const id = JSON.parse(o.body).reads[0].id;
            return reply(200, { results: [{ id, ok: false, status: 404, error: 'Table not found' }] });
        });
        await expect(fetchFor({ kind: 'records', tableId: 'tbl_gone' })).resolves.toEqual([]);
        await expect(fetchFor({ kind: 'record', tableId: 'tbl_gone' })).resolves.toBe(null);
    });

    it('surfaces a per-read refusal that is NOT a 404', async () => {
        authFetch.mockImplementation(async (_url, o) => {
            const id = JSON.parse(o.body).reads[0].id;
            return reply(200, { results: [{ id, ok: false, status: 403, error: 'Forbidden' }] });
        });
        await expect(fetchFor({ kind: 'records', tableId: 'tbl_a' })).rejects.toMatchObject({ status: 403 });
    });
});

describe('the downgrade actually fetches', () => {
    it('a 404 on /data/batch falls through to /records and returns the rows', async () => {
        // This is the public-page and demo-page case, and the old-server case.
        // Before the fallback existed this scenario rendered a blank screen.
        authFetch.mockImplementation(async (url) => {
            if (url.includes('/data/batch')) return reply(404, { error: 'Not available on a public page' });
            return reply(200, { records: [{ id: 'real' }], appVersion: 2 });
        });

        const rows = await fetchFor({ kind: 'records', tableId: 'tbl_a' });
        expect(rows).toEqual([{ id: 'real' }]);
        expect(urlsCalled().some((u) => u.includes('/data/tables/tbl_a/records'))).toBe(true);
    });

    it('and every later read on that app goes straight down the single path', async () => {
        authFetch.mockImplementation(async (url) => {
            if (url.includes('/data/batch')) return reply(404, {});
            return reply(200, { records: [] });
        });
        await fetchFor({ kind: 'records', tableId: 'tbl_a' });
        authFetch.mockClear();
        await fetchFor({ kind: 'records', tableId: 'tbl_b' });
        expect(urlsCalled().some((u) => u.includes('/data/batch'))).toBe(false);
    });

    it('an aggregate downgrades to /data/query with the descriptor it always sent', async () => {
        authFetch.mockImplementation(async (url) => {
            if (url.includes('/data/batch')) return reply(404, {});
            return reply(200, { rows: [{ n: 3 }] });
        });
        const rows = await fetchFor({ kind: 'aggregate', tableId: 'tbl_a', aggregates: [{ fn: 'count', as: 'n' }] });
        expect(rows).toEqual([{ n: 3 }]);
        const queryCall = authFetch.mock.calls.find((c) => c[0].includes('/data/query'));
        expect(JSON.parse(queryCall[1].body)).toMatchObject({ tableId: 'tbl_a', aggregates: [{ fn: 'count', as: 'n' }] });
    });
});

describe('what never batches', () => {
    it('a connector runs on its own route — it is a side effect, not a read', async () => {
        authFetch.mockResolvedValue(reply(200, { rows: [{ id: 'x' }] }));
        await fetchFor({ kind: 'connector', connectorId: 'con_1' });
        expect(urlsCalled()).toEqual(['/api/studio-apps/app_1/data/connectors/con_1/run']);
    });

    it('the org directory is not app data, so it keeps its own call', async () => {
        authFetch.mockResolvedValue(reply(200, { result: [{ id: 'u1' }] }));
        await fetchFor({ kind: 'dataset', datasetId: 'sys_org_members' });
        expect(urlsCalled()).toEqual(['/api/studio-apps/app_1/data/query']);
    });
});

describe('sampled and live never share a batched read', () => {
    it('the descriptor id separates them, so an edit preview cannot serve a run view', async () => {
        const ids = [];
        authFetch.mockImplementation(async (_url, o) => {
            const reads = JSON.parse(o.body).reads;
            reads.forEach((r) => ids.push(r.id));
            return reply(200, { results: reads.map((r) => ({ id: r.id, ok: true, data: { records: [] } })) });
        });
        const binding = { kind: 'records', tableId: 'tbl_a' };
        await Promise.all([fetchFor(binding, { sample: true }), fetchFor(binding, { sample: false })]);
        expect(ids).toHaveLength(2);
        expect(new Set(ids).size).toBe(2);
        expect(ids.some((id) => id.startsWith('sample:'))).toBe(true);
        expect(ids.some((id) => id.startsWith('live:'))).toBe(true);
    });
});
