import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { datatablesApi } from './datatablesApi';
import RowBrowser from './RowBrowser';

/**
 * Paging, which on a table two automations are writing to is not a detail.
 *
 * The cursor is KEYSET, not an offset: an offset both skips and repeats rows
 * between pages the moment somebody inserts one. That has always been true of
 * "Load more"; what is new is going BACK, which an offset would have made
 * trivial and a keyset cursor cannot — you cannot subtract from a token. So
 * the browser keeps a `cursorStack`: the token each visited page STARTED at.
 * Going back re-asks the server with the token it already used, which is the
 * only way to land on the same window twice.
 *
 * The two controls answer different questions and both stay:
 *   "Load more" grows the window you are reading (and is what the keyset
 *   append test in RowBrowser.test.jsx pins);
 *   ‹ › move the window a page at a time.
 */

vi.mock('./datatablesApi', () => {
    const datatablesApi = {
        getSchema: vi.fn(), listRows: vi.fn(), getRow: vi.fn(), addRow: vi.fn(),
        updateRow: vi.fn(), deleteRow: vi.fn(), bulkImport: vi.fn(), bulkDeleteRows: vi.fn(),
        exportCsv: vi.fn(),
    };
    return { datatablesApi, default: datatablesApi };
});

const TABLE = { id: 'tbl_1', key: 'customers', name: 'Customers', grade: 'owner', rowCount: 120 };
const COLUMNS = [{ key: 'email', name: 'E-mail', type: 'text' }];

const row = (n) => ({
    id: `rec_${n}`, email: `p${n}@b.c`,
    created_at: '2026-03-01T10:00:00.000Z', updated_at: '2026-03-01T10:00:00.000Z',
});

/** Answers the page that belongs to a cursor, so order of calls cannot fake it. */
function serveByCursor(pages) {
    datatablesApi.listRows.mockImplementation(async (_id, opts) => pages[String(opts.cursor ?? 'first')]);
}

beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    datatablesApi.getSchema.mockResolvedValue({ fields: COLUMNS, modelVersion: 1 });
});

describe('the ‹ › pager', () => {
    beforeEach(() => {
        serveByCursor({
            first: { rows: [row(1)], hasMore: true, count: 1, nextCursor: 'cur-1', total: 120 },
            'cur-1': { rows: [row(2)], hasMore: true, count: 1, nextCursor: 'cur-2', total: 120 },
            'cur-2': { rows: [row(3)], hasMore: false, count: 1, nextCursor: null, total: 120 },
        });
    });

    it('moves the window forward and REPLACES it — this is not "load more"', async () => {
        render(<RowBrowser table={TABLE} />);
        await screen.findByText('p1@b.c');

        fireEvent.click(screen.getByRole('button', { name: /Next page/i }));
        expect(await screen.findByText('p2@b.c')).toBeInTheDocument();
        // The previous page is GONE from the screen: a pager that appended
        // would be "load more" wearing a chevron.
        expect(screen.queryByText('p1@b.c')).toBeNull();
    });

    it('goes back with the cursor the page was ASKED for, never an offset', async () => {
        render(<RowBrowser table={TABLE} />);
        await screen.findByText('p1@b.c');
        fireEvent.click(screen.getByRole('button', { name: /Next page/i }));
        await screen.findByText('p2@b.c');
        fireEvent.click(screen.getByRole('button', { name: /Next page/i }));
        await screen.findByText('p3@b.c');

        fireEvent.click(screen.getByRole('button', { name: /Previous page/i }));
        expect(await screen.findByText('p2@b.c')).toBeInTheDocument();
        expect(datatablesApi.listRows).toHaveBeenLastCalledWith('tbl_1', expect.objectContaining({ cursor: 'cur-1' }));

        fireEvent.click(screen.getByRole('button', { name: /Previous page/i }));
        expect(await screen.findByText('p1@b.c')).toBeInTheDocument();
        // Page one has no token — asking for it with one would skip its first row.
        expect(datatablesApi.listRows).toHaveBeenLastCalledWith('tbl_1', expect.objectContaining({ cursor: null }));
    });

    it('says which page is on screen once it is no longer the first', async () => {
        render(<RowBrowser table={TABLE} />);
        // The right END of the table, because the sort is created_at DESC.
        expect(await screen.findByText(/the 1 most recent of 120/)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: /Next page/i }));
        // No invented "51–100": a keyset window has no offset to count from,
        // and a made-up range is worse than a page number.
        expect(await screen.findByText(/page 2 · 1 of 120/)).toBeInTheDocument();
    });

    it('Previous is dead on the first page and Next is dead on the last', async () => {
        render(<RowBrowser table={TABLE} />);
        await screen.findByText('p1@b.c');
        expect(screen.getByRole('button', { name: /Previous page/i }).disabled).toBe(true);

        fireEvent.click(screen.getByRole('button', { name: /Next page/i }));
        await screen.findByText('p2@b.c');
        fireEvent.click(screen.getByRole('button', { name: /Next page/i }));
        await screen.findByText('p3@b.c');
        await waitFor(() => expect(screen.getByRole('button', { name: /Next page/i }).disabled).toBe(true));
        expect(screen.getByRole('button', { name: /Previous page/i }).disabled).toBe(false);
    });

    it('a new question starts at page one — the old cursor would skip its first rows', async () => {
        render(<RowBrowser table={TABLE} />);
        await screen.findByText('p1@b.c');
        fireEvent.click(screen.getByRole('button', { name: /Next page/i }));
        await screen.findByText('p2@b.c');

        // Sorting is a different question, so the window must not stay where
        // the previous one had wandered to.
        fireEvent.click(screen.getByRole('button', { name: /Sort by E-mail/i }));
        await waitFor(() => expect(datatablesApi.listRows).toHaveBeenLastCalledWith('tbl_1',
            expect.objectContaining({ cursor: null, sort: 'email' })));
    });

    it('a search also starts at page one', async () => {
        render(<RowBrowser table={TABLE} />);
        await screen.findByText('p1@b.c');
        fireEvent.click(screen.getByRole('button', { name: /Next page/i }));
        await screen.findByText('p2@b.c');

        const box = screen.getByLabelText(/Search the rows/i);
        fireEvent.change(box, { target: { value: 'anna' } });
        fireEvent.submit(box.closest('form'));
        await waitFor(() => expect(datatablesApi.listRows).toHaveBeenLastCalledWith('tbl_1',
            expect.objectContaining({ cursor: null, q: 'anna' })));
    });
});

describe('"Load more" beside the pager', () => {
    it('grows the current window instead of moving it, and the pager carries on from the end', async () => {
        serveByCursor({
            first: { rows: [row(1)], hasMore: true, count: 1, nextCursor: 'cur-1', total: 120 },
            'cur-1': { rows: [row(2)], hasMore: true, count: 1, nextCursor: 'cur-2', total: 120 },
            'cur-2': { rows: [row(3)], hasMore: false, count: 1, nextCursor: null, total: 120 },
        });
        render(<RowBrowser table={TABLE} />);
        await screen.findByText('p1@b.c');

        fireEvent.click(screen.getByRole('button', { name: /Load more/i }));
        expect(await screen.findByText('p2@b.c')).toBeInTheDocument();
        // Both on screen — the grown window.
        expect(screen.getByText('p1@b.c')).toBeInTheDocument();

        // And "next page" now starts after everything shown, not after page one.
        fireEvent.click(screen.getByRole('button', { name: /Next page/i }));
        await waitFor(() => expect(datatablesApi.listRows).toHaveBeenLastCalledWith('tbl_1',
            expect.objectContaining({ cursor: 'cur-2' })));
        expect(await screen.findByText('p3@b.c')).toBeInTheDocument();
        expect(screen.queryByText('p1@b.c')).toBeNull();
    });

    it('is not offered when there is nothing after the current window', async () => {
        serveByCursor({ first: { rows: [row(1)], hasMore: false, count: 1, nextCursor: null, total: 1 } });
        render(<RowBrowser table={TABLE} />);
        await screen.findByText('p1@b.c');
        expect(screen.queryByRole('button', { name: /Load more/i })).toBeNull();
        expect(screen.getByRole('button', { name: /Next page/i }).disabled).toBe(true);
    });
});
