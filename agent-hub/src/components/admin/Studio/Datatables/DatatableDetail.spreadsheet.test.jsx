import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DatatableCard from './DatatableCard';
import DatatableDetail from './DatatableDetail';
import { datatablesApi } from './datatablesApi';
import RowBrowser from './RowBrowser';

/**
 * A SPREADSHEET mirror in the detail view — the second source kind on the
 * surface the Nextcloud mirror built. It opens on its Spreadsheet tab, has
 * no Retention tab, names its storage in every `{source}` sentence, shows
 * the file / write / identity cards, talks to the kind-agnostic
 * `/:id/source/*` methods (never the `*Nc` ones), deep-links to the file's
 * webUrl, unlinks with the file-flavoured notice, and — the half that has no
 * Nextcloud twin — a READ-ONLY file hides every write control, while a
 * `spreadsheet_conflict` keeps the draft on screen.
 *
 * The sibling suite (DatatableDetail.nextcloud.test.jsx) is the pin for the
 * Nextcloud kind and is untouched by this one; both must stay green.
 */

vi.mock('./datatablesApi', () => {
    const datatablesApi = {
        list: vi.fn(), get: vi.fn(), remove: vi.fn(), update: vi.fn(),
        getSchema: vi.fn(), putSchema: vi.fn(),
        listRows: vi.fn(), addRow: vi.fn(), updateRow: vi.fn(), deleteRow: vi.fn(), exportCsv: vi.fn(),
        listGrants: vi.fn(), addGrant: vi.fn(), removeGrant: vi.fn(), setSharing: vi.fn(),
        listUsage: vi.fn(), health: vi.fn(), repair: vi.fn(),
        // The Nextcloud methods exist on the mock so that a spreadsheet mirror
        // calling one of them is a FAILED assertion, not a TypeError.
        pulseNc: vi.fn(), refreshNc: vi.fn(), setNcRelations: vi.fn(), updateNc: vi.fn(), relinkNc: vi.fn(),
        getSource: vi.fn(), pulseSource: vi.fn(), refreshSource: vi.fn(), updateSource: vi.fn(),
        setSourceRelations: vi.fn(), relinkSource: vi.fn(),
    };
    return { datatablesApi, default: datatablesApi };
});

const FIELDS = [
    { id: 'fld_ss9b1d7e2a4cdat', key: 'datum', name: 'Datum', type: 'date' },
    { id: 'fld_ss2a2b2c2d2etxt', key: 'leverancier', name: 'Leverancier', type: 'text' },
    { id: 'fld_ss3f9a2c1b0etxt', key: 'factuurnummer', name: 'Factuurnummer', type: 'text', required: true },
    { id: 'fld_ss4d4e4f4a4bnum', key: 'totaal', name: 'Totaal', type: 'number' },
    { id: 'fld_ssrel1a2b3c4d5e', key: 'leveranciers_ref', name: 'Leveranciers row', type: 'relation', derived: true, relation: { table: 'tbl_lev', fk: false } },
];
const SOURCE = {
    kind: 'spreadsheet_file', provider: 'google_drive', format: 'gsheet',
    fileId: 'f1', fileName: 'Facturen 2026', path: null, webUrl: 'https://docs.google.com/spreadsheets/d/f1',
    sheet: 'Facturen', headerRow: 1,
    keyColumn: { col: 2, header: 'Factuurnummer', fieldId: 'fld_ss3f9a2c1b0etxt' },
    owned: true, writable: true, writeMode: 'sheets_api', writeReason: null, writeCaveats: [],
    columns: [],
    linkedByUserId: 'u1', linkedAt: '2026-09-12T10:00:00Z', schedule: { everyMinutes: 1, live: true }, refreshOnView: true, rowCap: 10000,
    relations: [{ fieldId: 'fld_ssrel1a2b3c4d5e', kind: 'match', targetDatatableId: 'tbl_lev', localFieldId: 'fld_ss2a2b2c2d2etxt', targetFieldId: 'fld_nc20txt' }],
};
const SYNC = {
    status: 'ok', lastSuccessAt: '2026-09-12T10:05:00Z', lastSyncAt: '2026-09-12T10:05:00Z', nextRunAt: '2099-01-01T00:00:00Z',
    rowCount: 2, truncated: false, sourceModifiedAt: '2026-09-12T09:59:00Z', lastFetchAt: '2026-09-12T10:05:00Z',
};
const TABLE = {
    id: 'tbl_ss', name: 'Facturen 2026', key: 'facturen_2026', description: 'A copy of a sheet.',
    rowCount: 2, isPublished: false, sharedGroups: [], writeMode: 'grants',
    scopeKind: 'org', managedKind: 'spreadsheet_file', grade: 'owner',
    retentionDays: null, retentionField: null, source: SOURCE, sync: SYNC,
};
// The file the server could not write: an .xls in a Nextcloud folder.
const READONLY_SOURCE = {
    ...SOURCE, provider: 'nextcloud_files', format: 'xls', fileName: 'oud.xls', path: '/Documents/oud.xls', webUrl: null,
    keyColumn: null, writable: false, writeMode: 'none', writeReason: 'xls',
};
const READONLY_TABLE = { ...TABLE, id: 'tbl_ro', name: 'Oud', source: READONLY_SOURCE };

function renderDetail(table = TABLE) {
    return render(<DatatableDetail table={table} canManage currentUserId="u1" onBack={() => {}} onChanged={() => {}} onDeleted={() => {}} />);
}

beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    datatablesApi.get.mockImplementation(async (id) => ({ datatable: id === 'tbl_ro' ? READONLY_TABLE : TABLE }));
    datatablesApi.getSchema.mockResolvedValue({ fields: FIELDS, modelVersion: 3 });
    datatablesApi.listRows.mockResolvedValue({ rows: [], hasMore: false, count: 0 });
    datatablesApi.listUsage.mockResolvedValue({ usage: [] });
    datatablesApi.listGrants.mockResolvedValue({ grants: [] });
    // A Nextcloud mirror sits beside it in the same scope: a cross-kind
    // relation target, and the proof that "siblings" means every mirror.
    datatablesApi.list.mockResolvedValue({ datatables: [TABLE, { id: 'tbl_lev', name: 'Leveranciers', managedKind: 'nextcloud_table', scopeKind: 'org', grade: 'owner' }] });
    datatablesApi.refreshSource.mockResolvedValue({ ok: true, sync: { ...SYNC, lastSuccessAt: '2026-09-12T11:00:00Z' }, warnings: [] });
    datatablesApi.pulseSource.mockResolvedValue({ dataVersion: 3, rowCount: 2, sync: SYNC });
    datatablesApi.setSourceRelations.mockResolvedValue({ datatable: TABLE });
    datatablesApi.relinkSource.mockResolvedValue({ datatable: TABLE });
});

describe('a spreadsheet mirror in the detail view', () => {
    it('opens on the Spreadsheet tab, has no Retention tab, and names the storage in the status', async () => {
        renderDetail();
        expect(await screen.findByRole('radio', { name: /Spreadsheet/ })).toHaveAttribute('aria-checked', 'true');
        expect(screen.queryByRole('radio', { name: /Retention/ })).toBeNull();
        expect(screen.queryByRole('radio', { name: /Nextcloud/ })).toBeNull();
        await waitFor(() => expect(datatablesApi.get).toHaveBeenCalledWith('tbl_ss'));
        expect(await screen.findByText(/Live · in step with Google Drive/)).toBeInTheDocument();
        expect(screen.getByText(/Only the file’s version is checked/)).toBeInTheDocument();
    });

    it('shows the file, write and identity cards with the file’s own facts', async () => {
        renderDetail();
        await screen.findByText(/Live · in step with Google Drive/);
        expect(screen.getByRole('link', { name: /Facturen 2026/ })).toHaveAttribute('href', 'https://docs.google.com/spreadsheets/d/f1');
        expect(screen.getByText(/Sheet: Facturen/)).toBeInTheDocument();
        expect(screen.getByText(/Header row: 1/)).toBeInTheDocument();
        expect(screen.getByText(/File last changed/)).toBeInTheDocument();
        expect(screen.getByText(/Changes go both ways/)).toBeInTheDocument();
        expect(screen.getByText(/cell by cell/)).toBeInTheDocument();
        expect(screen.getByText(/recognised by its Factuurnummer/)).toBeInTheDocument();
        expect(screen.getByText(/Google Drive is read and written as the account/)).toBeInTheDocument();
    });

    it('"Refresh now" and "Re-read the columns" call the kind-agnostic endpoints, never the Nextcloud ones', async () => {
        renderDetail();
        fireEvent.click(await screen.findByRole('button', { name: /Refresh now/ }));
        await waitFor(() => expect(datatablesApi.refreshSource).toHaveBeenCalledWith('tbl_ss'));
        fireEvent.click(screen.getByRole('button', { name: /Re-read the columns/ }));
        await waitFor(() => expect(datatablesApi.relinkSource).toHaveBeenCalledWith('tbl_ss', null));
        expect(await screen.findByText(/were re-read/)).toBeInTheDocument();
        expect(datatablesApi.refreshNc).not.toHaveBeenCalled();
        expect(datatablesApi.relinkNc).not.toHaveBeenCalled();
    });

    it('lists the declared relation, offers the Nextcloud mirror as a target, and saves on remove', async () => {
        renderDetail();
        expect(await screen.findByText(/Leveranciers row → Leveranciers/)).toBeInTheDocument();
        const target = await screen.findByRole('combobox', { name: /Other table/ });
        expect(Array.from(target.options).map(o => o.textContent)).toContain('Leveranciers');
        fireEvent.click(screen.getByRole('button', { name: /Remove this relation/ }));
        await waitFor(() => expect(datatablesApi.setSourceRelations).toHaveBeenCalledWith('tbl_ss', []));
        expect(datatablesApi.setNcRelations).not.toHaveBeenCalled();
    });

    it('locks every column, names the storage, and marks the key column', async () => {
        renderDetail();
        fireEvent.click(await screen.findByRole('radio', { name: /Columns/ }));
        expect(await screen.findByText(/These columns come from Google Drive/)).toBeInTheDocument();
        expect(screen.getByText(/the key column that identifies a row/)).toBeInTheDocument();
        expect(screen.getAllByText(/from Google Drive/).length).toBeGreaterThan(1);
        expect(screen.queryByRole('button', { name: /Add a column/ })).toBeNull();
        expect(screen.queryByRole('button', { name: /Save columns/ })).toBeNull();
        expect(datatablesApi.putSchema).not.toHaveBeenCalled();
    });

    it('the ⋯ menu opens the file, and the danger zone unlinks in the file’s words', async () => {
        renderDetail();
        await screen.findByText(/Live · in step with Google Drive/);
        fireEvent.click(screen.getByRole('button', { name: /More about this table/ }));
        const link = await screen.findByRole('menuitem', { name: /Open in Google Drive/ });
        expect(link).toHaveAttribute('href', 'https://docs.google.com/spreadsheets/d/f1');
        fireEvent.click(await screen.findByRole('menuitem', { name: /Unlink this table/ }));
        expect(await screen.findByText(/Unlink “Facturen 2026” from this workspace\?/)).toBeInTheDocument();
        expect(screen.getByText(/The file in Google Drive, and every row in it, stays exactly as it is/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /^Unlink$/ })).toBeInTheDocument();
        expect(screen.queryByText(/Delete for good/)).toBeNull();
    });
});

describe('where "Open in {source}" opens, inside the Nextcloud frame', () => {
    // The ExApp iframe: window.top is somebody else. `_top` there navigates
    // the HOST — right for a page Nextcloud itself serves, wrong for another
    // site, which would replace the whole Nextcloud tab.
    const NC_FILE_SOURCE = { ...SOURCE, provider: 'nextcloud_files', format: 'xlsx', fileName: 'Facturen.xlsx', path: '/Documents/Facturen.xlsx', webUrl: 'http://nc/f/4711', writeMode: 'exceljs_put' };
    const NC_FILE_TABLE = { ...TABLE, id: 'tbl_ncf', source: NC_FILE_SOURCE };

    async function openMenuLink(table, name) {
        renderDetail(table);
        await screen.findByText(/Live · in step with/);
        fireEvent.click(screen.getByRole('button', { name: /More about this table/ }));
        return screen.findByRole('menuitem', { name });
    }

    it('a Google Drive file opens in a NEW tab even when embedded — never _top', async () => {
        const top = vi.spyOn(window, 'top', 'get').mockReturnValue({});
        try {
            const link = await openMenuLink(TABLE, /Open in Google Drive/);
            expect(link).toHaveAttribute('href', 'https://docs.google.com/spreadsheets/d/f1');
            expect(link).toHaveAttribute('target', '_blank');
            expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
        } finally { top.mockRestore(); }
    });

    it('a file in Nextcloud Files takes the host there — it is Nextcloud\'s own page', async () => {
        datatablesApi.get.mockImplementation(async () => ({ datatable: NC_FILE_TABLE }));
        const top = vi.spyOn(window, 'top', 'get').mockReturnValue({});
        try {
            const link = await openMenuLink(NC_FILE_TABLE, /Open in Nextcloud/);
            expect(link).toHaveAttribute('href', 'http://nc/f/4711');
            expect(link).toHaveAttribute('target', '_top');
        } finally { top.mockRestore(); }
    });

    it('standalone (no frame) everything is a new tab', async () => {
        const link = await openMenuLink(TABLE, /Open in Google Drive/);
        expect(link).toHaveAttribute('target', '_blank');
    });
});

describe('a spreadsheet mirror is live while watched', () => {
    it('pulses /source/pulse while the rows tab is open and reloads the rows only when the version moved', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
            let version = 3;
            datatablesApi.pulseSource.mockImplementation(async () => ({ dataVersion: version, rowCount: 2, sync: SYNC }));
            renderDetail();
            fireEvent.click(await screen.findByRole('radio', { name: /Rows/ }));
            await waitFor(() => expect(datatablesApi.pulseSource).toHaveBeenCalledTimes(1));
            const loads = datatablesApi.listRows.mock.calls.length;
            await vi.advanceTimersByTimeAsync(5100);
            await waitFor(() => expect(datatablesApi.pulseSource).toHaveBeenCalledTimes(2));
            expect(datatablesApi.listRows.mock.calls.length).toBe(loads);   // same version: no reload
            version = 4;
            await vi.advanceTimersByTimeAsync(5100);
            await waitFor(() => expect(datatablesApi.listRows.mock.calls.length).toBeGreaterThan(loads));
            expect((await screen.findAllByText(/Live · in step with Google Drive/)).length).toBeGreaterThan(0);
            expect(datatablesApi.pulseNc).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('stops pulsing once the Columns tab is open', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
            renderDetail();                                   // opens on the Spreadsheet tab, which watches
            await waitFor(() => expect(datatablesApi.pulseSource).toHaveBeenCalledTimes(1));
            fireEvent.click(await screen.findByRole('radio', { name: /Columns/ }));
            await screen.findByText(/These columns come from Google Drive/);
            await vi.advanceTimersByTimeAsync(11_000);
            expect(datatablesApi.pulseSource).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('a read-only file', () => {
    const rows = [
        { id: 'r2', datum: '2026-01-05', leverancier: 'Acme', factuurnummer: 'F-1', totaal: 121, leveranciers_ref: null, updated_at: '2026-09-12T10:00:00Z', created_at: '2026-09-12T09:00:00Z' },
    ];

    it('hides every write control on the rows tab and says so in the strip', async () => {
        datatablesApi.listRows.mockResolvedValue({ rows, hasMore: false, count: 1 });
        renderDetail(READONLY_TABLE);
        await screen.findByText(/Live · in step with Nextcloud/);
        expect(screen.getByText(/Rows are read from the file/)).toBeInTheDocument();
        expect(screen.getByText(/Save it as .xlsx to write rows back/)).toBeInTheDocument();
        expect(screen.getByText(/recognised by its row number/)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('radio', { name: /Rows/ }));
        expect(await screen.findByText(/cannot be changed here/)).toBeInTheDocument();
        await screen.findByText('Acme');
        expect(screen.queryByRole('button', { name: /Add a row/ })).toBeNull();
        expect(screen.queryByRole('button', { name: /Edit this row/ })).toBeNull();
        expect(screen.queryByRole('button', { name: /Delete this row/ })).toBeNull();
        expect(screen.queryByRole('button', { name: /^Import$/ })).toBeNull();
    });

    it('is not offered as a writable card either: the list card names the storage', () => {
        render(<ul><DatatableCard t={(k, en, p) => (p ? en.replace('{source}', p.source) : en)} table={READONLY_TABLE} onOpen={() => {}} /></ul>);
        expect(screen.getByText('from Nextcloud')).toBeInTheDocument();
        render(<ul><DatatableCard t={(k, en, p) => (p ? en.replace('{source}', p.source) : en)} table={TABLE} onOpen={() => {}} /></ul>);
        expect(screen.getByText('from Google Drive')).toBeInTheDocument();
    });
});

describe('the rows of a spreadsheet mirror', () => {
    const mirror = { source: SOURCE, sync: SYNC, refreshNow: vi.fn(), update: vi.fn(), setRelations: vi.fn(), reload: vi.fn() };
    const rows = [
        { id: 'F-1', datum: '2026-01-05', leverancier: 'Acme', factuurnummer: 'F-1', totaal: 121, leveranciers_ref: '40', updated_at: '2026-09-12T10:00:00Z', created_at: '2026-09-12T09:00:00Z' },
    ];

    it('a spreadsheet_conflict keeps the row in edit with its draft, in the file’s words', async () => {
        datatablesApi.listRows.mockResolvedValue({ rows, hasMore: false, count: 1 });
        datatablesApi.updateRow.mockRejectedValue(Object.assign(new Error('version moved'), { status: 409, code: 'spreadsheet_conflict' }));
        render(<RowBrowser table={TABLE} mirror={mirror} onChanged={() => {}} />);
        fireEvent.click((await screen.findAllByRole('button', { name: /Edit this row/ }))[0]);
        fireEvent.click(screen.getByRole('button', { name: /Save this row/ }));
        expect(await screen.findByText(/The file changed while this row was being written/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Save this row/ })).toBeInTheDocument();   // still editing
    });

    it('the add form says which storage a column is required in', async () => {
        datatablesApi.listRows.mockResolvedValue({ rows, hasMore: false, count: 1 });
        render(<RowBrowser table={TABLE} mirror={mirror} onChanged={() => {}} />);
        fireEvent.click(await screen.findByRole('button', { name: /Add a row/ }));
        expect(await screen.findByText(/required in Google Drive/)).toBeInTheDocument();
    });
});
