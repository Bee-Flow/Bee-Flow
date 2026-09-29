import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DatatableDetail from './DatatableDetail';
import { datatablesApi } from './datatablesApi';
import RowBrowser from './RowBrowser';

/**
 * A MIRRORED table in the detail view: opens on its Nextcloud tab, has no
 * Retention tab, its columns are locked, "Refresh now" and the schedule call
 * the right endpoints, the relations editor lists and saves, the ⋯ menu deep-
 * links into Nextcloud, and unlinking says "Unlink" — never "Delete for good".
 * Plus the RowBrowser half: relation cells show the linked row's LABEL, a
 * Nextcloud refusal is shown in Nextcloud's words and keeps the row in edit,
 * derived columns are not offered on the add form.
 */

vi.mock('./datatablesApi', () => {
    const datatablesApi = {
        list: vi.fn(), get: vi.fn(), remove: vi.fn(), update: vi.fn(),
        getSchema: vi.fn(), putSchema: vi.fn(),
        listRows: vi.fn(), addRow: vi.fn(), updateRow: vi.fn(), deleteRow: vi.fn(), exportCsv: vi.fn(),
        listGrants: vi.fn(), addGrant: vi.fn(), removeGrant: vi.fn(), setSharing: vi.fn(),
        listUsage: vi.fn(), health: vi.fn(), repair: vi.fn(),
        linkable: vi.fn(), describeNc: vi.fn(), linkNc: vi.fn(), getNc: vi.fn(),
        refreshNc: vi.fn(), setNcRelations: vi.fn(), updateNc: vi.fn(), relinkNc: vi.fn(), pulseNc: vi.fn(),
    };
    return { datatablesApi, default: datatablesApi };
});

const FIELDS = [
    { id: 'fld_nc2txt', key: 'leverancier', name: 'Leverancier', type: 'text' },
    { id: 'fld_nc6num', key: 'totaal', name: 'Totaal', type: 'number', required: true },
    { id: 'fld_ncrelabc', key: 'leveranciers_ref', name: 'Leveranciers row', type: 'relation', derived: true, relation: { table: 'tbl_lev', fk: false } },
];
const SOURCE = {
    kind: 'nextcloud_table', ncTableId: 4, ncViewId: null, ncTitle: 'Facturen', ncUrl: 'http://nc/apps/tables/#/table/4',
    linkedByUserId: 'u1', linkedAt: '2026-09-12T10:00:00Z', schedule: { everyMinutes: 15 }, refreshOnView: true, rowCap: 10000,
    relations: [{ fieldId: 'fld_ncrelabc', kind: 'match', targetDatatableId: 'tbl_lev', localFieldId: 'fld_nc2txt', targetFieldId: 'fld_nc20txt' }],
};
const SYNC = { status: 'ok', lastSuccessAt: '2026-09-12T10:05:00Z', lastSyncAt: '2026-09-12T10:05:00Z', nextRunAt: '2099-01-01T00:00:00Z', rowCount: 2, truncated: false };
const TABLE = {
    id: 'tbl_fac', name: 'Facturen', key: 'facturen', description: 'A copy of a Nextcloud table.',
    rowCount: 2, isPublished: false, sharedGroups: [], writeMode: 'grants',
    scopeKind: 'org', managedKind: 'nextcloud_table', grade: 'owner',
    retentionDays: null, retentionField: null, source: SOURCE, sync: SYNC,
};

function renderDetail(table = TABLE) {
    return render(<DatatableDetail table={table} canManage currentUserId="u1" onBack={() => {}} onChanged={() => {}} onDeleted={() => {}} />);
}

beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    datatablesApi.get.mockResolvedValue({ datatable: TABLE });
    datatablesApi.getSchema.mockResolvedValue({ fields: FIELDS, modelVersion: 3 });
    datatablesApi.listRows.mockResolvedValue({ rows: [], hasMore: false, count: 0 });
    datatablesApi.listUsage.mockResolvedValue({ usage: [] });
    datatablesApi.listGrants.mockResolvedValue({ grants: [] });
    datatablesApi.list.mockResolvedValue({ datatables: [TABLE, { id: 'tbl_lev', name: 'Leveranciers', managedKind: 'nextcloud_table', scopeKind: 'org', grade: 'owner' }] });
    datatablesApi.refreshNc.mockResolvedValue({ ok: true, sync: { ...SYNC, lastSuccessAt: '2026-09-12T11:00:00Z' }, warnings: [] });
    datatablesApi.pulseNc.mockResolvedValue({ dataVersion: 3, rowCount: 2, sync: SYNC });
    datatablesApi.setNcRelations.mockResolvedValue({ datatable: TABLE });
});

describe('a mirror in the detail view', () => {
    it('opens on the Nextcloud tab, has no Retention tab, and re-reads the mirror on open', async () => {
        renderDetail();
        expect(await screen.findByRole('radio', { name: /Nextcloud/ })).toHaveAttribute('aria-checked', 'true');
        expect(screen.queryByRole('radio', { name: /Retention/ })).toBeNull();
        await waitFor(() => expect(datatablesApi.get).toHaveBeenCalledWith('tbl_fac'));
        expect(await screen.findByText(/Live · in step with Nextcloud/)).toBeInTheDocument();
        expect(screen.getByText(/Changes go both ways/)).toBeInTheDocument();
    });

    it('"Refresh now" calls the refresh endpoint and reloads the rows; there is no schedule to set', async () => {
        renderDetail();
        fireEvent.click(await screen.findByRole('button', { name: /Refresh now/ }));
        await waitFor(() => expect(datatablesApi.refreshNc).toHaveBeenCalledWith('tbl_fac'));
        expect(screen.queryByRole('combobox', { name: /Refresh on a schedule/ })).toBeNull();
        expect(screen.queryByText(/Next scheduled refresh/)).toBeNull();
        expect(screen.getByText(/appear here within seconds while the table is open/)).toBeInTheDocument();
    });

    it('lists the declared relation, and saves the list on remove', async () => {
        renderDetail();
        expect(await screen.findByText(/Leveranciers row → Leveranciers/)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: /Remove this relation/ }));
        await waitFor(() => expect(datatablesApi.setNcRelations).toHaveBeenCalledWith('tbl_fac', []));
    });

    it('locks every column, names the source, and never offers Add a column or Save', async () => {
        renderDetail();
        fireEvent.click(await screen.findByRole('radio', { name: /Columns/ }));
        expect(await screen.findByText(/These columns come from Nextcloud/)).toBeInTheDocument();
        expect(screen.getAllByText(/from Nextcloud/).length).toBeGreaterThan(1);
        expect(screen.queryByRole('button', { name: /Add a column/ })).toBeNull();
        expect(screen.queryByRole('button', { name: /Save columns/ })).toBeNull();
        expect(screen.getByDisplayValue('Leverancier')).toBeDisabled();
        expect(datatablesApi.putSchema).not.toHaveBeenCalled();
    });

    it('the ⋯ menu deep-links into Nextcloud and the danger zone says Unlink', async () => {
        renderDetail();
        await screen.findByText(/Live · in step with Nextcloud/);
        fireEvent.click(screen.getByRole('button', { name: /More about this table/ }));
        const link = await screen.findByRole('menuitem', { name: /Open in Nextcloud/ });
        expect(link).toHaveAttribute('href', 'http://nc/apps/tables/#/table/4');
        fireEvent.click(await screen.findByRole('menuitem', { name: /Unlink this table/ }));
        expect(await screen.findByText(/Unlink “Facturen” from this workspace\?/)).toBeInTheDocument();
        expect(screen.getByText(/stays exactly as it is/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /^Unlink$/ })).toBeInTheDocument();
        expect(screen.queryByText(/Delete for good/)).toBeNull();
    });
});

describe('a mirror is live while watched', () => {
    it('pulses the server while the rows tab is open and reloads the rows only when the version moved', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
            let version = 3;
            datatablesApi.pulseNc.mockImplementation(async () => ({ dataVersion: version, rowCount: 2, sync: SYNC }));
            renderDetail();
            fireEvent.click(await screen.findByRole('radio', { name: /Rows/ }));
            await waitFor(() => expect(datatablesApi.pulseNc).toHaveBeenCalledTimes(1));
            const loads = datatablesApi.listRows.mock.calls.length;
            await vi.advanceTimersByTimeAsync(5100);
            await waitFor(() => expect(datatablesApi.pulseNc).toHaveBeenCalledTimes(2));
            expect(datatablesApi.listRows.mock.calls.length).toBe(loads);   // same version: no reload
            version = 4;
            await vi.advanceTimersByTimeAsync(5100);
            await waitFor(() => expect(datatablesApi.listRows.mock.calls.length).toBeGreaterThan(loads));
            expect((await screen.findAllByText(/Live · in step with Nextcloud/)).length).toBeGreaterThan(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it('stops pulsing once the Columns tab is open', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
            renderDetail();                                   // opens on the Nextcloud tab, which watches
            await waitFor(() => expect(datatablesApi.pulseNc).toHaveBeenCalledTimes(1));
            fireEvent.click(await screen.findByRole('radio', { name: /Columns/ }));
            await screen.findByText(/These columns come from Nextcloud/);
            await vi.advanceTimersByTimeAsync(11_000);
            expect(datatablesApi.pulseNc).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('the rows of a mirror', () => {
    const mirror = { source: SOURCE, sync: SYNC, refreshNow: vi.fn(), update: vi.fn(), setRelations: vi.fn(), reload: vi.fn() };
    const rows = [
        { id: '1', leverancier: 'Acme', totaal: 121, leveranciers_ref: '40', updated_at: '2026-09-12T10:00:00Z', created_at: '2026-09-12T09:00:00Z' },
        { id: '2', leverancier: 'Bee', totaal: 50, leveranciers_ref: null, updated_at: '2026-09-12T10:00:00Z', created_at: '2026-09-12T09:00:00Z' },
    ];

    it('shows a relation cell as the linked row\'s label, and a dash when there is no link', async () => {
        datatablesApi.listRows.mockResolvedValue({ rows, hasMore: false, count: 2 });
        render(<RowBrowser table={TABLE} mirror={mirror} onChanged={() => {}} />);
        const cells = await screen.findAllByTitle(/Filled in from another column/);
        expect(cells.length).toBe(1);
        expect(within(cells[0]).getByText('Acme')).toBeInTheDocument();
        expect(screen.getByText(/refreshed/)).toBeInTheDocument();   // the toolbar's "refreshed {when}"
    });

    it('a Nextcloud refusal is shown in Nextcloud\'s words and keeps the row in edit; the add form hides derived columns', async () => {
        datatablesApi.listRows.mockResolvedValue({ rows, hasMore: false, count: 2 });
        datatablesApi.updateRow.mockRejectedValue(Object.assign(new Error('Totaal: "abc" is not a number'), { status: 422, code: 'nextcloud_rejected' }));
        render(<RowBrowser table={TABLE} mirror={mirror} onChanged={() => {}} />);
        fireEvent.click((await screen.findAllByRole('button', { name: /Edit this row/ }))[0]);
        fireEvent.click(screen.getByRole('button', { name: /Save this row/ }));
        expect(await screen.findByText(/Nextcloud did not accept the row: Totaal/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Save this row/ })).toBeInTheDocument();   // still editing

        fireEvent.click(screen.getByRole('button', { name: /Add a row/ }));
        expect(await screen.findByText(/required in Nextcloud/)).toBeInTheDocument();
        // The grid header still names the derived column; the add FORM does not.
        const form = screen.getByRole('button', { name: /Add row/ }).closest('form');
        expect(within(form).queryByText('Leveranciers row')).toBeNull();
        expect(within(form).getByText(/Leverancier/)).toBeInTheDocument();
    });
});
