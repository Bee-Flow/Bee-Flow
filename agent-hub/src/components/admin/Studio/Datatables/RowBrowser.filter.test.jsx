import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { datatablesApi } from './datatablesApi';
import RowBrowser from './RowBrowser';

/**
 * The filter builder, which is the one control on this surface that composes
 * something the server will EXECUTE.
 *
 * So the things worth pinning are not "does it filter" but the three ways a
 * filter can lie:
 *   - it must never let a person express something outside the closed
 *     descriptor (the field comes from the table's own column list, the
 *     operator from the compiler's FILTER_OPS — there is no free-text query);
 *   - it must never SEND a half-typed condition, because `field = ''` comes
 *     back as zero rows and reads as "nothing matches" rather than "you have
 *     not finished";
 *   - it must go back to page one when the question changes, or the first
 *     page of the new answer is silently skipped by the old cursor.
 */

vi.mock('./datatablesApi', () => {
    const datatablesApi = {
        getSchema: vi.fn(), listRows: vi.fn(), getRow: vi.fn(), addRow: vi.fn(),
        updateRow: vi.fn(), deleteRow: vi.fn(), bulkImport: vi.fn(), bulkDeleteRows: vi.fn(),
        exportCsv: vi.fn(),
    };
    return { datatablesApi, default: datatablesApi };
});

const TABLE = { id: 'tbl_1', key: 'customers', name: 'Customers', grade: 'owner', rowCount: 2 };

const COLUMNS = [
    { key: 'email', name: 'E-mail', type: 'text' },
    { key: 'total', name: 'Total', type: 'number' },
    { key: 'stage', name: 'Stage', type: 'select', options: ['new', 'won'] },
];

const ROW = {
    id: 'rec_1', email: 'a@b.c', total: 10, stage: 'new',
    created_at: '2026-03-01T10:00:00.000Z', updated_at: '2026-03-01T10:00:00.000Z',
};

beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    datatablesApi.getSchema.mockResolvedValue({ fields: COLUMNS, modelVersion: 1 });
    datatablesApi.listRows.mockResolvedValue({
        rows: [ROW], hasMore: false, count: 1, nextCursor: null, total: 1,
    });
});

async function openFilter() {
    render(<RowBrowser table={TABLE} />);
    await screen.findByText('a@b.c');
    fireEvent.click(screen.getByRole('button', { name: /^Filter$/i }));
    return screen.findByRole('button', { name: /Add a condition/i });
}

/** The last descriptor the browser asked the server for. */
function lastCall() {
    const calls = datatablesApi.listRows.mock.calls;
    return calls[calls.length - 1][1];
}

describe('the filter is built from the table, not typed', () => {
    it('offers the table\'s own columns plus the two system dates, and nothing else', async () => {
        await openFilter();
        fireEvent.click(screen.getByRole('button', { name: /Add a condition/i }));
        const field = await screen.findByLabelText(/Column to filter on/i);
        const offered = [...field.options].map(o => o.value);
        expect(offered).toEqual(['email', 'total', 'stage', 'created_at', 'updated_at']);
        // `id`, `created_by` and `org_id` are filterable server-side but are
        // opaque identifiers — a dropdown of things nobody can fill in.
        expect(offered).not.toContain('id');
        expect(offered).not.toContain('org_id');
    });

    it('offers operators that suit the column, and swaps them when the column changes', async () => {
        await openFilter();
        fireEvent.click(screen.getByRole('button', { name: /Add a condition/i }));
        const test = await screen.findByLabelText(/Test to apply/i);
        expect([...test.options].map(o => o.value)).toContain('contains');

        fireEvent.change(screen.getByLabelText(/Column to filter on/i), { target: { value: 'total' } });
        const numeric = [...screen.getByLabelText(/Test to apply/i).options].map(o => o.value);
        expect(numeric).toContain('gte');
        // "contains" on a NUMERIC column compiles, and then never matches.
        expect(numeric).not.toContain('contains');
    });
});

describe('applying a filter', () => {
    it('sends the closed descriptor and the match mode', async () => {
        await openFilter();
        fireEvent.click(screen.getByRole('button', { name: /Add a condition/i }));
        fireEvent.change(await screen.findByLabelText(/Column to filter on/i), { target: { value: 'stage' } });
        fireEvent.change(screen.getByLabelText(/Test to apply/i), { target: { value: 'in' } });
        fireEvent.change(screen.getByLabelText(/Value to compare with/i), { target: { value: 'new, won' } });
        fireEvent.change(screen.getByLabelText(/Match all or any condition/i), { target: { value: 'any' } });
        fireEvent.click(screen.getByRole('button', { name: /Apply/i }));

        await waitFor(() => expect(lastCall().filters).toEqual([{ field: 'stage', op: 'in', value: ['new', 'won'] }]));
        expect(lastCall().match).toBe('any');
        // Still keyset, still from the top.
        expect(lastCall().cursor).toBeNull();
    });

    it('never sends a condition with nothing typed in it', async () => {
        await openFilter();
        fireEvent.click(screen.getByRole('button', { name: /Add a condition/i }));
        await screen.findByLabelText(/Value to compare with/i);
        fireEvent.click(screen.getByRole('button', { name: /^Apply$/i }));
        // Half-typed, so the descriptor stays empty and the rows on screen are
        // still the unfiltered ones. `email = ''` would come back as zero rows
        // and read as "nothing matches" rather than "you have not finished".
        await waitFor(() => expect(screen.getByText('a@b.c')).toBeInTheDocument());
        for (const [, opts] of datatablesApi.listRows.mock.calls) {
            expect(opts.filters || []).toEqual([]);
        }
    });

    it('a condition that becomes answerable IS sent, from page one', async () => {
        await openFilter();
        fireEvent.click(screen.getByRole('button', { name: /Add a condition/i }));
        fireEvent.change(await screen.findByLabelText(/Value to compare with/i), { target: { value: 'a@b' } });
        fireEvent.click(screen.getByRole('button', { name: /Apply/i }));
        await waitFor(() => expect(lastCall().filters).toEqual([{ field: 'email', op: 'eq', value: 'a@b' }]));
    });

    it('an "is empty" condition needs no value at all', async () => {
        await openFilter();
        fireEvent.click(screen.getByRole('button', { name: /Add a condition/i }));
        fireEvent.change(await screen.findByLabelText(/Test to apply/i), { target: { value: 'isNull' } });
        expect(screen.queryByLabelText(/Value to compare with/i)).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: /Apply/i }));
        await waitFor(() => expect(lastCall().filters).toEqual([{ field: 'email', op: 'isNull', value: null }]));
    });

    it('clearing takes the conditions off the request, not just off the screen', async () => {
        await openFilter();
        fireEvent.click(screen.getByRole('button', { name: /Add a condition/i }));
        fireEvent.change(await screen.findByLabelText(/Value to compare with/i), { target: { value: 'a@b.c' } });
        fireEvent.click(screen.getByRole('button', { name: /Apply/i }));
        await waitFor(() => expect(lastCall().filters.length).toBe(1));

        fireEvent.click(screen.getByRole('button', { name: /^Clear$/i }));
        await waitFor(() => expect(lastCall().filters).toEqual([]));
    });

    it('says how many conditions are in force, on the closed control', async () => {
        await openFilter();
        fireEvent.click(screen.getByRole('button', { name: /Add a condition/i }));
        fireEvent.change(await screen.findByLabelText(/Value to compare with/i), { target: { value: 'a@b.c' } });
        fireEvent.click(screen.getByRole('button', { name: /Apply/i }));
        await waitFor(() => expect(lastCall().filters.length).toBe(1));
        // The panel can be closed; a filter that is still in force must not be
        // invisible from the toolbar.
        expect(await screen.findByRole('button', { name: /Filter \(1\)/ })).toBeInTheDocument();
    });

    it('a filtered empty result says "no rows match", not "no rows yet"', async () => {
        await openFilter();
        datatablesApi.listRows.mockResolvedValue({ rows: [], hasMore: false, count: 0, nextCursor: null, total: 1 });
        fireEvent.click(screen.getByRole('button', { name: /Add a condition/i }));
        fireEvent.change(await screen.findByLabelText(/Value to compare with/i), { target: { value: 'zzz' } });
        fireEvent.click(screen.getByRole('button', { name: /Apply/i }));
        expect(await screen.findByText(/No rows match/i)).toBeInTheDocument();
    });

    it('a condition can be taken off the draft again', async () => {
        await openFilter();
        fireEvent.click(screen.getByRole('button', { name: /Add a condition/i }));
        await screen.findByLabelText(/Column to filter on/i);
        fireEvent.click(screen.getByRole('button', { name: /Remove this condition/i }));
        expect(screen.queryByLabelText(/Column to filter on/i)).toBeNull();
    });
});

describe('selecting rows', () => {
    it('select-all ticks every row on the page, and one bulk request deletes them', async () => {
        datatablesApi.listRows.mockResolvedValue({
            rows: [ROW, { ...ROW, id: 'rec_2', email: 'b@b.c' }],
            hasMore: false, count: 2, nextCursor: null, total: 2,
        });
        datatablesApi.bulkDeleteRows.mockResolvedValue({ deleted: 2, requested: 2 });
        render(<RowBrowser table={TABLE} />);
        await screen.findByText('a@b.c');

        fireEvent.click(screen.getByLabelText(/Select every row on this page/i));
        expect(await screen.findByText(/2 rows selected/i)).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: /Delete selected/i }));
        // It asks first — the same rule a single row delete follows.
        expect(datatablesApi.bulkDeleteRows).not.toHaveBeenCalled();
        fireEvent.click(await screen.findByRole('button', { name: /Delete them/i }));

        await waitFor(() => expect(datatablesApi.bulkDeleteRows).toHaveBeenCalledTimes(1));
        expect(datatablesApi.bulkDeleteRows).toHaveBeenCalledWith('tbl_1', ['rec_1', 'rec_2']);
    });

    it('reports the number the SERVER deleted, not the number asked for', async () => {
        // `deleted` is what Postgres removed after the access predicate. A row
        // a colleague deleted a second ago is not this account's to claim.
        datatablesApi.listRows.mockResolvedValue({
            rows: [ROW, { ...ROW, id: 'rec_2', email: 'b@b.c' }],
            hasMore: false, count: 2, nextCursor: null, total: 2,
        });
        datatablesApi.bulkDeleteRows.mockResolvedValue({ deleted: 1, requested: 2 });
        render(<RowBrowser table={TABLE} />);
        await screen.findByText('a@b.c');
        fireEvent.click(screen.getByLabelText(/Select every row on this page/i));
        fireEvent.click(screen.getByRole('button', { name: /Delete selected/i }));
        fireEvent.click(await screen.findByRole('button', { name: /Delete them/i }));
        expect(await screen.findByText(/Deleted 1 of 2 rows/i)).toBeInTheDocument();
    });

    it('explains the server cap instead of a bare failure', async () => {
        const err = Object.assign(new Error('Too many'), {
            status: 413, code: 'too_many_ids', body: { code: 'too_many_ids', limit: 200, used: 400 },
        });
        datatablesApi.bulkDeleteRows.mockRejectedValue(err);
        render(<RowBrowser table={TABLE} />);
        await screen.findByText('a@b.c');
        fireEvent.click(screen.getByLabelText(/Select every row on this page/i));
        fireEvent.click(screen.getByRole('button', { name: /Delete selected/i }));
        fireEvent.click(await screen.findByRole('button', { name: /Delete them/i }));
        expect(await screen.findByText(/at most 200 rows at a time/i)).toBeInTheDocument();
    });

    it('a viewer is never offered the tick boxes', async () => {
        render(<RowBrowser table={{ ...TABLE, grade: 'viewer' }} />);
        await screen.findByText('a@b.c');
        expect(screen.queryByLabelText(/Select every row on this page/i)).toBeNull();
        expect(screen.queryByLabelText(/Select this row/i)).toBeNull();
    });
});

describe('the expiry column', () => {
    const RETAINED = { ...TABLE, retentionDays: 30, retentionField: 'fetched_at' };

    it('appears only when BOTH halves of the rule are set', async () => {
        render(<RowBrowser table={TABLE} />);
        await screen.findByText('a@b.c');
        expect(screen.queryByText(/^Expires$/)).toBeNull();

        cleanup();
        datatablesApi.listRows.mockResolvedValue({
            rows: [{ ...ROW, fetched_at: new Date(Date.now() - 29 * 86400000).toISOString() }],
            hasMore: false, count: 1, nextCursor: null, total: 1,
        });
        render(<RowBrowser table={RETAINED} />);
        await screen.findByText('a@b.c');
        const header = await screen.findByText(/^Expires$/);
        expect(header).toBeInTheDocument();
        // 29 days into a 30-day window: about to go, and said so.
        expect(within(header.closest('table')).getByText(/today|in 1 days/i)).toBeInTheDocument();
    });

    it('says nothing rather than guessing when the row has no date', async () => {
        datatablesApi.listRows.mockResolvedValue({
            rows: [{ ...ROW, fetched_at: null }], hasMore: false, count: 1, nextCursor: null, total: 1,
        });
        render(<RowBrowser table={RETAINED} />);
        await screen.findByText('a@b.c');
        const table = screen.getByText(/^Expires$/).closest('table');
        expect(within(table).getAllByText('—').length).toBeGreaterThan(0);
    });
});

describe('the managed cell renderer', () => {
    const CACHE = { ...TABLE, managedKind: 'http_cache' };
    const CACHE_COLUMNS = [
        { key: 'cache_key', name: 'Answer key', type: 'text' },
        { key: 'response_status', name: 'Status', type: 'number' },
        { key: 'request_method', name: 'Method', type: 'text' },
    ];

    it('paints an answer code as a status, not as a number in a row', async () => {
        datatablesApi.getSchema.mockResolvedValue({ fields: CACHE_COLUMNS, modelVersion: 1 });
        datatablesApi.listRows.mockResolvedValue({
            rows: [
                { id: 'r1', cache_key: 'k:1', response_status: 200, request_method: 'get', created_at: null, updated_at: null },
                { id: 'r2', cache_key: 'k:2', response_status: 429, request_method: 'get', created_at: null, updated_at: null },
            ],
            hasMore: false, count: 2, nextCursor: null, total: 2,
        });
        render(<RowBrowser table={CACHE} />);
        expect(await screen.findByText('200')).toHaveAttribute('data-tone', 'success');
        expect(screen.getByText('429')).toHaveAttribute('data-tone', 'error');
    });
});
