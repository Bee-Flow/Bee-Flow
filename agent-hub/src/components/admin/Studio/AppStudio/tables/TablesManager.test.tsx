import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../studioAppsApi', () => {
    const studioAppsApi = { getSchema: vi.fn(), saveSchema: vi.fn() };
    return { studioAppsApi, default: studioAppsApi };
});
vi.mock('@/components/shared/Toast', () => {
    const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
    return { default: toast, toast };
});
vi.mock('@/utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));
// The relationship canvas is covered by RelationshipsTab.test.jsx. Here we only
// care that the tab hangs off the same model and the same Save — mounting real
// ReactFlow for that would cost more than the assertion is worth.
vi.mock('./RelationshipsTab', () => ({
    default: ({ tables, onChange }: { tables?: unknown[]; onChange: (...args: unknown[]) => void }) => (
        <button type="button" data-testid="relations" onClick={() => onChange(tables)}>
            {tables!.length} tables on the map
        </button>
    ),
}));

import TablesManager from './TablesManager';
import { authFetch } from '@/utils/helpers';
import toast from '@/components/shared/Toast';
import { studioAppsApi } from '../studioAppsApi';
import { asMock } from '@/test/mocks';

/**
 * TablesManager owns the editable data model and the only Save. These tests
 * pin the two ways unsaved work used to disappear: the generators closed the
 * modal on top of pending edits, and the dirty flag was cleared by a save that
 * had started BEFORE those edits existed. Plus the Rows tab's one hard rule —
 * a table with no storage behind it yet cannot show rows, and must say so.
 */

const TABLE = {
    id: 'tbl_a', key: 'invoices', name: 'Invoices',
    fields: [{ id: 'fld_aaa111', key: 'amount', name: 'Amount', type: 'number' }],
};

const DEFINITION = {
    screens: [{ id: 'scr_1', name: 'Home', sections: [{ id: 'sec_1', children: [] }] }],
};

function renderManager(props = {}) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onCommit = vi.fn();
    const onClose = vi.fn();
    const utils = render(
        <QueryClientProvider client={qc}>
            <TablesManager
                open
                appId="app1"
                definition={DEFINITION}
                screenId="scr_1"
                onCommit={onCommit}
                onClose={onClose}
                {...props}
            />
        </QueryClientProvider>,
    );
    return { onCommit, onClose, ...utils };
}

/** Type into the selected table's name box (one model edit). */
function editTableName(value: unknown) {
    fireEvent.change(screen.getByPlaceholderText('Invoices'), { target: { value } });
}

beforeEach(() => {
    vi.clearAllMocks();
    asMock(studioAppsApi.getSchema).mockResolvedValue({ model: { modelVersion: 1, tables: [TABLE] }, modelVersion: 3 });
    asMock(studioAppsApi.saveSchema).mockResolvedValue({ ok: true, version: 4 });
    // useAppTables — the table already exists server-side, so the generators show.
    asMock(authFetch).mockResolvedValue({ ok: true, status: 200, json: async () => ({ tables: [TABLE] }) });
});

describe('TablesManager', () => {
    it('saves pending edits BEFORE a generator closes the modal', async () => {
        const { onCommit } = renderManager();
        await screen.findByPlaceholderText('Invoices');

        editTableName('Bills');
        await userEvent.click(screen.getByRole('button', { name: /make a form/i }));

        await waitFor(() => expect(studioAppsApi.saveSchema).toHaveBeenCalled());
        expect(asMock(studioAppsApi.saveSchema).mock.calls[0][1].tables[0].name).toBe('Bills');
        await waitFor(() => expect(onCommit).toHaveBeenCalled());
    });

    it('does not drop the form on the screen when that save fails', async () => {
        asMock(studioAppsApi.saveSchema).mockResolvedValue({ ok: false, invalid: true, errors: ['nope'] });
        const { onCommit, onClose } = renderManager();
        await screen.findByPlaceholderText('Invoices');

        editTableName('Bills');
        await userEvent.click(screen.getByRole('button', { name: /make a form/i }));

        await waitFor(() => expect(toast.error).toHaveBeenCalled());
        expect(onCommit).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
    });

    it('keeps edits made WHILE a save is in flight marked as unsaved', async () => {
        let release;
        asMock(studioAppsApi.saveSchema).mockImplementation(() => new Promise((resolve) => { release = () => resolve({ ok: true, version: 4 }); }));
        renderManager();
        await screen.findByPlaceholderText('Invoices');

        editTableName('Bills');
        const saveButton = screen.getByRole('button', { name: /save changes/i });
        await userEvent.click(saveButton);

        // The user keeps typing while the request is out.
        editTableName('Bills 2026');
        release!();

        await waitFor(() => expect((saveButton as HTMLInputElement).disabled).toBe(false));
        expect((screen.getByPlaceholderText('Invoices') as HTMLInputElement).value).toBe('Bills 2026');
    });

    it('opens the saved table’s rows on the Rows tab', async () => {
        renderManager();
        await screen.findByPlaceholderText('Invoices');

        await userEvent.click(screen.getByRole('button', { name: /^Rows$/ }));
        expect((await screen.findAllByRole('button', { name: /paste from a spreadsheet/i })).length).toBeGreaterThan(0);
        // The table list stays put, so another table's rows are one click away.
        expect(screen.getByRole('button', { name: 'Invoices' })).toBeTruthy();
    });

    it('keeps Rows shut — and explains why — until the table has been saved', async () => {
        asMock(authFetch).mockResolvedValue({ ok: true, status: 200, json: async () => ({ tables: [] }) });
        renderManager();
        await screen.findByPlaceholderText('Invoices');

        const rowsTab = screen.getByRole('button', { name: /^Rows$/ });
        expect((rowsTab as HTMLInputElement).disabled).toBe(true);
        expect(screen.getByText('Save the table to start adding rows.')).toBeTruthy();
    });

    it('links two tables from the Relationships tab and saves it with everything else', async () => {
        const OTHER = { id: 'tbl_b', key: 'lines', name: 'Lines', fields: [] };
        asMock(studioAppsApi.getSchema).mockResolvedValue({
            model: { modelVersion: 1, tables: [TABLE, OTHER] }, modelVersion: 3,
        });
        renderManager();
        await screen.findByPlaceholderText('Invoices');

        await userEvent.click(screen.getByRole('button', { name: /^Relationships$/ }));
        // Lazily loaded — ReactFlow is a lot of code for a tab most sessions
        // never open — so the tab arrives on a later tick.
        expect((await screen.findByTestId('relations')).textContent).toBe('2 tables on the map');

        await userEvent.click(screen.getByRole('button', { name: /^Tables$/ }));
        editTableName('Bills');
        await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
        await waitFor(() => expect(studioAppsApi.saveSchema).toHaveBeenCalled());
        expect(asMock(studioAppsApi.saveSchema).mock.calls[0][1].tables.map((t: { id: string }) => t.id)).toEqual(['tbl_a', 'tbl_b']);
    });

    it('says which connector is unfinished instead of failing the whole save', async () => {
        asMock(studioAppsApi.getSchema).mockResolvedValue({
            model: { modelVersion: 1, tables: [TABLE], connectors: [{ id: 'conn_aaa111', kind: 'rest', name: 'Prices' }] },
            modelVersion: 3,
        });
        renderManager();
        await screen.findByPlaceholderText('Invoices');

        editTableName('Bills');
        await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

        await waitFor(() => expect(toast.error).toHaveBeenCalled());
        expect(asMock(toast.error).mock.calls.at(-1)![0]).toMatch(/Prices.*web address/i);
        expect(studioAppsApi.saveSchema).not.toHaveBeenCalled();
    });
});

/**
 * THE TWO TABLE KINDS on screen.
 *
 * A table with its own storage and a table that takes its rows from a Studio
 * datatable (model.tables[].source) behave differently — editing columns does
 * nothing there, rows cannot be edited here, and a read-only link cannot carry
 * a form. Two rows that look identical and behave differently leave the user
 * unable to derive the rules, and he then blames himself. So: a visible difference.
 */
const LINKED = {
    id: 'tbl_b', key: 'orders', name: 'Orders',
    fields: [{ id: 'fld_bbb222', key: 'total', name: 'Total', type: 'number' }],
    source: { kind: 'datatable', datatableId: 'tbl_dt0001', mode: 'read' },
};

/** Model met de gekoppelde tabel als EERSTE (dus geselecteerd bij openen). */
function withLinked(source = LINKED.source) {
    const linked = { ...LINKED, source };
    asMock(studioAppsApi.getSchema).mockResolvedValue({
        model: { modelVersion: 1, tables: [linked, TABLE] }, modelVersion: 3,
    });
    // Both tables exist server-side, so the generators are visible and the
    // button choice is really about the KIND and not about “not yet saved”.
    asMock(authFetch).mockResolvedValue({ ok: true, status: 200, json: async () => ({ tables: [linked, TABLE] }) });
}

describe('TablesManager — table source (linked vs own storage)', () => {
    it('marks a linked table in the list and leaves an own-storage table’s name alone', async () => {
        withLinked();
        renderManager();
        await screen.findByPlaceholderText('Invoices');

        // De gekoppelde rij zegt het in haar toegankelijke naam én zichtbaar.
        expect(screen.getByRole('button', { name: /Orders — linked to a Studio table/i })).toBeTruthy();
        expect(screen.getByText('Linked')).toBeTruthy();
        // De bestaande soort houdt exact de naam die hij had.
        expect(screen.getByRole('button', { name: 'Invoices' })).toBeTruthy();
    });

    it('names the Studio table and the access mode in the source strip', async () => {
        withLinked();
        renderManager();
        await screen.findByPlaceholderText('Invoices');

        const strip = screen.getByTestId('table-source-strip');
        expect(strip.textContent).toMatch(/Linked to a Studio table/);
        // BIJ NAAM: zonder de id is er niets aan te wijzen als de koppeling breekt.
        expect(strip.textContent).toMatch(/tbl_dt0001/);
        expect(strip.textContent).toMatch(/Read only/);
    });

    it('says plainly that an own-storage table keeps its rows in the app', async () => {
        renderManager();
        await screen.findByPlaceholderText('Invoices');

        const strip = screen.getByTestId('table-source-strip');
        expect(strip.textContent).toMatch(/Stored in this app/);
        expect(strip.textContent).not.toMatch(/tbl_dt/);
    });

    it('keeps Rows shut for a linked table — those rows live somewhere else', async () => {
        withLinked();
        renderManager();
        await screen.findByPlaceholderText('Invoices');

        const rowsTab = screen.getByRole('button', { name: /^Rows$/ });
        expect((rowsTab as HTMLInputElement).disabled).toBe(true);
        expect(rowsTab.getAttribute('title')).toMatch(/live in a Studio table/i);
        expect(screen.getByText('Rows come from a Studio table.')).toBeTruthy();
    });

    it('offers no form for a read-only link, and says why — a grid still works', async () => {
        withLinked({ kind: 'datatable', datatableId: 'tbl_dt0001', mode: 'read' });
        renderManager();
        await screen.findByPlaceholderText('Invoices');

        expect(screen.queryByRole('button', { name: /make a form/i })).toBeNull();
        expect(screen.getByText(/This link is read only/i)).toBeTruthy();
        expect(screen.getByRole('button', { name: /make a grid/i })).toBeTruthy();
    });

    it('offers the form again when the link is readwrite', async () => {
        withLinked({ kind: 'datatable', datatableId: 'tbl_dt0001', mode: 'readwrite' });
        renderManager();
        await screen.findByPlaceholderText('Invoices');

        expect(screen.getByRole('button', { name: /make a form/i })).toBeTruthy();
        expect(screen.getByTestId('table-source-strip').textContent).toMatch(/Read and write/);
    });

    it('an unknown mode narrows — never shown as write, never shown as plain read', async () => {
        withLinked({ kind: 'datatable', datatableId: 'tbl_dt0001', mode: 'readWrite' });
        renderManager();
        await screen.findByPlaceholderText('Invoices');

        const strip = screen.getByTestId('table-source-strip');
        expect(strip.textContent).toMatch(/Unknown access/i);
        expect(strip.textContent).not.toMatch(/Read and write/);
        expect(screen.queryByRole('button', { name: /make a form/i })).toBeNull();
    });

    it('a source kind this version does not know is never shown as own storage', async () => {
        withLinked({ kind: 'spreadsheet', datatableId: 'tbl_dt0001', mode: 'read' });
        renderManager();
        await screen.findByPlaceholderText('Invoices');

        const strip = screen.getByTestId('table-source-strip');
        expect(strip.textContent).not.toMatch(/Stored in this app/);
        expect(strip.textContent).toMatch(/does not recognise/i);
        expect((screen.getByRole('button', { name: /^Rows$/ }) as HTMLButtonElement).disabled).toBe(true);
    });
});

/**
 * "Start clean": the Empty actions live in the table list, only for someone who
 * may edit; the dialog makes the owner type the app's name, and a 409
 * referenced_by is answered by widening the list. Everything goes through the
 * mocked authFetch, so the real api function is under test.
 */
const PARENTS = { id: 'tbl_p', key: 'customers', name: 'Customers', fields: [], rowCount: 12 };
const CHILD = { id: 'tbl_c', key: 'orders', name: 'Orders', fields: [], rowCount: 3 };

const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body, headers: { get: () => null } });

let emptyReplies: Array<ReturnType<typeof json>>;

function route(url: string) {
    if (url.endsWith('/data/empty')) return emptyReplies.shift() ?? json(200, { emptied: [], skipped: [], connectorsReset: 0, files: 0 });
    return json(200, { tables: [PARENTS, CHILD] });
}

function renderEmptyManager(props = {}) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
        <QueryClientProvider client={qc}>
            <TablesManager open appId="app1" appName="Shop" definition={null} screenId={null} {...props} />
        </QueryClientProvider>,
    );
}

const emptyCalls = () => asMock(authFetch).mock.calls.filter(([url]) => String(url).endsWith('/data/empty'));

describe('TablesManager — empty tables', () => {
    beforeEach(() => {
        emptyReplies = [];
        asMock(studioAppsApi.getSchema).mockResolvedValue({ model: { modelVersion: 1, tables: [PARENTS, CHILD] }, modelVersion: 1 });
        asMock(authFetch).mockImplementation(async (url: string) => route(String(url)));
    });

    it('shows no Empty action to someone who may not edit', async () => {
        renderEmptyManager({ canEmpty: false });
        await screen.findByRole('button', { name: 'Customers' });
        expect(screen.queryByRole('button', { name: /^empty/i })).toBeNull();
    });

    it('keeps Delete all rows disabled until the app name is typed, then empties all tables without tableIds', async () => {
        emptyReplies.push(json(200, { emptied: [{ tableId: 'tbl_p', key: 'customers', rows: 12 }, { tableId: 'tbl_c', key: 'orders', rows: 3 }], skipped: [], connectorsReset: 1, files: 2 }));
        renderEmptyManager();
        await userEvent.click(await screen.findByRole('button', { name: 'Empty all tables' }));

        const confirm = screen.getByRole('button', { name: 'Delete all rows' });
        expect(confirm).toBeDisabled();
        expect(screen.getByText('12 rows')).toBeInTheDocument();
        await userEvent.type(screen.getByLabelText(/type the app/i), '  shop ');
        expect(confirm).toBeEnabled();
        await userEvent.click(confirm);

        await waitFor(() => expect(emptyCalls()).toHaveLength(1));
        expect(JSON.parse(emptyCalls()[0][1].body)).toEqual({});
        await waitFor(() => expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('15 rows and 2 files deleted, 1 connectors reset')));
    });

    it('empties one table by id and widens the list when the server says another table still points at it', async () => {
        emptyReplies.push(
            json(409, { error: 'referenced', code: 'referenced_by', tables: [{ tableId: 'tbl_p', key: 'customers', referencedBy: ['orders'] }] }),
            json(200, { emptied: [], skipped: [], connectorsReset: 0, files: 0 }),
        );
        renderEmptyManager();
        await userEvent.click(await screen.findByRole('button', { name: 'Empty Customers' }));
        await userEvent.type(screen.getByLabelText(/type the app/i), 'Shop');
        await userEvent.click(screen.getByRole('button', { name: 'Delete all rows' }));

        expect(JSON.parse(emptyCalls()[0][1].body)).toEqual({ tableIds: ['tbl_p'] });
        expect(await screen.findByText('Empty orders too — it still points at customers')).toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: 'Include these tables' }));

        await waitFor(() => expect(emptyCalls()).toHaveLength(2));
        expect(JSON.parse(emptyCalls()[1][1].body)).toEqual({ tableIds: ['tbl_p', 'tbl_c'] });
    });

    it('shows the server’s sentence when emptying fails', async () => {
        emptyReplies.push(json(403, { error: 'Only the owner may do this.' }));
        renderEmptyManager();
        await userEvent.click(await screen.findByRole('button', { name: 'Empty all tables' }));
        await userEvent.type(screen.getByLabelText(/type the app/i), 'Shop');
        await userEvent.click(screen.getByRole('button', { name: 'Delete all rows' }));
        expect(await screen.findByText('Only the owner may do this.')).toBeInTheDocument();
    });
});
