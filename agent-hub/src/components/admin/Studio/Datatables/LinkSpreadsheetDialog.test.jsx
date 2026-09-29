import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { datatablesApi } from './datatablesApi';
import LinkSpreadsheetDialog from './LinkSpreadsheetDialog';

/**
 * The link-spreadsheet wizard, end to end against a mocked API: browse →
 * folder → tick → describe → header row → type → key radio → names →
 * relations → review → the EXACT link body; and where each refusal sends
 * the person back to.
 *
 * Every describe is answered by ONE implementation keyed on its arguments,
 * so the test can say which call it expects (the file's, the sheet's at a
 * header row) rather than counting calls.
 */

vi.mock('./datatablesApi', () => {
    const datatablesApi = {
        browseSpreadsheets: vi.fn(), describeSpreadsheet: vi.fn(), linkSpreadsheets: vi.fn(),
    };
    return { datatablesApi, default: datatablesApi };
});

const PROVIDERS = [
    { provider: 'google_drive', connected: true },
    { provider: 'onedrive', connected: false, reason: 'needs_reauth' },
    { provider: 'nextcloud_files', connected: true },
];

const ROOT = {
    provider: 'google_drive', folder: { id: 'root', name: 'My Drive', path: [] },
    items: [
        { id: 'fin', name: 'Finance', kind: 'folder', modifiedAt: '2026-09-01T10:00:00Z' },
        { id: 'g1', name: 'Planning Q3', kind: 'file', format: 'gsheet', modifiedAt: '2026-09-10T10:00:00Z', webUrl: 'https://docs.google.com/spreadsheets/d/g1', owned: true, linkedAs: [{ datatableId: 'tbl_old', sheet: 'Blad2' }] },
    ],
    nextPageToken: null,
};
const FINANCE = {
    provider: 'google_drive', folder: { id: 'fin', name: 'Finance', path: [{ id: 'fin', name: 'Finance' }] },
    items: [
        { id: 'f1', name: 'Facturen 2026.xlsx', kind: 'file', format: 'xlsx', modifiedAt: '2026-09-12T10:00:00Z', owned: true },
        { id: 'f2', name: 'Leveranciers.csv', kind: 'file', format: 'csv', modifiedAt: '2026-09-12T10:00:00Z', owned: true },
    ],
    nextPageToken: null,
};

const col = (c, letter, header, key, type, extra = {}) => ({ col: c, letter, header, key, type, unique: false, blankHeader: false, duplicateHeader: false, formula: false, samples: [], ...extra });
const F1_COLUMNS = [
    col(0, 'A', 'Datum', 'datum', 'date', { samples: ['2026-01-02'] }),
    col(1, 'B', 'Leverancier', 'leverancier', 'text', { samples: ['Acme'] }),
    col(2, 'C', 'Factuurnummer', 'factuurnummer', 'text', { unique: true, samples: ['F-001'] }),
    col(3, 'D', 'Totaal', 'totaal', 'text', { samples: ['12,50'] }),
];
const describeF1 = (headerRow = 1) => ({
    provider: 'google_drive', fileId: 'f1', name: 'Facturen 2026.xlsx', format: 'xlsx', webUrl: null, owned: true,
    write: { mode: 'exceljs_put', reason: null, caveats: [] },
    sheets: [
        { name: 'Facturen', index: 0, rows: 20, cols: 4, hidden: false, linkedAs: [] },
        { name: 'Blad2', index: 1, rows: 3, cols: 2, hidden: false, linkedAs: ['tbl_old'] },
    ],
    sheet: {
        name: 'Facturen', headerRow,
        // At header row 2 the server sees the same headers (row 1 was a title) but infers differently.
        columns: headerRow === 1 ? F1_COLUMNS : F1_COLUMNS.map(c => ({ ...c, type: 'text' })),
        preview: { rows: [['Datum', 'Leverancier', 'Factuurnummer', 'Totaal'], ['2026-01-02', 'Acme', 'F-001', '12,50']] },
        rowCount: 20, truncated: false,
    },
    keyCandidates: [2], warnings: [],
});
// A csv's only sheet has NO name on the wire — `null`, as formats/index.js
// lists it and datatables.spreadsheet.integration.test.js pins it. A fixture
// that named it would hide every "Sheet: null" the wizard could print.
const DESCRIBE_F2 = {
    provider: 'google_drive', fileId: 'f2', name: 'Leveranciers.csv', format: 'csv', webUrl: null, owned: true,
    write: { mode: 'csv_put', reason: null, caveats: [] },
    sheets: [{ name: null, index: 0, rows: 5, cols: 2, hidden: false, linkedAs: [] }],
    sheet: {
        name: null, headerRow: 1,
        columns: [col(0, 'A', 'Leverancier', 'leverancier', 'text', { unique: true }), col(1, 'B', 'Land', 'land', 'text')],
        preview: { rows: [['Leverancier', 'Land'], ['Acme', 'NL']] }, rowCount: 5, truncated: false,
    },
    keyCandidates: [0], warnings: [],
};

const EXPECTED_F1_TABLE = {
    provider: 'google_drive', fileId: 'f1', sheet: 'Facturen', headerRow: 1, keyColumn: 2,
    columns: [
        { col: 0, header: 'Datum', type: 'date' }, { col: 1, header: 'Leverancier', type: 'text' },
        { col: 2, header: 'Factuurnummer', type: 'text' }, { col: 3, header: 'Totaal', type: 'number' },
    ],
    name: 'Facturen 2026', key: 'facturen_2026',
};

beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    datatablesApi.browseSpreadsheets.mockImplementation(async ({ folderId }) => (folderId === 'fin' ? FINANCE : ROOT));
    datatablesApi.describeSpreadsheet.mockImplementation(async ({ fileId, headerRow }) => (fileId === 'f2' ? DESCRIBE_F2 : describeF1(headerRow || 1)));
});

function open(props = {}) {
    const onLinked = vi.fn();
    render(<LinkSpreadsheetDialog scope="organisation" providers={PROVIDERS} onBack={() => {}} onClose={() => {}} onLinked={onLinked} {...props} />);
    return { onLinked };
}

const next = () => fireEvent.click(screen.getByRole('button', { name: /^Next$/ }));

/** Through the files step: into Finance, tick `names`. */
async function pickFiles(names) {
    fireEvent.click(await screen.findByRole('button', { name: /Finance/ }));
    for (const name of names) fireEvent.click(await screen.findByRole('checkbox', { name }));
    next();
}

/** Through the sheets step for Facturen 2026.xlsx: tick the sheet, wait for its columns. */
async function pickFacturenSheet() {
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Facturen — Facturen 2026.xlsx' }));
    return screen.findByRole('region', { name: 'Facturen — Facturen 2026.xlsx' });
}

describe('step 1 — files', () => {
    it('shows a tab per storage, says why one is off, and reads the root of the first connected one', async () => {
        open();
        expect(await screen.findByRole('tab', { name: /OneDrive/ })).toBeDisabled();
        expect(screen.getByText(/OneDrive connection has expired/)).toBeInTheDocument();
        await waitFor(() => expect(datatablesApi.browseSpreadsheets).toHaveBeenCalledWith(expect.objectContaining({ provider: 'google_drive', folderId: 'root', scope: 'organisation' })));
        // The Google Sheet wears the Sheets mark, and says a sheet of it is linked already — it stays tickable.
        expect(await screen.findByTestId('logo-google_sheets')).toBeInTheDocument();
        expect(screen.getByText('1 sheet linked')).toBeInTheDocument();
        expect(screen.getByRole('checkbox', { name: 'Planning Q3' })).not.toBeDisabled();
        expect(screen.getByRole('button', { name: /^Next$/ })).toBeDisabled();
    });

    it('a csv with a linked sheet cannot be ticked — it IS one sheet, so there is nothing left to link', async () => {
        datatablesApi.browseSpreadsheets.mockImplementation(async ({ folderId }) => (folderId === 'fin'
            ? { ...FINANCE, items: FINANCE.items.map(i => (i.id === 'f2' ? { ...i, linkedAs: [{ datatableId: 'tbl_old', sheet: null }] } : i)) }
            : ROOT));
        open();
        fireEvent.click(await screen.findByRole('button', { name: /Finance/ }));
        expect(await screen.findByRole('checkbox', { name: 'Leveranciers.csv' })).toBeDisabled();
        expect(screen.getByText('1 sheet linked')).toBeInTheDocument();
        // A workbook with a linked sheet stays tickable: another of its sheets may be free.
        expect(screen.getByRole('checkbox', { name: 'Facturen 2026.xlsx' })).not.toBeDisabled();
    });

    it('opens a folder, shows the path, and keeps a ticked file across folders', async () => {
        open();
        fireEvent.click(await screen.findByRole('button', { name: /Finance/ }));
        await waitFor(() => expect(datatablesApi.browseSpreadsheets).toHaveBeenCalledWith(expect.objectContaining({ folderId: 'fin' })));
        const nav = await screen.findByRole('navigation', { name: 'Folder path' });
        expect(within(nav).getByText('Finance')).toBeInTheDocument();
        fireEvent.click(await screen.findByRole('checkbox', { name: 'Facturen 2026.xlsx' }));
        expect(screen.getByText('1 file selected')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /^Next$/ })).not.toBeDisabled();
        // Back to the root: the file stays in the summary, and can be unticked from there.
        fireEvent.click(within(nav).getByRole('button', { name: 'All files' }));
        await screen.findByRole('checkbox', { name: 'Planning Q3' });
        expect(screen.getByText('1 file selected')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Unselect Facturen 2026.xlsx' }));
        expect(screen.queryByText('1 file selected')).toBeNull();
    });

    it('searches the root, debounced, and hides the shared toggle for Nextcloud', async () => {
        open();
        await screen.findByRole('checkbox', { name: 'Planning Q3' });
        expect(screen.getByRole('checkbox', { name: 'Shared with me' })).toBeInTheDocument();
        fireEvent.change(screen.getByRole('textbox', { name: 'Find a spreadsheet' }), { target: { value: 'fact' } });
        await waitFor(() => expect(datatablesApi.browseSpreadsheets).toHaveBeenCalledWith(expect.objectContaining({ folderId: 'root', q: 'fact' })), { timeout: 1500 });
        expect(await screen.findByText('Search results')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('tab', { name: /Nextcloud/ }));
        await waitFor(() => expect(datatablesApi.browseSpreadsheets).toHaveBeenCalledWith(expect.objectContaining({ provider: 'nextcloud_files', folderId: 'root' })));
        expect(screen.queryByRole('checkbox', { name: 'Shared with me' })).toBeNull();
    });
});

describe('step 2 — sheets & columns', () => {
    it('reads the file once, disables a linked sheet, and lets the columns be typed and a key chosen', async () => {
        open();
        await pickFiles(['Facturen 2026.xlsx']);
        await waitFor(() => expect(datatablesApi.describeSpreadsheet).toHaveBeenCalledWith({ provider: 'google_drive', fileId: 'f1', scope: 'organisation' }));
        expect(await screen.findByRole('checkbox', { name: 'Blad2 — Facturen 2026.xlsx' })).toBeDisabled();
        expect(screen.getByText(/charts, pivot tables and macros/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /^Next$/ })).toBeDisabled();
        const sec = await pickFacturenSheet();
        // The first sheet at header row 1 was seeded from the file's describe: one call so far.
        expect(datatablesApi.describeSpreadsheet).toHaveBeenCalledTimes(1);
        expect(within(sec).getAllByText('F-001', { exact: false }).length).toBeGreaterThan(0);     // preview + sample
        const totaal = within(sec).getByRole('combobox', { name: 'Type of Totaal' });
        expect(totaal).toHaveValue('text');
        fireEvent.change(totaal, { target: { value: 'number' } });
        expect(totaal).toHaveValue('number');
        // Only the unique text/number column may be the key; the others say why not.
        expect(within(sec).getByRole('radio', { name: 'Row number (default)' })).toBeChecked();
        expect(within(sec).getByRole('radio', { name: 'Factuurnummer' })).not.toBeDisabled();
        expect(within(sec).getByRole('radio', { name: 'Leverancier' })).toBeDisabled();
        expect(within(sec).getAllByText('values repeat').length).toBe(2);           // Leverancier, Totaal
        expect(within(sec).getByText('only text or number')).toBeInTheDocument();  // Datum
        fireEvent.click(within(sec).getByRole('radio', { name: 'Factuurnummer' }));
        expect(within(sec).getByRole('radio', { name: 'Factuurnummer' })).toBeChecked();
        expect(screen.getByRole('button', { name: /^Next$/ })).not.toBeDisabled();
        // Retyped to a date, the key column can no longer identify a row: back to the row number.
        fireEvent.change(within(sec).getByRole('combobox', { name: 'Type of Factuurnummer' }), { target: { value: 'date' } });
        expect(within(sec).getByRole('radio', { name: 'Factuurnummer' })).toBeDisabled();
        expect(within(sec).getByRole('radio', { name: 'Row number (default)' })).toBeChecked();
    });

    it('re-reads the sheet when the header row moves, keeping the types the person chose', async () => {
        open();
        await pickFiles(['Facturen 2026.xlsx']);
        const sec = await pickFacturenSheet();
        fireEvent.change(within(sec).getByRole('combobox', { name: 'Type of Totaal' }), { target: { value: 'number' } });
        fireEvent.click(within(sec).getByRole('button', { name: 'One row down' }));
        await waitFor(() => expect(datatablesApi.describeSpreadsheet).toHaveBeenCalledWith(
            { provider: 'google_drive', fileId: 'f1', sheet: 'Facturen', headerRow: 2, scope: 'organisation' },
        ), { timeout: 1500 });
        // The server now says text for every column: Datum follows it, Totaal keeps the person's number.
        await waitFor(() => expect(within(sec).getByRole('combobox', { name: 'Type of Datum' })).toHaveValue('text'));
        expect(within(sec).getByRole('combobox', { name: 'Type of Totaal' })).toHaveValue('number');
        expect(within(sec).getByRole('spinbutton', { name: 'Header row — Facturen' })).toHaveValue(2);
    });

    it('selects the only sheet of a csv by itself, names it after the file, and reads the file once', async () => {
        open();
        await pickFiles(['Leveranciers.csv']);
        // The unnamed sheet is called by the file's name — never "Sheet: null".
        expect(await screen.findByText('Sheet: Leveranciers.csv')).toBeInTheDocument();
        expect(screen.queryByText(/Sheet: null/)).toBeNull();
        await waitFor(() => expect(screen.getByRole('button', { name: /^Next$/ })).not.toBeDisabled());
        // The file's describe was seeded into the sheet cache under the null
        // sheet, so the selected sheet did not cost a second read.
        expect(datatablesApi.describeSpreadsheet).toHaveBeenCalledTimes(1);
        expect(datatablesApi.describeSpreadsheet).toHaveBeenCalledWith({ provider: 'google_drive', fileId: 'f2', scope: 'organisation' });
    });

    it('says when the only sheet is already linked, instead of a bare name and a Next that will not enable', async () => {
        datatablesApi.describeSpreadsheet.mockImplementation(async ({ fileId, headerRow }) => (fileId === 'f2'
            ? { ...DESCRIBE_F2, sheets: [{ ...DESCRIBE_F2.sheets[0], linkedAs: ['tbl_old'] }] }
            : describeF1(headerRow || 1)));
        open();
        await pickFiles(['Leveranciers.csv']);
        expect(await screen.findByText('Sheet: Leveranciers.csv')).toBeInTheDocument();
        expect(screen.getByText('already linked')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /^Next$/ })).toBeDisabled();
        // Nothing was selected on its behalf: the server would refuse it anyway.
        expect(screen.queryByRole('radio', { name: 'Row number (default)' })).toBeNull();
    });

    it('offers the shared-file write opt-in only when ownership is the ONE thing in the way', async () => {
        // A shared .ods: the format refuses before ownership is asked, so a tick
        // would change nothing — and would contradict the caveat printed above it.
        datatablesApi.describeSpreadsheet.mockImplementation(async ({ fileId, headerRow }) => (fileId === 'f2'
            ? { ...DESCRIBE_F2, format: 'ods', owned: false, write: { mode: 'none', reason: 'ods', caveats: [] } }
            : describeF1(headerRow || 1)));
        open();
        await pickFiles(['Leveranciers.csv']);
        expect(await screen.findByText(/\.ods\) is read here but not written/)).toBeInTheDocument();
        expect(screen.queryByRole('checkbox', { name: /Also write rows into this shared file/ })).toBeNull();
        cleanup();
        // A shared csv the storage could write: ownership is the only refusal, so the opt-in is offered.
        datatablesApi.describeSpreadsheet.mockImplementation(async ({ fileId, headerRow }) => (fileId === 'f2'
            ? { ...DESCRIBE_F2, owned: false, write: { mode: 'none', reason: 'not_owned', caveats: [] } }
            : describeF1(headerRow || 1)));
        open();
        await pickFiles(['Leveranciers.csv']);
        expect(await screen.findByRole('checkbox', { name: /Also write rows into this shared file/ })).not.toBeChecked();
        expect(screen.getByText(/belongs to someone else\. Rows are read here/)).toBeInTheDocument();
    });
});

describe('steps 3-5 — names, relations, review, link', () => {
    it('names the table after the file, reviews the key, and sends EXACTLY the contract body', async () => {
        datatablesApi.linkSpreadsheets.mockResolvedValue({ datatables: [{ id: 'tbl_new' }], warnings: [], partial: false });
        const { onLinked } = open();
        await pickFiles(['Facturen 2026.xlsx']);
        const sec = await pickFacturenSheet();
        fireEvent.change(within(sec).getByRole('combobox', { name: 'Type of Totaal' }), { target: { value: 'number' } });
        fireEvent.click(within(sec).getByRole('radio', { name: 'Factuurnummer' }));
        next();                                                                         // names
        expect(await screen.findByDisplayValue('Facturen 2026')).toBeInTheDocument();
        expect(screen.getByDisplayValue('facturen_2026')).toBeInTheDocument();
        expect(screen.getByText('recognised by Factuurnummer')).toBeInTheDocument();
        next();                                                                         // relations
        expect(await screen.findByText(/at least two sheets/)).toBeInTheDocument();
        next();                                                                         // review
        expect(await screen.findByText('key: Factuurnummer', { exact: false })).toBeInTheDocument();
        expect(screen.getByText(/belong to your organisation/)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Link the sheet' }));
        await waitFor(() => expect(datatablesApi.linkSpreadsheets).toHaveBeenCalled());
        expect(datatablesApi.linkSpreadsheets).toHaveBeenCalledWith({ scope: 'organisation', tables: [EXPECTED_F1_TABLE], relations: [] });
        await waitFor(() => expect(onLinked).toHaveBeenCalledWith(expect.objectContaining({ datatables: [{ id: 'tbl_new' }] })));
    });

    it('suggests a relation on a shared title and names both ends by sheet and column', async () => {
        datatablesApi.linkSpreadsheets.mockResolvedValue({ datatables: [], warnings: [], partial: false });
        open();
        await pickFiles(['Facturen 2026.xlsx', 'Leveranciers.csv']);
        await pickFacturenSheet();
        await waitFor(() => expect(screen.getByRole('button', { name: /^Next$/ })).not.toBeDisabled());
        next();                                                                         // names
        expect(await screen.findByDisplayValue('Leveranciers')).toBeInTheDocument();
        next();                                                                         // relations
        const suggestion = await screen.findByRole('checkbox', { name: /Facturen 2026 · Leverancier matches Leveranciers · Leverancier/ });
        fireEvent.click(suggestion);
        next();                                                                         // review
        // The csv is listed by its file alone ("file › null" would be a lie about a sheet).
        expect(await screen.findByText('Leveranciers.csv · row number')).toBeInTheDocument();
        expect(screen.getByText('Facturen 2026.xlsx › Facturen · row number')).toBeInTheDocument();
        fireEvent.click(await screen.findByRole('button', { name: 'Link 2 sheets' }));
        await waitFor(() => expect(datatablesApi.linkSpreadsheets).toHaveBeenCalled());
        const body = datatablesApi.linkSpreadsheets.mock.calls[0][0];
        // The csv selected itself the moment it was read, before the person ticked Facturen: selection order.
        expect(body.tables.map(x => x.key)).toEqual(['leveranciers', 'facturen_2026']);
        // The csv's sheet goes back as the null the server named it — in the table and in the relation end.
        expect(body.tables[0]).toMatchObject({ provider: 'google_drive', fileId: 'f2', sheet: null, headerRow: 1, keyColumn: null });
        expect(body.relations).toEqual([{
            from: { provider: 'google_drive', fileId: 'f1', sheet: 'Facturen', col: 1 },
            to: { provider: 'google_drive', fileId: 'f2', sheet: null, col: 0 },
        }]);
    });
});

describe('a relation outlives neither of its ends', () => {
    it('is dropped from the body when its sheet is unticked afterwards', async () => {
        datatablesApi.linkSpreadsheets.mockResolvedValue({ datatables: [], warnings: [], partial: false });
        open();
        await pickFiles(['Facturen 2026.xlsx', 'Leveranciers.csv']);
        await pickFacturenSheet();
        await waitFor(() => expect(screen.getByRole('button', { name: /^Next$/ })).not.toBeDisabled());
        next(); await screen.findByDisplayValue('Leveranciers');
        next();
        fireEvent.click(await screen.findByRole('checkbox', { name: /Facturen 2026 · Leverancier matches Leveranciers · Leverancier/ }));
        fireEvent.click(screen.getByRole('button', { name: /Back/ }));                       // names
        fireEvent.click(await screen.findByRole('button', { name: /Back/ }));                // sheets
        fireEvent.click(await screen.findByRole('checkbox', { name: 'Facturen — Facturen 2026.xlsx' }));   // untick
        next(); await screen.findByDisplayValue('Leveranciers');
        next(); expect(await screen.findByText(/at least two sheets/)).toBeInTheDocument();
        next();
        fireEvent.click(await screen.findByRole('button', { name: 'Link the sheet' }));
        await waitFor(() => expect(datatablesApi.linkSpreadsheets).toHaveBeenCalled());
        const body = datatablesApi.linkSpreadsheets.mock.calls[0][0];
        expect(body.tables.map(x => x.key)).toEqual(['leveranciers']);
        expect(body.relations).toEqual([]);
    });
});

describe('a refusal goes back to the step that can fix it', () => {
    async function toReview() {
        open();
        await pickFiles(['Facturen 2026.xlsx']);
        await pickFacturenSheet();
        next(); await screen.findByDisplayValue('Facturen 2026');
        next(); await screen.findByText(/at least two sheets/);
        next(); await screen.findByRole('button', { name: 'Link the sheet' });
        fireEvent.click(screen.getByRole('button', { name: 'Link the sheet' }));
    }
    const refusal = (code, body) => Object.assign(new Error(code), { status: 409, code, body });

    it('already_linked → the sheets step, the sheet marked', async () => {
        datatablesApi.linkSpreadsheets.mockRejectedValue(refusal('already_linked', { ref: { provider: 'google_drive', fileId: 'f1', sheet: 'Facturen' }, datatableId: 'tbl_old' }));
        await toReview();
        expect((await screen.findAllByText(/already linked here/)).length).toBeGreaterThan(1);
        expect(screen.getByRole('checkbox', { name: 'Facturen — Facturen 2026.xlsx' })).toBeChecked();
    });

    it('key_taken → the names step, the table marked', async () => {
        datatablesApi.linkSpreadsheets.mockRejectedValue(refusal('key_taken', { key: 'facturen_2026' }));
        await toReview();
        expect((await screen.findAllByText(/already a table with this key/)).length).toBeGreaterThan(1);
        expect(screen.getByDisplayValue('facturen_2026')).toBeInTheDocument();
    });

    it('key_not_unique → the sheets step, naming the column', async () => {
        datatablesApi.linkSpreadsheets.mockRejectedValue(refusal('key_not_unique', { ref: { provider: 'google_drive', fileId: 'f1', sheet: 'Facturen' }, header: 'Factuurnummer' }));
        await toReview();
        expect((await screen.findAllByText(/“Factuurnummer” is not unique/)).length).toBeGreaterThan(0);
        expect(screen.getByRole('region', { name: 'Facturen — Facturen 2026.xlsx' })).toBeInTheDocument();
    });

    it('an expired storage connection → the files step, with the way to renew it', async () => {
        datatablesApi.linkSpreadsheets.mockRejectedValue(refusal('provider_not_connected', { ref: { provider: 'google_drive', fileId: 'f1' }, detail: 'needs_reauth' }));
        await toReview();
        expect((await screen.findAllByText(/Google Drive connection has expired/)).length).toBeGreaterThan(0);
        expect(screen.getAllByText(/Settings → Connections/).length).toBeGreaterThan(0);
        expect(await screen.findByRole('navigation', { name: 'Folder path' })).toBeInTheDocument();
    });
});
