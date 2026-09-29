import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DatatableDetail from './DatatableDetail';
import { datatablesApi } from './datatablesApi';

/**
 * The retention tab, which is the only control in this section that DELETES
 * rows without anybody pressing delete.
 *
 * Three rules it must not break, and each is a thing the server also
 * enforces — so a surface that got any of them wrong would be a control whose
 * only feedback is a 400:
 *
 *  1. The WINDOW and the COLUMN travel together. `PATCH /:id` refuses a
 *     non-null `retentionDays` with no `retentionField`
 *     (`retention_field_required`), because a window that silently inherits a
 *     default is one submission away from deleting on a rule nobody chose.
 *  2. On a managed table the column is NOT the author's: http_cache stamps
 *     `fetched_at`, and that is the only date the sweep reads.
 *  3. "What is about to expire" is COUNTED. The rows route answers `total` as
 *     the table's row count, not the filtered one, so a filtered `total`
 *     would report the whole table as expiring.
 */

vi.mock('./datatablesApi', () => {
    const datatablesApi = {
        list: vi.fn(), get: vi.fn(), remove: vi.fn(), update: vi.fn(),
        getSchema: vi.fn(), putSchema: vi.fn(),
        listRows: vi.fn(), addRow: vi.fn(), deleteRow: vi.fn(), exportCsv: vi.fn(),
        listGrants: vi.fn(), addGrant: vi.fn(), removeGrant: vi.fn(), setSharing: vi.fn(),
        listUsage: vi.fn(), health: vi.fn(), repair: vi.fn(),
    };
    return { datatablesApi, default: datatablesApi };
});

const COLUMNS = [
    { key: 'email', name: 'E-mail', type: 'text' },
    { key: 'signed_at', name: 'Signed on', type: 'datetime' },
    { key: 'seen_at', name: 'Last seen', type: 'date' },
];

const TABLE = {
    id: 'tbl_1', name: 'Customers', key: 'customers', description: 'People we e-mailed.',
    rowCount: 412, isPublished: false, sharedGroups: [], writeMode: 'grants',
    scopeKind: 'org', managedKind: null, grade: 'owner',
    retentionDays: null, retentionField: null, lastRetentionAt: null,
};

function renderDetail(table = TABLE) {
    return render(
        <DatatableDetail
            table={table}
            canManage
            currentUserId="u1"
            onBack={() => {}}
            onChanged={() => {}}
            onDeleted={() => {}}
        />,
    );
}

async function openRetention(table) {
    renderDetail(table);
    fireEvent.click(await screen.findByRole('radio', { name: /retention/i }));
    return screen.findByLabelText(/Date column the age is measured from/i);
}

beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    datatablesApi.getSchema.mockResolvedValue({ fields: COLUMNS, modelVersion: 3 });
    datatablesApi.listRows.mockResolvedValue({ rows: [], hasMore: false, count: 0, nextCursor: null, total: 412 });
    datatablesApi.listUsage.mockResolvedValue({ usage: [] });
    datatablesApi.update.mockResolvedValue({ datatable: TABLE });
});

describe('the window and the date column travel together', () => {
    it('sends BOTH halves when a preset is picked', async () => {
        await openRetention();
        fireEvent.click(screen.getByRole('radio', { name: /30 days/ }));
        await waitFor(() => expect(datatablesApi.update).toHaveBeenCalled());
        expect(datatablesApi.update).toHaveBeenCalledWith('tbl_1', {
            retentionDays: 30, retentionField: 'signed_at',
        });
    });

    it('re-saves with the new column when the column alone is changed', async () => {
        await openRetention({ ...TABLE, retentionDays: 30, retentionField: 'signed_at' });
        fireEvent.change(screen.getByLabelText(/Date column the age is measured from/i), { target: { value: 'seen_at' } });
        await waitFor(() => expect(datatablesApi.update).toHaveBeenCalledWith('tbl_1', {
            retentionDays: 30, retentionField: 'seen_at',
        }));
    });

    it('turning it off sends only the null window — there is no column to name', async () => {
        await openRetention({ ...TABLE, retentionDays: 30, retentionField: 'signed_at' });
        fireEvent.click(screen.getByRole('radio', { name: /Never/ }));
        await waitFor(() => expect(datatablesApi.update).toHaveBeenCalledWith('tbl_1', { retentionDays: null }));
    });

    it('a custom number is only sent when it is applied, and it must be one', async () => {
        await openRetention();
        fireEvent.click(screen.getByRole('radio', { name: /Other/ }));
        const box = await screen.findByLabelText(/^Days$/i);
        expect(datatablesApi.update).not.toHaveBeenCalled();
        // Empty is not a window.
        expect(screen.getByRole('button', { name: /^Apply$/ }).disabled).toBe(true);
        fireEvent.change(box, { target: { value: '45' } });
        fireEvent.click(screen.getByRole('button', { name: /^Apply$/ }));
        await waitFor(() => expect(datatablesApi.update).toHaveBeenCalledWith('tbl_1', {
            retentionDays: 45, retentionField: 'signed_at',
        }));
    });

    it('explains the server refusal in words instead of showing the code', async () => {
        const err = Object.assign(new Error('nope'), { status: 400, code: 'retention_field_required' });
        datatablesApi.update.mockRejectedValue(err);
        await openRetention();
        fireEvent.click(screen.getByRole('radio', { name: /7 days/ }));
        expect(await screen.findByText(/Pick the date column the age is measured from/i)).toBeInTheDocument();
    });

    it('says so when the table has no date column to count from at all', async () => {
        datatablesApi.getSchema.mockResolvedValue({ fields: [{ key: 'email', name: 'E-mail', type: 'text' }], modelVersion: 3 });
        renderDetail();
        fireEvent.click(await screen.findByRole('radio', { name: /retention/i }));
        expect(await screen.findByText(/no date column yet/i)).toBeInTheDocument();
    });
});

describe('a managed table', () => {
    const CACHE = {
        ...TABLE, managedKind: 'http_cache', retentionDays: 30, retentionField: 'fetched_at',
    };

    it('does not let the author move the column the sweep counts from', async () => {
        datatablesApi.getSchema.mockResolvedValue({
            fields: [{ key: 'fetched_at', name: 'Fetched at', type: 'datetime' }], modelVersion: 3,
        });
        const picker = await openRetention(CACHE);
        expect(picker.disabled).toBe(true);
        expect(picker.value).toBe('fetched_at');
    });

    it('repeats what its rows hold, and that this window is the whole expiry story', async () => {
        await openRetention(CACHE);
        expect(screen.getByText(/plain text/i)).toBeInTheDocument();
        expect(screen.getByText(/no second, hidden clock/i)).toBeInTheDocument();
    });
});

describe('what is about to expire', () => {
    it('counts matching rows rather than reading the table-wide total', async () => {
        // `total` on the rows route is the TABLE's row count, filters or not.
        // Reading it would report all 412 rows as expiring this week.
        datatablesApi.listRows.mockResolvedValue({
            rows: Array.from({ length: 3 }, (_, i) => ({ id: `r${i}` })),
            hasMore: false, count: 3, nextCursor: null, total: 412,
        });
        await openRetention({ ...TABLE, retentionDays: 30, retentionField: 'signed_at' });
        const shown = await screen.findByText('3');
        expect(shown).toBeInTheDocument();
        expect(screen.getByText(/rows expire in the next 7 days/i)).toBeInTheDocument();
        // Not the table-wide count that rides in the same response.
        expect(shown.closest('section').textContent).not.toMatch(/412/);

        const call = datatablesApi.listRows.mock.calls.find(([, o]) => Array.isArray(o.filters) && o.filters.length);
        expect(call[1].filters[0].field).toBe('signed_at');
        expect(call[1].filters[0].op).toBe('lte');
    });

    it('says "n+" rather than a number it cannot stand behind', async () => {
        datatablesApi.listRows.mockResolvedValue({
            rows: Array.from({ length: 500 }, (_, i) => ({ id: `r${i}` })),
            hasMore: true, count: 500, nextCursor: 'c', total: 100000,
        });
        await openRetention({ ...TABLE, retentionDays: 30, retentionField: 'signed_at' });
        expect(await screen.findByText('500+')).toBeInTheDocument();
    });

    it('a failed count reads as "could not work it out", never as "nothing expires"', async () => {
        datatablesApi.listRows.mockRejectedValue(new Error('boom'));
        await openRetention({ ...TABLE, retentionDays: 30, retentionField: 'signed_at' });
        expect(await screen.findByText(/Could not work out what is about to expire/i)).toBeInTheDocument();
    });

    it('asks for nothing at all when no window is set', async () => {
        await openRetention();
        expect(await screen.findByText(/nothing expires on its own/i)).toBeInTheDocument();
        expect(datatablesApi.listRows.mock.calls.filter(([, o]) => o.filters?.length)).toHaveLength(0);
    });
});

describe('a viewer', () => {
    it('sees the rule and cannot change it', async () => {
        await openRetention({ ...TABLE, grade: 'viewer', retentionDays: 30, retentionField: 'signed_at' });
        expect(screen.getByRole('radio', { name: /7 days/ }).disabled).toBe(true);
        expect(screen.getByLabelText(/Date column the age is measured from/i).disabled).toBe(true);
        expect(screen.getByText(/30 days after their Signed on/)).toBeInTheDocument();
    });
});
