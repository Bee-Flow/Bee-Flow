import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DatatableDetail from './DatatableDetail';
import { datatablesApi } from './datatablesApi';

/**
 * Ronde 2 of the Datatables design (handoff Datatables.dc.html, 2a–2c):
 * the tabs live in the 48px command bar; the content is one 960px column
 * with the purpose and "n columns · m rows" above it; the Rows tab runs
 * edge to edge with a footer bar; "Delete this table…" is a menu item that
 * opens the armed danger zone in a dialog; "Rename table" opens the
 * header's inline edit; "Duplicate" copies the shape and never the rows;
 * column rows carry no technical name and no "your own column", a choice
 * column shows its options as chips, a written column wears a pill, and the
 * grip reorders; an empty choice cell is a dimmed "no status yet"; numbers
 * sit right; the sharing tab has no "Nobody yet".
 */

vi.mock('./datatablesApi', () => {
    const datatablesApi = {
        list: vi.fn(), get: vi.fn(), remove: vi.fn(), update: vi.fn(), create: vi.fn(),
        getSchema: vi.fn(), putSchema: vi.fn(),
        listRows: vi.fn(), addRow: vi.fn(), updateRow: vi.fn(), deleteRow: vi.fn(), exportCsv: vi.fn(),
        listGrants: vi.fn(), addGrant: vi.fn(), removeGrant: vi.fn(), setSharing: vi.fn(),
        listUsage: vi.fn(), health: vi.fn(), repair: vi.fn(), getRow: vi.fn(),
    };
    return { datatablesApi, default: datatablesApi };
});
vi.mock('../AppStudio/rbac/useAppRoles', () => ({ useOrgDirectory: () => ({ users: [], groups: [], available: true, isLoading: false }) }));

const FIELDS = [
    { id: 'f1', key: 'datum', name: 'Datum', type: 'date' },
    { id: 'f2', key: 'leverancier', name: 'Leverancier', type: 'text' },
    { id: 'f3', key: 'bedrag', name: 'Bedrag excl. BTW', type: 'number' },
    { id: 'f4', key: 'status', name: 'Status', type: 'select', options: ['Nieuw', 'Goedgekeurd', 'Afgewezen'] },
];
const TABLE = {
    id: 'tbl_1', name: 'PB vaag', key: 'pb_vaag', description: 'Facturen die de Playbook-routine uit PDF-facturen haalt',
    rowCount: 2, isPublished: false, sharedGroups: [], writeMode: 'grants', scopeKind: 'org', grade: 'owner', ownerUserId: 'u1',
    retentionDays: null, retentionField: null, updatedAt: new Date(Date.now() - 38 * 60 * 1000).toISOString(),
};
const ROWS = [
    { id: 'r1', datum: '2026-09-20', leverancier: 'Van Dijk Klimaattechniek B.V.', bedrag: 1674.38, status: null, created_at: new Date(Date.now() - 38 * 60 * 1000).toISOString() },
    { id: 'r2', datum: '2026-09-19', leverancier: 'Bakker Installatie B.V.', bedrag: 875, status: 'Nieuw', created_at: new Date(Date.now() - 26 * 3600 * 1000).toISOString() },
];

function renderDetail(props = {}) {
    return render(<DatatableDetail table={TABLE} canManage currentUserId="u1" onBack={() => {}} onChanged={vi.fn()} onDeleted={vi.fn()} onNavigate={vi.fn()} {...props} />);
}
const openMenu = () => fireEvent.click(screen.getByRole('button', { name: /More about this table/ }));

beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    datatablesApi.getSchema.mockResolvedValue({ fields: FIELDS, modelVersion: 3 });
    datatablesApi.listRows.mockResolvedValue({ rows: ROWS, hasMore: false, count: 2, total: 2 });
    datatablesApi.listUsage.mockResolvedValue({ usage: [{ automationId: 'a1', automationTitle: 'Playbook', stepId: 's4', mode: 'write', columns: ['datum', 'leverancier', 'bedrag'] }] });
    datatablesApi.listGrants.mockResolvedValue({ grants: [] });
    datatablesApi.update.mockResolvedValue({ datatable: TABLE });
    datatablesApi.create.mockResolvedValue({ datatable: { id: 'tbl_copy' } });
});

describe('the shell (2a/2c)', () => {
    it('puts the tabs in the command bar and the content in a 960px column with the purpose and the counts above it', async () => {
        renderDetail();
        const header = document.querySelector('[data-testid="studio-section-header"], header') || document.body;
        const tabs = within(header).getAllByRole('radio').map(r => r.textContent);
        expect(tabs.join('|')).toMatch(/Columns.*Rows.*Data & retention.*Sharing.*Used by/);
        const lede = await screen.findByTestId('table-lede');
        expect(lede.textContent).toContain('Facturen die de Playbook-routine');
        await waitFor(() => expect(screen.getByTestId('table-meta').textContent).toBe('4 columns · 2 rows'));
        expect(lede.parentElement.style.maxWidth).toBe('960px');
        // no red line under the tab
        expect(screen.queryByRole('button', { name: /Delete this table/ })).toBeNull();
    });

    it('⋯ menu: Rename table opens the header’s inline edit; Duplicate copies the shape, never the rows, and opens the copy', async () => {
        const onNavigate = vi.fn();
        renderDetail({ onNavigate });
        await screen.findByTestId('table-meta');
        openMenu();
        const items = screen.getAllByRole('menuitem').map(m => m.textContent);
        expect(items[0]).toContain('Rename table');
        expect(items[1]).toContain('Duplicate');
        expect(items[2]).toContain('Export');
        expect(items[items.length - 1]).toContain('Delete this table…');
        fireEvent.click(screen.getByTestId('menu-rename'));
        const input = await screen.findByTestId('studio-section-title-input');
        fireEvent.change(input, { target: { value: 'PB duidelijk' } });
        fireEvent.keyDown(input, { key: 'Enter' });
        await waitFor(() => expect(datatablesApi.update).toHaveBeenCalledWith('tbl_1', { name: 'PB duidelijk' }));

        openMenu();
        fireEvent.click(screen.getByTestId('menu-duplicate'));
        await waitFor(() => expect(datatablesApi.create).toHaveBeenCalled());
        const body = datatablesApi.create.mock.calls[0][0];
        expect(body.name).toBe('PB vaag (copy)');
        expect(body.scope).toBe('organisation');
        expect(body.fields.map(f => f.key)).toEqual(['datum', 'leverancier', 'bedrag', 'status']);
        expect(body.fields[3].options).toEqual(['Nieuw', 'Goedgekeurd', 'Afgewezen']);
        expect(body.rows).toBeUndefined();
        expect(onNavigate).toHaveBeenCalledWith('studio/datatables/tbl_copy');
    });

    it('⋯ menu: Delete this table… opens the danger zone already armed, in a dialog, and the name is typed', async () => {
        renderDetail();
        await screen.findByTestId('table-meta');
        openMenu();
        fireEvent.click(screen.getByRole('menuitem', { name: /Delete this table/ }));
        expect(await screen.findByTestId('danger-dependents')).toHaveTextContent('Playbook');
        const confirm = screen.getByRole('button', { name: /Delete for good/ });
        expect(confirm.disabled).toBe(true);
        fireEvent.change(within(screen.getByTestId('danger-zone')).getByRole('textbox'), { target: { value: 'PB vaag' } });
        expect(screen.getByRole('button', { name: /Delete for good/ }).disabled).toBe(false);
    });

    it('a viewer gets no Rename, Duplicate or Delete', async () => {
        renderDetail({ table: { ...TABLE, grade: 'viewer' } });
        await screen.findByTestId('table-meta');
        openMenu();
        expect(screen.queryByTestId('menu-rename')).toBeNull();
        expect(screen.queryByTestId('menu-duplicate')).toBeNull();
        expect(screen.queryByTestId('menu-delete')).toBeNull();
    });
});

describe('Columns (2a)', () => {
    it('compact rows: no technical name, no "your own column", a pill on written columns, chips for a choice column, the grip reorders', async () => {
        renderDetail();
        await screen.findByDisplayValue('Datum');
        expect(screen.queryByText(/your own column/)).toBeNull();
        expect(screen.queryByText('leverancier')).toBeNull();
        const pills = screen.getAllByTestId('column-usage');
        expect(pills.length).toBe(3);
        expect(pills[0].textContent).toContain('1 automation');
        const chips = within(screen.getByTestId('column-options')).getAllByText(/Nieuw|Goedgekeurd|Afgewezen/);
        expect(chips.length).toBe(3);
        expect(screen.getByTestId('columns-hint').textContent).toMatch(/Drag the handle to reorder/);
        // the grip moves with the keyboard, the arrows are gone
        expect(screen.queryByRole('button', { name: /Move Datum down/ })).toBeNull();
        fireEvent.keyDown(screen.getByRole('button', { name: /Reorder Datum/ }), { key: 'ArrowDown' });
        const names = screen.getAllByLabelText('Column name').map(i => i.value);
        expect(names.slice(0, 2)).toEqual(['Leverancier', 'Datum']);
        // the chips' + opens the options editor
        fireEvent.click(screen.getByTestId('column-options-edit'));
        expect(screen.getByLabelText('Options for Status').value).toBe('Nieuw, Goedgekeurd, Afgewezen');
    });
});

describe('Rows (2b)', () => {
    it('runs edge to edge with a footer bar, right-aligns numbers, shows "Added" relatively and an empty choice as a dimmed pill', async () => {
        renderDetail({ initialTab: 'rows' });
        const page = await screen.findByTestId('table-rows-page');
        expect(within(page).getByRole('table')).toBeTruthy();
        expect(page.querySelector('[data-layout="page"]')).not.toBeNull();
        const headers = screen.getAllByRole('columnheader').map(h => [h.textContent.trim(), h.className]);
        const bedrag = headers.find(([label]) => label.includes('Bedrag'));
        expect(bedrag[1]).toContain('text-right');
        const cells = within(page).getAllByRole('cell').filter(c => c.className.includes('text-right'));
        expect(cells.length).toBeGreaterThan(0);
        expect(cells[0].className).toContain('tabular-nums');
        const empty = screen.getByTestId('cell-empty-choice');
        expect(empty.textContent).toBe('no status yet');
        expect(screen.getByText(/^38m ago$/)).toBeTruthy();
        expect(screen.getByTestId('rows-add-ghost')).toBeTruthy();
        expect(screen.queryByTestId('table-lede')).toBeNull();
    });
});

describe('Sharing (2c)', () => {
    it('two cards, no "Nobody yet", and the consequence is one line at the foot of the audience card', async () => {
        renderDetail({ initialTab: 'sharing' });
        expect(await screen.findByText('Who can read the rows')).toBeTruthy();
        expect(screen.getByText('People and teams')).toBeTruthy();
        expect(screen.queryByText('Nobody yet.')).toBeNull();
        const line = screen.getByTestId('sharing-consequence');
        expect(line.textContent).toMatch(/can read every row/);
        expect(screen.getByText('Only you and the people you invite.')).toBeTruthy();
    });
});
