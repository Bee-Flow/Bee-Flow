import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { datatablesApi } from './datatablesApi';
import RowBrowser from './RowBrowser';

/**
 * The rows tab, which is where a person actually TOUCHES the data a routine
 * writes.
 *
 * What is worth pinning here is the typing, because every failure mode it had
 * was silent or opaque:
 *   - a multiselect was JSON-stringified as the literal string 'a, b';
 *   - an unticked checkbox never entered `values`, so the column was NULL and
 *     the grid rendered '—' where the person had said No;
 *   - a datetime was free text against a TIMESTAMPTZ column — an opaque 500;
 *   - deleting a row was ONE unconfirmed click, in a section that interposes a
 *     full dialog before a COLUMN is dropped.
 */

vi.mock('./datatablesApi', () => {
    const datatablesApi = {
        getSchema: vi.fn(), listRows: vi.fn(), getRow: vi.fn(), addRow: vi.fn(),
        updateRow: vi.fn(), deleteRow: vi.fn(), bulkImport: vi.fn(), exportCsv: vi.fn(),
    };
    return { datatablesApi, default: datatablesApi };
});

const TABLE = { id: 'tbl_1', key: 'customers', name: 'Customers', grade: 'owner', rowCount: 2 };

const COLUMNS = [
    { key: 'email', name: 'E-mail', type: 'text' },
    { key: 'tags', name: 'Tags', type: 'multiselect', options: ['vip', 'lead'] },
    { key: 'active', name: 'Active', type: 'bool' },
    { key: 'due', name: 'Due', type: 'datetime' },
    { key: 'stage', name: 'Stage', type: 'select', options: ['new', 'won'] },
];

const ROW = {
    id: 'rec_1', email: 'a@b.c', tags: '["vip"]', active: false,
    due: '2026-03-14T09:00', stage: 'new',
    created_at: '2026-03-01T10:00:00.000Z', updated_at: '2026-03-01T10:00:00.000Z',
};

beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    datatablesApi.getSchema.mockResolvedValue({ fields: COLUMNS, modelVersion: 1 });
    datatablesApi.listRows.mockResolvedValue({
        rows: [ROW], hasMore: false, count: 1, nextCursor: null, total: 1,
    });
    datatablesApi.addRow.mockResolvedValue({ ok: true, id: 'rec_2' });
    datatablesApi.updateRow.mockResolvedValue({ row: { ...ROW, updated_at: 'later' } });
    datatablesApi.deleteRow.mockResolvedValue({ ok: true });
});

async function renderRows(props = {}) {
    const out = render(<RowBrowser table={TABLE} {...props} />);
    await screen.findByText('a@b.c');
    return out;
}

describe('adding a row types every column', () => {
    it('saves a multiselect as an ARRAY, not the string a text box would produce', async () => {
        await renderRows();
        fireEvent.click(screen.getByRole('button', { name: /Add a row/i }));
        const group = await screen.findByRole('group', { name: 'Tags' });
        fireEvent.click(within(group).getAllByRole('checkbox')[0]);
        fireEvent.click(within(group).getAllByRole('checkbox')[1]);
        fireEvent.click(screen.getByRole('button', { name: 'Add row' }));

        await waitFor(() => expect(datatablesApi.addRow).toHaveBeenCalled());
        const [, values] = datatablesApi.addRow.mock.calls[0];
        // 'vip, lead' in a JSON column is a string that looks like data and is
        // not — every later filter on it misses.
        expect(values.tags).toEqual(['vip', 'lead']);
    });

    it('saves an unticked checkbox as false, not as a missing key', async () => {
        await renderRows();
        fireEvent.click(screen.getByRole('button', { name: /Add a row/i }));
        await screen.findByRole('button', { name: 'Add row' });
        fireEvent.click(screen.getByRole('button', { name: 'Add row' }));

        await waitFor(() => expect(datatablesApi.addRow).toHaveBeenCalled());
        const [, values] = datatablesApi.addRow.mock.calls[0];
        // A key that never enters `values` writes NULL, and the grid then shows
        // '—' where the person said No.
        expect(values.active).toBe(false);
    });

    it('gives a datetime column a datetime-local picker, never free text', async () => {
        await renderRows();
        fireEvent.click(screen.getByRole('button', { name: /Add a row/i }));
        const input = await screen.findByLabelText('Due');
        expect(input).toHaveAttribute('type', 'datetime-local');
        // And a choice column is a dropdown of its own options.
        expect(screen.getByLabelText('Stage').tagName).toBe('SELECT');
    });
});

describe('editing a row', () => {
    it('sends the updated_at it read, so a colleague is not silently overwritten', async () => {
        await renderRows();
        fireEvent.click(screen.getByRole('button', { name: 'Edit this row' }));
        const email = await screen.findByLabelText('E-mail');
        fireEvent.change(email, { target: { value: 'new@b.c' } });
        fireEvent.click(screen.getByRole('button', { name: 'Save this row' }));

        await waitFor(() => expect(datatablesApi.updateRow).toHaveBeenCalled());
        expect(datatablesApi.updateRow).toHaveBeenCalledWith(
            'tbl_1', 'rec_1', { email: 'new@b.c' }, ROW.updated_at,
        );
    });

    it('tells the person when someone else changed the row, instead of a bare failure', async () => {
        const conflict = Object.assign(new Error('Someone else changed this row'), { code: 'row_conflict', status: 409 });
        datatablesApi.updateRow.mockRejectedValue(conflict);
        await renderRows();
        fireEvent.click(screen.getByRole('button', { name: 'Edit this row' }));
        fireEvent.change(await screen.findByLabelText('E-mail'), { target: { value: 'x@y.z' } });
        fireEvent.click(screen.getByRole('button', { name: 'Save this row' }));

        expect(await screen.findByText(/had it open/i)).toBeInTheDocument();
    });
});

describe('deleting a row', () => {
    it('asks first, and does nothing until the answer is yes', async () => {
        await renderRows();
        fireEvent.click(screen.getByRole('button', { name: 'Delete this row' }));
        expect(await screen.findByText(/Delete this row\?/)).toBeInTheDocument();
        expect(datatablesApi.deleteRow).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole('button', { name: /Delete the row/i }));
        await waitFor(() => expect(datatablesApi.deleteRow).toHaveBeenCalledWith('tbl_1', 'rec_1'));
    });

    it('cancelling leaves the row alone', async () => {
        await renderRows();
        fireEvent.click(screen.getByRole('button', { name: 'Delete this row' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
        await waitFor(() => expect(screen.queryByText(/Delete this row\?/)).not.toBeInTheDocument());
        expect(datatablesApi.deleteRow).not.toHaveBeenCalled();
    });
});

describe('paging', () => {
    it('Load more APPENDS the next keyset page instead of replacing the first', async () => {
        datatablesApi.listRows
            .mockResolvedValueOnce({ rows: [ROW], hasMore: true, count: 1, nextCursor: 'cur-1', total: 2 })
            .mockResolvedValueOnce({
                rows: [{ ...ROW, id: 'rec_2', email: 'second@b.c' }],
                hasMore: false, count: 1, nextCursor: null, total: 2,
            });
        await renderRows();
        expect(screen.getByText(/the 1 most recent of 2/)).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: /Load more/i }));
        expect(await screen.findByText('second@b.c')).toBeInTheDocument();
        // Both pages on screen — a replace would look like paging and lose the
        // rows the person was already reading.
        expect(screen.getByText('a@b.c')).toBeInTheDocument();
        expect(datatablesApi.listRows).toHaveBeenLastCalledWith('tbl_1',
            expect.objectContaining({ cursor: 'cur-1' }));
    });

    it('names the RIGHT end of the table — the rows are newest first', async () => {
        datatablesApi.listRows.mockResolvedValue({
            rows: [ROW], hasMore: true, count: 1, nextCursor: 'c', total: 900,
        });
        await renderRows();
        expect(screen.getByText(/the 1 most recent of 900/)).toBeInTheDocument();
        expect(screen.queryByText(/first 50/)).not.toBeInTheDocument();
    });
});

describe('export', () => {
    it('builds a Blob and revokes it — never an <a href download> at the API', async () => {
        datatablesApi.exportCsv.mockResolvedValue('id,email\nrec_1,a@b.c\n');
        const createObjectURL = vi.fn(() => 'blob:fake');
        const revokeObjectURL = vi.fn();
        vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });
        try {
            await renderRows();
            fireEvent.click(screen.getByRole('button', { name: /Export CSV/i }));
            await waitFor(() => expect(createObjectURL).toHaveBeenCalled());
            // A link at the API carries no auth header, and on this stack a
            // same-origin download navigates the SPA away from itself.
            expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake');
            expect(document.querySelector('a[download]')).toBeNull();
        } finally {
            vi.unstubAllGlobals();
        }
    });
});

describe('import', () => {
    // Semicolons, because that is what a .csv saved on a Dutch machine holds.
    const EUROPEAN = 'E-mail;Active;Stage\nanna@example.com;ja;new\nbo@example.com;nee;won';
    const WITH_BAD_CHOICE = 'E-mail;Active;Stage\nanna@example.com;ja;new\nbo@example.com;nee;nope';

    it('reads a semicolon-delimited European paste and sends ONE bulk request', async () => {
        datatablesApi.bulkImport.mockResolvedValue({ inserted: 2, errors: [] });
        await renderRows();
        fireEvent.click(screen.getByRole('button', { name: /Import/i }));
        fireEvent.change(await screen.findByLabelText('Pasted rows'), { target: { value: EUROPEAN } });
        fireEvent.click(await screen.findByRole('button', { name: /Import 2 rows/i }));

        await waitFor(() => expect(datatablesApi.bulkImport).toHaveBeenCalledTimes(1));
        const [, rows] = datatablesApi.bulkImport.mock.calls[0];
        expect(rows[0].email).toBe('anna@example.com');
        // ja/nee are how a Dutch spreadsheet spells a yes/no column.
        expect(rows[0].active).toBe(true);
        expect(rows[1].active).toBe(false);
    });

    it('reports a value the column cannot hold BY LINE, and never sends that row', async () => {
        datatablesApi.bulkImport.mockResolvedValue({ inserted: 1, errors: [] });
        await renderRows();
        fireEvent.click(screen.getByRole('button', { name: /Import/i }));
        fireEvent.change(await screen.findByLabelText('Pasted rows'), { target: { value: WITH_BAD_CHOICE } });
        fireEvent.click(await screen.findByRole('button', { name: /Import 2 rows/i }));

        // 'nope' is not one of the Stage choices. Line 3, counting the header
        // as line 1 — the number the person is looking at in the spreadsheet.
        expect(await screen.findByText(/Line 3:/)).toBeInTheDocument();
        const [, rows] = datatablesApi.bulkImport.mock.calls[0];
        expect(rows).toHaveLength(1);
        expect(rows[0].email).toBe('anna@example.com');
    });
});

describe('a viewer', () => {
    it('sees the rows and none of the write controls', async () => {
        render(<RowBrowser table={{ ...TABLE, grade: 'viewer' }} />);
        await screen.findByText('a@b.c');
        expect(screen.queryByRole('button', { name: /Add a row/i })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Delete this row' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Edit this row' })).toBeNull();
        // Reading and exporting stay available — they are the same permission.
        expect(screen.getByRole('button', { name: /Export CSV/i })).toBeInTheDocument();
    });
});
