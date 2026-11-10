import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRequire } from 'node:module';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetBatchClient } from '@/api/dataBatchClient';
import { runtimeValue } from '@/test/appRuntime';
import { collectDataBindings } from './AppDataScope';
import AppList from './components/AppList';
import AppTable from './components/AppTable';
import { DataProvider } from './DataContext';
import {
    FIRST_PAGE, PAGINATION_MODES, isPageableSource, pageOf, paginationModeOf, readsOwnPages, stepBack, stepForward,
} from './pagination';
import { dataCacheKey } from './resolveBinding';
import type { DataBinding } from './resolveBinding.types';
import { RuntimeProvider } from './RuntimeContext';
import type { RuntimeValue } from './RuntimeContext';
import type { NodeProps } from './components/appNode.types';

/**
 * Server paging of a record list (pagination.ts, pagedSource.tsx): the pure
 * walk, the lockstep with the spec, the screen scan leaving a paged source to
 * its component, and a list and a table walking real pages through the batch.
 */

const require = createRequire(import.meta.url);
const { COMPONENT_SPECS } = require('../../../../../../../server/appStudio/componentSpecs.js');

const SOURCE: DataBinding = { kind: 'records', tableId: 'tbl_tasks1', limit: 2 };
const ROWS = [{ id: 'r1', title: 'One' }, { id: 'r2', title: 'Two' }, { id: 'r3', title: 'Three' }];

describe('pagination: the pure part', () => {
    it('offers exactly the modes the spec declares, per type', () => {
        for (const [type, spec] of Object.entries(COMPONENT_SPECS as Record<string, { props: Record<string, { values?: unknown[]; since?: number }> }>)) {
            const prop = spec.props.pagination;
            if (!prop) { expect(PAGINATION_MODES[type]).toBeUndefined(); continue; }
            expect(PAGINATION_MODES[type]).toEqual(prop.values);
            expect(prop.since).toBe(3);
        }
    });

    it('pages only a records source, and only with a mode the type has', () => {
        expect(paginationModeOf('table', 'prevNext')).toBe('prevNext');
        expect(paginationModeOf('data_grid', 'prevNext')).toBeNull();
        expect(paginationModeOf('kanban', 'loadMore')).toBeNull();
        expect(paginationModeOf('list', null)).toBeNull();
        expect(isPageableSource(SOURCE)).toBe(true);
        expect(isPageableSource({ kind: 'static', value: [] })).toBe(false);
        expect(isPageableSource({ kind: 'records' })).toBe(false);
        expect(readsOwnPages({ type: 'list', props: { pagination: 'loadMore', source: SOURCE } })).toBe(true);
        expect(readsOwnPages({ type: 'list', props: { source: SOURCE } })).toBe(false);
    });

    it('walks forward and back, keeping the row offsets', () => {
        const two = stepForward(FIRST_PAGE, 'c2', 2);
        const three = stepForward(two, 'c3', 2);
        expect(three).toEqual({ cursors: [null, 'c2', 'c3'], offsets: [0, 2, 4], index: 2 });
        const back = stepBack(stepBack(three));
        expect(back.index).toBe(0);
        expect(stepBack(back)).toBe(back);
        expect(stepForward(back, 'c2', 2)).toEqual({ ...three, index: 1 });
    });

    it('reads a records answer as a page, total only when it is a count', () => {
        expect(pageOf({ records: [ROWS[0], null], nextCursor: 'c', total: 3 })).toEqual({ rows: [ROWS[0]], nextCursor: 'c', total: 3 });
        expect(pageOf({ records: [], nextCursor: null })).toEqual({ rows: [], nextCursor: null, total: null });
        expect(pageOf(null)).toEqual({ rows: [], nextCursor: null, total: null });
    });
});

describe('the screen scan', () => {
    const def = (props: Record<string, unknown>, also: Record<string, unknown>[] = []) => ({
        screens: [{ id: 'scr_1', sections: [{ id: 'sec_1', children: [
            { id: 'cmp_a', type: 'list', props: { source: { ...SOURCE }, ...props } },
            ...also,
        ] }] }],
    });

    it('marks the source of a paged list pagedOnly (the list reads it), and leaves every other binding as it was', () => {
        const key = dataCacheKey(SOURCE);
        expect(collectDataBindings(def({ pagination: 'loadMore' }), 'scr_1')).toEqual([{ cacheKey: key, binding: SOURCE, live: null, pagedOnly: true }]);
        expect(collectDataBindings(def({}), 'scr_1')).toEqual([{ cacheKey: key, binding: SOURCE, live: null }]);
        expect(collectDataBindings(def({ pagination: 'sideways' }), 'scr_1')[0]).not.toHaveProperty('pagedOnly');
        // A plain component reading the same query still gets it fetched, before or after the paged one.
        const plain = { id: 'cmp_b', type: 'table', props: { source: { ...SOURCE } } };
        expect(collectDataBindings(def({ pagination: 'loadMore' }, [plain]), 'scr_1')[0]).not.toHaveProperty('pagedOnly');
        const pagedSecond = { screens: [{ id: 'scr_1', sections: [{ id: 'sec_1', children: [plain, { id: 'cmp_a', type: 'list', props: { source: { ...SOURCE }, pagination: 'loadMore' } }] }] }] };
        expect(collectDataBindings(pagedSecond, 'scr_1')[0]).not.toHaveProperty('pagedOnly');
    });
});

// ── Components over a stubbed batch route ───────────────────────────

type Read = { id: string; cursor?: string; total?: boolean; limit?: number };
let reads: Read[] = [];

function answerBatch(read: Read) {
    const start = read.cursor === 'c2' ? 2 : 0;
    const page = ROWS.slice(start, start + (read.limit ?? 50));
    return {
        id: read.id, ok: true,
        data: { records: page, nextCursor: start + page.length < ROWS.length ? 'c2' : null, ...(read.total ? { total: ROWS.length } : {}) },
    };
}

beforeEach(() => {
    __resetBatchClient();
    reads = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        const body = JSON.parse(String((init as RequestInit).body)) as { reads: Read[] };
        reads.push(...body.reads);
        return new Response(JSON.stringify({ results: body.reads.map(answerBatch) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
});
afterEach(() => { vi.restoreAllMocks(); });

function mount(ui: ReactElement, runtime: Partial<RuntimeValue> = {}) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
        <QueryClientProvider client={client}>
            <DataProvider appId="app_1">
                <RuntimeProvider value={runtimeValue({ mode: 'run', ...runtime })}>{ui}</RuntimeProvider>
            </DataProvider>
        </QueryClientProvider>,
    );
}

const listNode = (props: Record<string, unknown>) => ({ id: 'cmp_l', type: 'list', props: { source: SOURCE, titleKey: 'title', ...props } }) as NodeProps['node'];
const tableNode = (props: Record<string, unknown>) => ({
    id: 'cmp_t', type: 'table', props: { source: SOURCE, columns: [{ key: 'title', label: 'Title' }], rowLimit: 1, ...props },
}) as NodeProps['node'];

describe('a paged list and table', () => {
    it('loadMore: page one with its total, then the next page joined under it', async () => {
        mount(<AppList node={listNode({ pagination: 'loadMore' })} />);
        expect(await screen.findByText('Two')).toBeTruthy();
        expect(screen.queryByText('Three')).toBeNull();
        expect(screen.getByText('2 of 3')).toBeTruthy();
        expect(reads).toEqual([expect.objectContaining({ kind: 'records', tableId: 'tbl_tasks1', limit: 2, total: true })]);
        expect(reads[0]).not.toHaveProperty('cursor');

        await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
        expect(await screen.findByText('Three')).toBeTruthy();
        expect(screen.getByText('One')).toBeTruthy();
        expect(reads[1]).toMatchObject({ cursor: 'c2', total: true });
        expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
        expect(screen.getByText('3 of 3')).toBeTruthy();
    });

    it('prevNext: one page at a time, a range, and the way back; rowLimit does not cut a paged table', async () => {
        mount(<AppTable node={tableNode({ pagination: 'prevNext' })} />);
        expect(await screen.findByText('Two')).toBeTruthy();
        expect(screen.getByText('1–2 of 3')).toBeTruthy();
        expect((screen.getByRole('button', { name: 'Previous' }) as HTMLButtonElement).disabled).toBe(true);

        await userEvent.click(screen.getByRole('button', { name: 'Next' }));
        expect(await screen.findByText('Three')).toBeTruthy();
        expect(screen.queryByText('One')).toBeNull();
        expect(screen.getByText('3–3 of 3')).toBeTruthy();
        expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);

        await userEvent.click(screen.getByRole('button', { name: 'Previous' }));
        expect(await screen.findByText('One')).toBeTruthy();
    });

    it('without pagination the list reads its source as before: no own read, no bar', async () => {
        const dataState = { [dataCacheKey(SOURCE) as string]: { status: 'success', result: ROWS.slice(0, 2) } };
        const { container } = mount(<AppList node={listNode({})} />, { dataState });
        expect(screen.getByText('Two')).toBeTruthy();
        expect(container.querySelector('[data-app-pager]')).toBeNull();
        await new Promise((r) => setTimeout(r, 20));
        expect(reads).toEqual([]);
    });

    it('a source that is not a records read is not paged', () => {
        const { container } = mount(<AppList node={listNode({ pagination: 'loadMore', source: { kind: 'static', value: ROWS } })} />);
        expect(screen.getByText('Three')).toBeTruthy();
        expect(container.querySelector('[data-app-pager]')).toBeNull();
    });
});
