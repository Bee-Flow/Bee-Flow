import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __resetBatchClient } from '@/api/dataBatchClient';
import { setDemoTransport } from '@/utils/helpers';
import { DataProvider } from './DataContext';
import { dataCacheKey, resolveBinding, resolveBindingParams } from './resolveBinding';
import useAppDataSource from './useAppDataSource';

/**
 * Dataset bindings with params: the values resolve like connector params, join
 * the cache key only when there are any, and travel with the read (batched and
 * single). A dataset binding without params keeps `dataset:<id>` and sends
 * exactly the body it always did.
 */

const scope = { vars: { region: 'EU' } };
const f = (expr: string) => ({ kind: 'formula', expr });

describe('dataset params in the key', () => {
    it('keeps dataset:<id> without params', () => {
        expect(dataCacheKey({ kind: 'dataset', datasetId: 'd1' })).toBe('dataset:d1');
        expect(dataCacheKey({ kind: 'dataset', datasetId: 'd1', params: {} })).toBe('dataset:d1');
        expect(dataCacheKey({ kind: 'dataset', datasetId: 'd1', params: [1] })).toBe('dataset:d1');
    });

    it('adds the resolved values, sorted', () => {
        const resolved = resolveBindingParams({ kind: 'dataset', datasetId: 'd1', params: { region: f('vars.region'), gone: f('vars.none'), n: 2 } }, scope);
        expect(resolved).toEqual({ kind: 'dataset', datasetId: 'd1', params: { region: 'EU', n: 2 } });
        expect(dataCacheKey(resolved)).toBe('dataset:d1:{"n":2,"region":"EU"}');
    });

    it('reads the entry under the resolved key', () => {
        const binding = { kind: 'dataset' as const, datasetId: 'd1', params: { region: f('vars.region') } };
        const dataState = { 'dataset:d1:{"region":"EU"}': { status: 'success', result: [{ n: 4 }] } };
        expect(resolveBinding(binding, { scope, dataState, actionState: {} }).value).toEqual([{ n: 4 }]);
    });

    it('leaves a binding without params as the same object', () => {
        const binding = { kind: 'dataset' as const, datasetId: 'd1' };
        expect(resolveBindingParams(binding, scope)).toBe(binding);
    });
});

describe('dataset params on the wire', () => {
    const sent: Array<{ url: string; body: unknown }> = [];
    let batching = true;

    beforeEach(() => {
        sent.length = 0;
        __resetBatchClient();
        setDemoTransport(async (url, options) => {
            const body = options && typeof options.body === 'string' ? JSON.parse(options.body) : null;
            sent.push({ url, body });
            if (url.endsWith('/data/batch')) {
                if (!batching) return new Response('{}', { status: 404 });
                const reads = (body as { reads: Array<{ id: string }> }).reads;
                return new Response(JSON.stringify({ results: reads.map((r) => ({ id: r.id, ok: true, data: { rows: [], result: [] } })) }), { status: 200 });
            }
            return new Response(JSON.stringify({ rows: [], result: [] }), { status: 200 });
        });
    });
    afterEach(() => { setDemoTransport(null); });

    function wrapper({ children }: { children?: ReactNode }) {
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        return (
            <QueryClientProvider client={client}>
                <DataProvider appId="app_1">{children}</DataProvider>
            </QueryClientProvider>
        );
    }

    async function readsFor(binding: unknown) {
        renderHook(() => useAppDataSource(binding), { wrapper });
        await waitFor(() => expect(sent.some((s) => s.url.endsWith('/data/query') || (batching && s.url.endsWith('/data/batch')))).toBe(true));
        return sent;
    }

    it('a batched read carries the params', async () => {
        batching = true;
        const calls = await readsFor({ kind: 'dataset', datasetId: 'd1', params: { region: 'EU' } });
        const batch = calls.find((c) => c.url.endsWith('/data/batch'))?.body as { reads: Array<Record<string, unknown>> };
        expect(batch.reads[0]).toMatchObject({ kind: 'dataset', datasetId: 'd1', params: { region: 'EU' } });
    });

    it('a batched read without params has no params key', async () => {
        batching = true;
        const calls = await readsFor({ kind: 'dataset', datasetId: 'd1' });
        const batch = calls.find((c) => c.url.endsWith('/data/batch'))?.body as { reads: Array<Record<string, unknown>> };
        expect(Object.keys(batch.reads[0]).sort()).toEqual(['datasetId', 'id', 'kind']);
    });

    it('the single read sends params, and the old body without them', async () => {
        batching = false;
        await readsFor({ kind: 'dataset', datasetId: 'd1', params: { region: 'EU' } });
        await waitFor(() => expect(sent.some((s) => s.url.endsWith('/data/query'))).toBe(true));
        expect(sent.find((s) => s.url.endsWith('/data/query'))?.body).toEqual({ datasetId: 'd1', params: { region: 'EU' } });

        sent.length = 0;
        __resetBatchClient();
        await readsFor({ kind: 'dataset', datasetId: 'd2' });
        await waitFor(() => expect(sent.some((s) => s.url.endsWith('/data/query'))).toBe(true));
        expect(sent.find((s) => s.url.endsWith('/data/query'))?.body).toEqual({ datasetId: 'd2' });
    });
});
