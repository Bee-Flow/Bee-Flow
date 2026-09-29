import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../studioAppsApi', () => {
    const studioAppsApi = { getSchema: vi.fn(), saveSchema: vi.fn() };
    return { studioAppsApi, default: studioAppsApi };
});
vi.mock('../../../../shared/Toast', () => {
    const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
    return { default: toast, toast };
});
vi.mock('../../../../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));
// The relationship canvas is covered by RelationshipsTab.test.jsx. Here we only
// care that the tab hangs off the same model and the same Save — mounting real
// ReactFlow for that would cost more than the assertion is worth.
vi.mock('./RelationshipsTab', () => ({
    default: ({ tables, onChange }) => (
        <button type="button" data-testid="relations" onClick={() => onChange(tables)}>
            {tables.length} tables on the map
        </button>
    ),
}));

import TablesManager from './TablesManager';
import { authFetch } from '../../../../../utils/helpers';
import toast from '../../../../shared/Toast';
import { studioAppsApi } from '../studioAppsApi';

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
function editTableName(value) {
    fireEvent.change(screen.getByPlaceholderText('Invoices'), { target: { value } });
}

beforeEach(() => {
    vi.clearAllMocks();
    studioAppsApi.getSchema.mockResolvedValue({ model: { modelVersion: 1, tables: [TABLE] }, modelVersion: 3 });
    studioAppsApi.saveSchema.mockResolvedValue({ ok: true, version: 4 });
    // useAppTables — the table already exists server-side, so the generators show.
    authFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ tables: [TABLE] }) });
});

describe('TablesManager', () => {
    it('saves pending edits BEFORE a generator closes the modal', async () => {
        const { onCommit } = renderManager();
        await screen.findByPlaceholderText('Invoices');

        editTableName('Bills');
        fireEvent.click(screen.getByRole('button', { name: /make a form/i }));

        await waitFor(() => expect(studioAppsApi.saveSchema).toHaveBeenCalled());
        expect(studioAppsApi.saveSchema.mock.calls[0][1].tables[0].name).toBe('Bills');
        await waitFor(() => expect(onCommit).toHaveBeenCalled());
    });

    it('does not drop the form on the screen when that save fails', async () => {
        studioAppsApi.saveSchema.mockResolvedValue({ ok: false, invalid: true, errors: ['nope'] });
        const { onCommit, onClose } = renderManager();
        await screen.findByPlaceholderText('Invoices');

        editTableName('Bills');
        fireEvent.click(screen.getByRole('button', { name: /make a form/i }));

        await waitFor(() => expect(toast.error).toHaveBeenCalled());
        expect(onCommit).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
    });

    it('keeps edits made WHILE a save is in flight marked as unsaved', async () => {
        let release;
        studioAppsApi.saveSchema.mockImplementation(() => new Promise((resolve) => { release = () => resolve({ ok: true, version: 4 }); }));
        renderManager();
        await screen.findByPlaceholderText('Invoices');

        editTableName('Bills');
        const saveButton = screen.getByRole('button', { name: /save changes/i });
        fireEvent.click(saveButton);

        // The user keeps typing while the request is out.
        editTableName('Bills 2026');
        release();

        await waitFor(() => expect(saveButton.disabled).toBe(false));
        expect(screen.getByPlaceholderText('Invoices').value).toBe('Bills 2026');
    });

    it('opens the saved table’s rows on the Rows tab', async () => {
        renderManager();
        await screen.findByPlaceholderText('Invoices');

        fireEvent.click(screen.getByRole('button', { name: /^Rows$/ }));
        expect(await screen.findByRole('button', { name: /paste from a spreadsheet/i })).toBeTruthy();
        // The table list stays put, so another table's rows are one click away.
        expect(screen.getByRole('button', { name: 'Invoices' })).toBeTruthy();
    });

    it('keeps Rows shut — and explains why — until the table has been saved', async () => {
        authFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ tables: [] }) });
        renderManager();
        await screen.findByPlaceholderText('Invoices');

        const rowsTab = screen.getByRole('button', { name: /^Rows$/ });
        expect(rowsTab.disabled).toBe(true);
        expect(screen.getByText('Save the table to start adding rows.')).toBeTruthy();
    });

    it('links two tables from the Relationships tab and saves it with everything else', async () => {
        const OTHER = { id: 'tbl_b', key: 'lines', name: 'Lines', fields: [] };
        studioAppsApi.getSchema.mockResolvedValue({
            model: { modelVersion: 1, tables: [TABLE, OTHER] }, modelVersion: 3,
        });
        renderManager();
        await screen.findByPlaceholderText('Invoices');

        fireEvent.click(screen.getByRole('button', { name: /^Relationships$/ }));
        // Lazily loaded — ReactFlow is a lot of code for a tab most sessions
        // never open — so the tab arrives on a later tick.
        expect((await screen.findByTestId('relations')).textContent).toBe('2 tables on the map');

        fireEvent.click(screen.getByRole('button', { name: /^Tables$/ }));
        editTableName('Bills');
        fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
        await waitFor(() => expect(studioAppsApi.saveSchema).toHaveBeenCalled());
        expect(studioAppsApi.saveSchema.mock.calls[0][1].tables.map((t) => t.id)).toEqual(['tbl_a', 'tbl_b']);
    });

    it('says which connector is unfinished instead of failing the whole save', async () => {
        studioAppsApi.getSchema.mockResolvedValue({
            model: { modelVersion: 1, tables: [TABLE], connectors: [{ id: 'conn_aaa111', kind: 'rest', name: 'Prices' }] },
            modelVersion: 3,
        });
        renderManager();
        await screen.findByPlaceholderText('Invoices');

        editTableName('Bills');
        fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

        await waitFor(() => expect(toast.error).toHaveBeenCalled());
        expect(toast.error.mock.calls.at(-1)[0]).toMatch(/Prices.*web address/i);
        expect(studioAppsApi.saveSchema).not.toHaveBeenCalled();
    });
});

/**
 * DE TWEE TABELSOORTEN op het scherm.
 *
 * Een tabel met eigen opslag en een tabel die haar rijen uit een
 * Studio-datatabel haalt (model.tables[].source) gedragen zich verschillend —
 * kolommen bewerken doet daar niets, rijen zijn hier niet te bewerken, en een
 * alleen-lezen koppeling kan geen formulier dragen. Twee rijen die er identiek
 * uitzien en zich anders gedragen laten de gebruiker de regels niet afleiden;
 * dan gaat hij het aan zichzelf wijten. Dus: zichtbaar verschil.
 */
const LINKED = {
    id: 'tbl_b', key: 'orders', name: 'Orders',
    fields: [{ id: 'fld_bbb222', key: 'total', name: 'Total', type: 'number' }],
    source: { kind: 'datatable', datatableId: 'tbl_dt0001', mode: 'read' },
};

/** Model met de gekoppelde tabel als EERSTE (dus geselecteerd bij openen). */
function withLinked(source = LINKED.source) {
    const linked = { ...LINKED, source };
    studioAppsApi.getSchema.mockResolvedValue({
        model: { modelVersion: 1, tables: [linked, TABLE] }, modelVersion: 3,
    });
    // Beide tabellen bestaan serverzijdig, zodat de generatoren zichtbaar zijn
    // en de knopkeuze echt over de SOORT gaat en niet over "nog niet opgeslagen".
    authFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ tables: [linked, TABLE] }) });
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
        expect(rowsTab.disabled).toBe(true);
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
        expect(screen.getByRole('button', { name: /^Rows$/ }).disabled).toBe(true);
    });
});
