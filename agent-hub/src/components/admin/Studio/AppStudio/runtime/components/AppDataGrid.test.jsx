import { fireEvent, render, within } from '@testing-library/react';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import AppDataGrid from './AppDataGrid';
import { RuntimeProvider, buildScope, DEFAULT_RUNTIME } from '../RuntimeContext';

function withRuntime(ui, overrides = {}) {
    const value = {
        ...DEFAULT_RUNTIME,
        scope: buildScope({ now: '2020-01-01T00:00:00.000Z' }),
        mode: 'run',
        ...overrides,
    };
    return render(<RuntimeProvider value={value}>{ui}</RuntimeProvider>);
}

const ROWS = [
    { id: 1, name: 'Zoe', score: 30, status: 'open' },
    { id: 2, name: 'Amy', score: 10, status: 'done' },
    { id: 3, name: 'Max', score: 20, status: 'open' },
    { id: 4, name: 'Bea', score: 40, status: 'done' },
    { id: 5, name: 'Cy', score: 50, status: 'open' },
];

function gridNode(overrides = {}, propOverrides = {}) {
    return {
        id: 'cmp_grid', type: 'data_grid', visible: true,
        props: {
            source: { kind: 'static', value: ROWS },
            columns: [
                { key: 'name', label: 'Name', format: 'text', sortable: true },
                { key: 'score', label: 'Score', format: 'number', sortable: true },
                { key: 'status', label: 'Status', format: 'badge' },
            ],
            pageSize: 25, selectable: 'none', searchable: false, rowActions: [],
            density: 'comfortable', emptyText: 'Nothing to show yet.',
            ...propOverrides,
        },
        style: { span: 12 },
        ...overrides,
    };
}

function bodyRowTexts(container) {
    const rows = container.querySelectorAll('tbody tr');
    return Array.from(rows)
        .filter((tr) => !tr.getAttribute('aria-hidden') && tr.querySelector('td'))
        .map((tr) => tr.querySelector('td')?.textContent);
}

/*
 * CLICK-TO-EDIT HELPERS.
 *
 * An editable column used to render a live <input> in every row from the first
 * paint, so a test could just grab 'Edit cell' and type. Cells now show their
 * value until asked, which is the whole point of the change — so a test opens
 * the cell first, and reads the committed value back off the trigger's text
 * rather than off an input that is no longer mounted.
 *
 * What these tests assert has NOT changed: the same commits, the same queue,
 * the same rollback, the same optimistic value on screen.
 */
const cellTriggers = (utils) => utils.getAllByLabelText(/^Edit \w/);
const openCell = (utils, i = 0) => {
    fireEvent.click(cellTriggers(utils)[i]);
    return utils.getAllByLabelText('Edit cell')[0];
};
const cellText = (utils, i = 0) => cellTriggers(utils)[i].textContent;

describe('AppDataGrid', () => {
    it('renders bound rows', () => {
        const { getByText } = withRuntime(<AppDataGrid node={gridNode()} />);
        expect(getByText('Zoe')).toBeTruthy();
        expect(getByText('Bea')).toBeTruthy();
    });

    it('shows the empty state when unbound', () => {
        const { getByText } = withRuntime(
            <AppDataGrid node={gridNode({}, { source: { kind: 'static', value: [] } })} />,
        );
        expect(getByText('Nothing to show yet.')).toBeTruthy();
    });

    it('sorts ascending then descending on header click', () => {
        const { container, getByRole } = withRuntime(<AppDataGrid node={gridNode()} />);
        const nameHeader = getByRole('button', { name: /Name/ });
        fireEvent.click(nameHeader);
        expect(bodyRowTexts(container)[0]).toBe('Amy');
        fireEvent.click(nameHeader);
        expect(bodyRowTexts(container)[0]).toBe('Zoe');
    });

    it('filters rows via the search box', () => {
        const { container, getByLabelText } = withRuntime(
            <AppDataGrid node={gridNode({}, { searchable: true })} />,
        );
        fireEvent.change(getByLabelText('Search rows'), { target: { value: 'Amy' } });
        const texts = bodyRowTexts(container);
        expect(texts).toEqual(['Amy']);
    });

    it('paginates with a small page size', () => {
        const { container, getByLabelText } = withRuntime(
            <AppDataGrid node={gridNode({}, { pageSize: 2 })} />,
        );
        expect(bodyRowTexts(container).length).toBe(2);
        const firstPage = bodyRowTexts(container).join(',');
        fireEvent.click(getByLabelText('Next page'));
        expect(bodyRowTexts(container).join(',')).not.toBe(firstPage);
    });

    it('fires a row action via runAction', () => {
        const runAction = vi.fn();
        const { getAllByText } = withRuntime(
            <AppDataGrid node={gridNode({}, { rowActions: [{ label: 'Open', actionId: 'act_open' }] })} />,
            { runAction },
        );
        fireEvent.click(getAllByText('Open')[0]);
        expect(runAction).toHaveBeenCalledWith('act_open', expect.objectContaining({ formValues: expect.any(Object) }));
    });

    /**
     * A row action must hand over `item` as well as formValues, like
     * onRowClick/onRowSelect here and like every other row-context surface
     * (list, kanban). It did not, so an action authored as `item.id` — the
     * obvious spelling, and the one that works from every OTHER row control —
     * resolved to nothing: the button ran, reported success, and wrote nothing.
     */
    it('hands the row action BOTH formValues and item, like every other row surface', () => {
        const runAction = vi.fn();
        const { getAllByText } = withRuntime(
            <AppDataGrid node={gridNode({}, { rowActions: [{ label: 'Open', actionId: 'act_open' }] })} />,
            { runAction },
        );
        fireEvent.click(getAllByText('Open')[0]);
        const [, payload] = runAction.mock.calls[0];
        expect(payload.item).toBeTruthy();
        expect(payload.item).toEqual(payload.formValues);
        expect(payload.item.id).toBeTruthy();
    });

    it('fires an update via runAction on inline edit', () => {
        const runAction = vi.fn();
        const node = gridNode(
            { onRowSelect: 'act_update' },
            { columns: [{ key: 'name', label: 'Name', format: 'text', editable: true }] },
        );
        const utils = withRuntime(<AppDataGrid node={node} />, { runAction });
        const input = openCell(utils);
        fireEvent.change(input, { target: { value: 'Zed' } });
        fireEvent.blur(input);
        expect(runAction).toHaveBeenCalledWith('act_update', expect.objectContaining({
            formValues: expect.objectContaining({ name: 'Zed', __edited: 'name' }),
        }));
    });

    it('selects rows and notifies onRowSelect', () => {
        const runAction = vi.fn();
        const { getAllByLabelText } = withRuntime(
            <AppDataGrid node={gridNode({ onRowSelect: 'act_sel' }, { selectable: 'multi' })} />,
            { runAction },
        );
        fireEvent.click(getAllByLabelText('Select row')[0]);
        expect(runAction).toHaveBeenCalledWith('act_sel', expect.objectContaining({
            formValues: expect.objectContaining({ selected: expect.any(Array) }),
        }));
    });

    it('rolls the inline-edit overlay back when the update action fails', () => {
        const node = gridNode(
            { onRowSelect: 'act_update' },
            { columns: [{ key: 'name', label: 'Name', format: 'text', editable: true }] },
        );
        const ui = (actionState) => (
            <RuntimeProvider value={{
                ...DEFAULT_RUNTIME, scope: buildScope({ now: '2020-01-01T00:00:00.000Z' }),
                mode: 'run', runAction: vi.fn(), actionState,
            }}
            >
                <AppDataGrid node={node} />
            </RuntimeProvider>
        );
        const utils = render(ui({}));
        const { rerender } = utils;
        const input = openCell(utils);
        fireEvent.change(input, { target: { value: 'Zed' } });
        fireEvent.blur(input);
        expect(cellText(utils)).toBe('Zed');

        rerender(ui({ act_update: { status: 'running', result: undefined, error: null } }));
        rerender(ui({ act_update: { status: 'error', result: undefined, error: 'Could not save' } }));
        expect(cellText(utils)).toBe('Zoe');
    });

    it('queues a second inline edit while a commit is running and dispatches it on settle', () => {
        // useActionRunner's re-entry guard silently drops a run of an action
        // that is still 'running' — the grid must queue instead, or the second
        // cell of a fast Tab-through entry is never saved.
        const runAction = vi.fn();
        const node = gridNode(
            { onRowSelect: 'act_update' },
            { columns: [{ key: 'name', label: 'Name', format: 'text', editable: true }] },
        );
        const ui = (actionState) => (
            <RuntimeProvider value={{
                ...DEFAULT_RUNTIME, scope: buildScope({ now: '2020-01-01T00:00:00.000Z' }),
                mode: 'run', runAction, actionState,
            }}
            >
                <AppDataGrid node={node} />
            </RuntimeProvider>
        );
        const utils = render(ui({}));
        const { rerender } = utils;
        const first = openCell(utils, 0);
        fireEvent.change(first, { target: { value: 'Zed' } });
        fireEvent.blur(first);
        expect(runAction).toHaveBeenCalledTimes(1);

        rerender(ui({ act_update: { status: 'running', result: undefined, error: null } }));
        const second = openCell(utils, 1);
        fireEvent.change(second, { target: { value: 'Ann' } });
        fireEvent.blur(second);
        // Not dispatched while the first commit is live — queued, and its
        // optimistic value stays on screen.
        expect(runAction).toHaveBeenCalledTimes(1);
        expect(cellText(utils, 1)).toBe('Ann');

        rerender(ui({ act_update: { status: 'success', result: undefined, error: null } }));
        expect(runAction).toHaveBeenCalledTimes(2);
        expect(runAction.mock.calls[1][1].formValues).toMatchObject({ name: 'Ann', __edited: 'name' });
    });

    it('drops the inline-edit overlay once refetched rows arrive', () => {
        const columns = [{ key: 'name', label: 'Name', format: 'text', editable: true }];
        const served = [{ ...ROWS[0], name: 'Server' }, ...ROWS.slice(1)];
        const ui = (rows) => (
            <RuntimeProvider value={{
                ...DEFAULT_RUNTIME, scope: buildScope({ now: '2020-01-01T00:00:00.000Z' }),
                mode: 'run', runAction: vi.fn(),
            }}
            >
                <AppDataGrid node={gridNode({ onRowSelect: 'act_update' }, { columns, source: { kind: 'static', value: rows } })} />
            </RuntimeProvider>
        );
        const utils = render(ui(ROWS));
        const { rerender } = utils;
        const input = openCell(utils);
        fireEvent.change(input, { target: { value: 'Zed' } });
        fireEvent.blur(input);
        expect(cellText(utils)).toBe('Zed');

        rerender(ui(served));
        expect(cellText(utils)).toBe('Server');
    });

    it('renders in edit mode from sampled rows without firing actions', () => {
        const runAction = vi.fn();
        const { getByText } = withRuntime(<AppDataGrid node={gridNode()} />, { mode: 'edit', runAction });
        expect(getByText('Zoe')).toBeTruthy();
        expect(runAction).not.toHaveBeenCalled();
    });
});

describe('AppDataGrid — look variants', () => {
    /*
     * WHAT THESE PINS GUARD — and what they deliberately no longer guard.
     *
     * They were written to freeze the pre-look markup byte for byte, so the
     * look pass could add variants without changing a single stored app. That
     * job is still theirs: `default` and any unknown value must resolve to the
     * SAME base, and striped/minimal/cards must be additive on top of it.
     *
     * What changed is the base itself. The platform's tables were restyled on
     * purpose — align-middle instead of align-top, numerics right-aligned,
     * the shared `app-grid-base` rhythm — and every app was meant to get it.
     * So the strings below are re-pinned to the new base rather than defended:
     * the invariant is "default == unknown == base", not "base == what it was
     * in 2026".
     */
    const DEFAULT_TABLE_CLS = 'w-full app-grid-base text-sm';
    const DEFAULT_TH_CLS = 'text-left font-medium px-2.5 py-1.5 border-b select-none';
    const DEFAULT_TD_CLS = 'px-2.5 py-1.5 border-b align-middle text-left';

    const classesOf = (container) => ({
        table: container.querySelector('table').getAttribute('class'),
        th: container.querySelector('thead th').getAttribute('class'),
        td: container.querySelector('tbody td').getAttribute('class'),
    });

    it('default look renders the exact pre-look classes (no new class, no new style)', () => {
        const { container } = withRuntime(<AppDataGrid node={gridNode()} />);
        expect(classesOf(container)).toEqual({
            table: DEFAULT_TABLE_CLS, th: DEFAULT_TH_CLS, td: DEFAULT_TD_CLS,
        });
    });

    it('an unknown look value falls back to the identity path', () => {
        const { container } = withRuntime(<AppDataGrid node={gridNode({}, { look: 'sparkly' })} />);
        expect(classesOf(container)).toEqual({
            table: DEFAULT_TABLE_CLS, th: DEFAULT_TH_CLS, td: DEFAULT_TD_CLS,
        });
    });

    it('legacy zebra:true still stripes on the default look', () => {
        const { container } = withRuntime(<AppDataGrid node={gridNode({}, { zebra: true })} />);
        expect(container.querySelector('table').classList.contains('app-grid-zebra')).toBe(true);
    });

    it("look:'striped' stripes without needing the zebra boolean", () => {
        const { container } = withRuntime(<AppDataGrid node={gridNode({}, { look: 'striped' })} />);
        expect(container.querySelector('table').classList.contains('app-grid-zebra')).toBe(true);
        expect(classesOf(container).td).toContain('border-b');
    });

    it('look wins over zebra when both are set (spec: componentSpecs.js)', () => {
        const { container } = withRuntime(
            <AppDataGrid node={gridNode({}, { look: 'minimal', zebra: true })} />,
        );
        expect(container.querySelector('table').classList.contains('app-grid-zebra')).toBe(false);
    });

    it("look:'minimal' drops every divider, quiets the header and airs the rows", () => {
        const { container } = withRuntime(<AppDataGrid node={gridNode({}, { look: 'minimal' })} />);
        const got = classesOf(container);
        expect(got.th).not.toContain('border-b');
        expect(got.td).not.toContain('border-b');
        expect(got.th).toContain('uppercase');
        expect(got.th).toContain('tracking-wider');
        expect(got.td).toContain('py-2.5');
        for (const cell of container.querySelectorAll('th, td')) {
            expect(cell.getAttribute('class') || '').not.toContain('border-b');
        }
    });

    it("look:'cards' stamps the card class and drops the in-card dividers", () => {
        const { container } = withRuntime(<AppDataGrid node={gridNode({}, { look: 'cards' })} />);
        expect(container.querySelector('table').classList.contains('app-grid-cards')).toBe(true);
        expect(classesOf(container).td).not.toContain('border-b');
    });

    it("look:'cards' keeps sorting working", () => {
        const { container, getByRole } = withRuntime(<AppDataGrid node={gridNode({}, { look: 'cards' })} />);
        fireEvent.click(getByRole('button', { name: /Name/ }));
        expect(bodyRowTexts(container)[0]).toBe('Amy');
    });

    it("look:'cards' keeps selection working, via data-selected instead of an inline tint", () => {
        const runAction = vi.fn();
        const { container, getAllByLabelText } = withRuntime(
            <AppDataGrid node={gridNode({ onRowSelect: 'act_sel' }, { look: 'cards', selectable: 'multi' })} />,
            { runAction },
        );
        fireEvent.click(getAllByLabelText('Select row')[0]);
        expect(runAction).toHaveBeenCalledWith('act_sel', expect.objectContaining({
            formValues: expect.objectContaining({ selected: expect.any(Array) }),
        }));
        const selectedTr = container.querySelector('tbody tr[data-selected]');
        expect(selectedTr).toBeTruthy();
        // The tds paint the card surface, so the wash comes from the
        // app-grid-cards CSS keyed off data-selected — not an inline style
        // the card background would hide.
        expect(selectedTr.style.background).toBe('');
    });

    it("look:'cards' keeps inline edit, the filter row and pagination working", () => {
        const runAction = vi.fn();
        const node = gridNode(
            { onRowSelect: 'act_update' },
            {
                look: 'cards',
                pageSize: 2,
                columns: [
                    { key: 'name', label: 'Name', format: 'text', editable: true, filterable: true },
                    { key: 'score', label: 'Score', format: 'number' },
                ],
            },
        );
        const utils = withRuntime(<AppDataGrid node={node} />, { runAction });
        const { getByLabelText } = utils;
        // inline edit still commits
        const input = openCell(utils);
        fireEvent.change(input, { target: { value: 'Zed' } });
        fireEvent.blur(input);
        expect(runAction).toHaveBeenCalledWith('act_update', expect.objectContaining({
            formValues: expect.objectContaining({ name: 'Zed' }),
        }));
        // filter row still renders
        expect(getByLabelText('Filter Name')).toBeTruthy();
        // pagination still pages — an editable cell now shows its value as
        // text, so the page's contents can simply be read.
        const firstPage = cellTriggers(utils).map((el) => el.textContent).join(',');
        fireEvent.click(getByLabelText('Next page'));
        expect(cellTriggers(utils).map((el) => el.textContent).join(',')).not.toBe(firstPage);
    });

    it('introduces no hex colors in the component source', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const src = fs.readFileSync(path.join(__dirname, 'AppDataGrid.jsx'), 'utf8');
        expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    });
});

describe('AppDataGrid — click to edit', () => {
    const editableNode = (col = {}) => gridNode(
        { onRowSelect: 'act_update' },
        { columns: [{ key: 'name', label: 'Name', format: 'text', editable: true, ...col }] },
    );

    it('shows values, not input boxes, until a cell is asked to open', () => {
        // The whole point: an editable column used to render one live <input>
        // per row from the first paint, so the data could not be read at a
        // glance and the screen looked like a form.
        const utils = withRuntime(<AppDataGrid node={editableNode()} />, { runAction: vi.fn() });
        expect(utils.queryAllByLabelText('Edit cell')).toHaveLength(0);
        expect(cellText(utils, 0)).toBe('Zoe');

        fireEvent.click(cellTriggers(utils)[0]);
        expect(utils.queryAllByLabelText('Edit cell')).toHaveLength(1);
    });

    it('opens on F2 as well as on click, and focuses the editor', () => {
        const utils = withRuntime(<AppDataGrid node={editableNode()} />, { runAction: vi.fn() });
        fireEvent.keyDown(cellTriggers(utils)[0], { key: 'F2' });
        const input = utils.getByLabelText('Edit cell');
        expect(document.activeElement).toBe(input);
    });

    it('Escape reverts and commits nothing', () => {
        const runAction = vi.fn();
        const utils = withRuntime(<AppDataGrid node={editableNode()} />, { runAction });
        const input = openCell(utils);
        fireEvent.change(input, { target: { value: 'Zed' } });
        fireEvent.keyDown(input, { key: 'Escape' });
        expect(runAction).not.toHaveBeenCalled();
        expect(cellText(utils, 0)).toBe('Zoe');
    });

    it('Enter commits and closes the editor', () => {
        const runAction = vi.fn();
        const utils = withRuntime(<AppDataGrid node={editableNode()} />, { runAction });
        const input = openCell(utils);
        fireEvent.change(input, { target: { value: 'Zed' } });
        fireEvent.keyDown(input, { key: 'Enter' });
        expect(runAction).toHaveBeenCalledTimes(1);
        expect(utils.queryAllByLabelText('Edit cell')).toHaveLength(0);
        expect(cellText(utils, 0)).toBe('Zed');
    });

    it('commits nothing when the value was not actually changed', () => {
        const runAction = vi.fn();
        const utils = withRuntime(<AppDataGrid node={editableNode()} />, { runAction });
        const input = openCell(utils);
        fireEvent.blur(input);
        expect(runAction).not.toHaveBeenCalled();
    });

    it('a column with a toneMap edits as a dropdown, not free text', () => {
        // Free text is how 'doing' becomes 'diong' — and a state the board has
        // no column for is a card that vanishes.
        const node = editableNode({
            format: 'badge',
            toneMap: [{ value: 'todo', label: 'To do', tone: 'neutral' }, { value: 'done', label: 'Done', tone: 'success' }],
        });
        const utils = withRuntime(<AppDataGrid node={node} />, { runAction: vi.fn() });
        const editor = openCell(utils);
        expect(editor.tagName).toBe('SELECT');
        // The blank keeps a value clearable; the rest come from the map.
        expect(Array.from(editor.options).map((o) => o.value)).toEqual(['', 'todo', 'done']);
    });

    it('a check column toggles on click without opening an editor', () => {
        const runAction = vi.fn();
        const node = gridNode(
            { onRowSelect: 'act_update' },
            { columns: [{ key: 'flag', label: 'Flag', format: 'check', editable: true }] },
        );
        const utils = withRuntime(<AppDataGrid node={node} />, { runAction });
        fireEvent.click(cellTriggers(utils)[0]);
        expect(utils.queryAllByLabelText('Edit cell')).toHaveLength(0);
        expect(runAction).toHaveBeenCalledWith('act_update', expect.objectContaining({
            formValues: expect.objectContaining({ flag: true, __edited: 'flag' }),
        }));
    });

    it('a date column edits with a date control', () => {
        const node = editableNode({ key: 'when', format: 'date' });
        const utils = withRuntime(<AppDataGrid node={node} />, { runAction: vi.fn() });
        expect(openCell(utils).getAttribute('type')).toBe('date');
    });

    it('an editable cell is a real control — reachable and labelled', () => {
        const utils = withRuntime(<AppDataGrid node={editableNode()} />, { runAction: vi.fn() });
        const trigger = cellTriggers(utils)[0];
        expect(trigger.tagName).toBe('BUTTON');
        // Named after the column, so a screen reader says which cell it is.
        expect(trigger.getAttribute('aria-label')).toBe('Edit Name');
    });

    it('stays read-only in edit mode — the canvas is not a data entry surface', () => {
        const utils = withRuntime(<AppDataGrid node={editableNode()} />, { mode: 'edit', runAction: vi.fn() });
        expect(utils.queryAllByLabelText(/^Edit \w/)).toHaveLength(0);
    });
});

describe('AppDataGrid — filters that can be seen and undone', () => {
    const filterableNode = (cols) => gridNode({}, {
        searchable: true,
        columns: cols || [{ key: 'name', label: 'Name', format: 'text', filterable: true }],
    });

    it('a filtered view says so, from any scroll position', () => {
        // A column filter lives in a header row that scrolls away, and a term
        // left in the search box looks like an empty table. The count is the
        // only thing that stays put.
        const utils = withRuntime(<AppDataGrid node={filterableNode()} />);
        expect(utils.container.querySelector('[data-app-grid-filters]')).toBeNull();

        fireEvent.change(utils.getByLabelText('Search rows'), { target: { value: 'zzz' } });
        expect(utils.container.querySelector('[data-app-grid-filters]').getAttribute('data-app-grid-filters')).toBe('1');
    });

    it('counts the search box and the column filters together', () => {
        const utils = withRuntime(<AppDataGrid node={filterableNode()} />);
        fireEvent.change(utils.getByLabelText('Search rows'), { target: { value: 'z' } });
        fireEvent.change(utils.getByLabelText('Filter Name'), { target: { value: 'o' } });
        expect(utils.container.querySelector('[data-app-grid-filters]').getAttribute('data-app-grid-filters')).toBe('2');
    });

    it('clearing puts every row back', () => {
        const utils = withRuntime(<AppDataGrid node={filterableNode()} />);
        fireEvent.change(utils.getByLabelText('Search rows'), { target: { value: 'zzz' } });
        expect(utils.getByText('No rows match')).toBeTruthy();

        fireEvent.click(utils.getByText('Clear filters'));
        expect(utils.queryByText('No rows match')).toBeNull();
        expect(utils.getByText('Zoe')).toBeTruthy();
        expect(utils.container.querySelector('[data-app-grid-filters]')).toBeNull();
    });

    it('the empty state explains itself instead of printing four flat words', () => {
        const utils = withRuntime(<AppDataGrid node={filterableNode()} />);
        fireEvent.change(utils.getByLabelText('Search rows'), { target: { value: 'zzz' } });
        expect(utils.getByText('One filter is hiding the rest.')).toBeTruthy();
    });

    it('a column that names its values filters by picking one', () => {
        const utils = withRuntime(<AppDataGrid node={filterableNode([{
            key: 'name', label: 'Name', format: 'badge', filterable: true,
            toneMap: [{ value: 'Zoe', label: 'Zoe', tone: 'success' }, { value: 'Amy', label: 'Amy', tone: 'info' }],
        }])} />);
        const select = utils.getByLabelText('Filter Name');
        expect(select.tagName).toBe('SELECT');
        expect(Array.from(select.options).map((o) => o.value)).toEqual(['', 'Zoe', 'Amy']);

        fireEvent.change(select, { target: { value: 'Amy' } });
        // Read the BODY, not the document: 'Zoe' is still an <option> in the
        // filter itself, which is not the same as a row being on screen.
        const bodyText = () => Array.from(utils.container.querySelectorAll('tbody td')).map((td) => td.textContent);
        expect(bodyText().join(' ')).not.toContain('Zoe');
        expect(bodyText().join(' ')).toContain('Amy');
    });

    it('a number column filters by range, not by substring', () => {
        // "20" as a substring matched 20, 120 and 2000. As a range it means
        // what it says.
        const utils = withRuntime(<AppDataGrid node={filterableNode([
            { key: 'name', label: 'Name', format: 'text' },
            { key: 'score', label: 'Score', format: 'number', filterable: true },
        ])} />);
        expect(utils.getByLabelText('Filter Score from').getAttribute('type')).toBe('number');
        fireEvent.change(utils.getByLabelText('Filter Score from'), { target: { value: '20' } });
        fireEvent.change(utils.getByLabelText('Filter Score to'), { target: { value: '40' } });
        expect(bodyRowTexts(utils.container)).toEqual(['Zoe', 'Max', 'Bea']);
        // One chip, in words, that undoes just this filter.
        const chip = utils.container.querySelector('[data-app-grid-chip="score"]');
        expect(chip.textContent).toContain('20 – 40');
        fireEvent.click(within(chip).getByText('Remove filter on Score'));
        expect(bodyRowTexts(utils.container)).toHaveLength(5);
        expect(utils.container.querySelector('[data-app-grid-chip]')).toBeNull();
    });

    it('a badge column with few values offers them as a pick list without a toneMap', () => {
        const utils = withRuntime(<AppDataGrid node={filterableNode([
            { key: 'name', label: 'Name', format: 'text' },
            { key: 'status', label: 'Status', format: 'badge', filterable: true },
        ])} />);
        const select = utils.getByLabelText('Filter Status');
        expect(select.tagName).toBe('SELECT');
        expect(Array.from(select.options).map((o) => o.value)).toEqual(['', 'done', 'open']);
        fireEvent.change(select, { target: { value: 'done' } });
        expect(bodyRowTexts(utils.container)).toEqual(['Amy', 'Bea']);
        expect(utils.container.querySelector('[data-app-grid-chip="status"]').textContent).toContain('done');
    });

    it('a date column filters from–to, and a half-cleared range stops filtering', () => {
        const rows = [
            { id: 1, name: 'early', when: '2026-01-05' },
            { id: 2, name: 'mid', when: '2026-06-15T10:00:00Z' },
            { id: 3, name: 'late', when: '2026-12-24' },
        ];
        const utils = withRuntime(<AppDataGrid node={gridNode({}, {
            source: { kind: 'static', value: rows },
            columns: [{ key: 'name', label: 'Name' }, { key: 'when', label: 'When', format: 'date', filterable: true }],
        })} />);
        fireEvent.change(utils.getByLabelText('Filter When from'), { target: { value: '2026-06-01' } });
        expect(bodyRowTexts(utils.container)).toEqual(['mid', 'late']);
        fireEvent.change(utils.getByLabelText('Filter When to'), { target: { value: '2026-06-15' } });
        expect(bodyRowTexts(utils.container)).toEqual(['mid']);
        fireEvent.change(utils.getByLabelText('Filter When from'), { target: { value: '' } });
        fireEvent.change(utils.getByLabelText('Filter When to'), { target: { value: '' } });
        expect(bodyRowTexts(utils.container)).toHaveLength(3);
        expect(utils.container.querySelector('[data-app-grid-filters]')).toBeNull();
    });

    it('a check column filters yes/no', () => {
        const rows = [{ id: 1, name: 'a', paid: true }, { id: 2, name: 'b', paid: false }, { id: 3, name: 'c', paid: 'yes' }];
        const utils = withRuntime(<AppDataGrid node={gridNode({}, {
            source: { kind: 'static', value: rows },
            columns: [{ key: 'name', label: 'Name' }, { key: 'paid', label: 'Paid', format: 'check', filterable: true }],
        })} />);
        fireEvent.change(utils.getByLabelText('Filter Paid'), { target: { value: 'true' } });
        expect(bodyRowTexts(utils.container)).toEqual(['a', 'c']);
        fireEvent.change(utils.getByLabelText('Filter Paid'), { target: { value: 'false' } });
        expect(bodyRowTexts(utils.container)).toEqual(['b']);
    });

    it('beside chips the count button becomes "Clear all"', () => {
        const utils = withRuntime(<AppDataGrid node={filterableNode()} />);
        fireEvent.change(utils.getByLabelText('Search rows'), { target: { value: 'z' } });
        expect(utils.getByText('1 filter')).toBeTruthy();
        fireEvent.change(utils.getByLabelText('Filter Name'), { target: { value: 'o' } });
        expect(utils.getByText('Clear all')).toBeTruthy();
    });

    it('the filter control is named after the heading, not the storage key', () => {
        const utils = withRuntime(<AppDataGrid node={filterableNode([
            { key: 'name', label: 'Full name', format: 'text', filterable: true },
        ])} />);
        expect(utils.getByLabelText('Filter Full name')).toBeTruthy();
    });
});

/*
 * THE VIEW MENU.
 *
 * The author decides how a table looks; the person reading it every day has a
 * different problem. Fifteen columns of which nine repeat the same value on
 * every line, plus one chatty free-text column that makes each row eight lines
 * tall, is a table nobody can scan — and no author-side default fixes that for
 * everyone at once. These are reading preferences: they change nothing in the
 * definition and a viewer with no write access still gets them.
 */
describe('AppDataGrid — reader-side view settings', () => {
    beforeEach(() => { localStorage.clear(); });

    it('offers the View menu in run mode even when the grid has no search box', () => {
        // The grid with no search is exactly the one whose rows are hardest to
        // tell apart, and it used to render no chrome row at all.
        const { container } = withRuntime(<AppDataGrid node={gridNode()} />);
        expect(container.querySelector('[data-app-grid-viewmenu]')).toBeTruthy();
    });

    it('keeps the menu out of the builder canvas', () => {
        const { container } = withRuntime(<AppDataGrid node={gridNode()} />, { mode: 'edit' });
        expect(container.querySelector('[data-app-grid-viewmenu]')).toBeFalsy();
    });

    it('a viewer choice overrides the author default and is remembered', () => {
        const { container, unmount } = withRuntime(<AppDataGrid node={gridNode({}, { look: 'default' })} />);
        fireEvent.click(within(container.querySelector('[data-app-grid-viewmenu]')).getByText('View'));
        fireEvent.click(within(container.querySelector('[role="dialog"]')).getByText('Stripes'));
        expect(container.querySelector('table').className).toContain('app-grid-zebra');
        unmount();

        // Remounting is what a page navigation does — the choice has to survive it.
        const again = withRuntime(<AppDataGrid node={gridNode({}, { look: 'default' })} />);
        expect(again.container.querySelector('table').className).toContain('app-grid-zebra');
    });

    it('Reset gives the author default back', () => {
        const { container } = withRuntime(<AppDataGrid node={gridNode({}, { look: 'striped' })} />);
        fireEvent.click(within(container.querySelector('[data-app-grid-viewmenu]')).getByText('View'));
        fireEvent.click(within(container.querySelector('[role="dialog"]')).getByText('Space'));
        expect(container.querySelector('table').className).not.toContain('app-grid-zebra');

        fireEvent.click(within(container.querySelector('[role="dialog"]')).getByText('Reset'));
        expect(container.querySelector('table').className).toContain('app-grid-zebra');
    });

    it('clamping caps a cell at the chosen number of lines, and marks the box that clips', () => {
        const long = 'x'.repeat(120);
        const rows = [{ id: 1, name: long, score: 1, status: 'open' }];
        const node = gridNode({}, { source: { kind: 'static', value: rows }, clamp: '2' });
        const { container } = withRuntime(<AppDataGrid node={node} />);

        const cell = container.querySelector('tbody td');
        expect(cell.querySelector('span[style*="line-clamp"]')).toBeTruthy();
        // The hover panel finds what to show by this marker; without it the
        // clamp would hide text with no way left to read it.
        expect(cell.querySelector('[data-app-clamped]')).toBeTruthy();
    });

    it('does not clamp when the author and viewer both left it off', () => {
        const { container } = withRuntime(<AppDataGrid node={gridNode()} />);
        const cell = container.querySelector('tbody td');
        expect(cell.querySelector('span[style*="line-clamp"]')).toBeFalsy();
        expect(cell.querySelector('[data-app-clamped]')).toBeFalsy();
    });

    /*
     * THE BUG THIS PAIR EXISTS FOR.
     *
     * An editable cell renders its value inside a <button>, and a button is an
     * atomic box in its parent's inline flow — so the -webkit-line-clamp on the
     * wrapper outside counted the entire button as a single line and clipped
     * nothing at all. Every editable text column silently ignored the reader's
     * "Long text" setting, and one paragraph of AI reasoning made a row forty
     * lines tall. The clamp has to reach the element that holds the text.
     */
    it('an editable cell clamps too — the clamp reaches the button, not just the wrapper', () => {
        const long = 'x'.repeat(400);
        const rows = [{ id: 1, name: long, score: 1, status: 'open' }];
        const node = gridNode({}, {
            source: { kind: 'static', value: rows },
            clamp: '2',
            columns: [{ key: 'name', label: 'Name', format: 'text', editable: true }],
        });
        const { container } = withRuntime(<AppDataGrid node={node} />);

        const trigger = container.querySelector('tbody td button');
        expect(trigger).toBeTruthy();
        expect(trigger.getAttribute('style')).toMatch(/line-clamp:\s*2/);
        expect(trigger.getAttribute('data-app-clamped')).toBe('true');
    });

    it('leaves an editable cell alone when clamping is off', () => {
        const node = gridNode({}, {
            columns: [{ key: 'name', label: 'Name', format: 'text', editable: true }],
        });
        const { container } = withRuntime(<AppDataGrid node={node} />);
        const trigger = container.querySelector('tbody td button');
        expect(trigger.getAttribute('style')).not.toMatch(/line-clamp/);
        expect(trigger.getAttribute('data-app-clamped')).toBeNull();
    });

    it('no native tooltip: an OS slab is the wrong shape for a paragraph', () => {
        const long = 'x'.repeat(400);
        const rows = [{ id: 1, name: long, score: 1, status: 'open' }];
        const node = gridNode({}, { source: { kind: 'static', value: rows }, clamp: '2' });
        const { container } = withRuntime(<AppDataGrid node={node} />);
        expect(container.querySelector('tbody td').getAttribute('title')).toBeNull();
    });

    it('shows nothing until a cell is actually hovered', () => {
        const node = gridNode({}, { clamp: '2' });
        const { container } = withRuntime(<AppDataGrid node={node} />);
        expect(container.querySelector('[data-app-cell-peek]')).toBeFalsy();
    });

    it('a cell with nothing hidden opens no panel', () => {
        // jsdom reports scrollHeight === clientHeight === 0, which is exactly
        // the "nothing is clipped" case the guard is there for.
        const node = gridNode({}, { clamp: '2' });
        const { container } = withRuntime(<AppDataGrid node={node} />);
        fireEvent.mouseEnter(container.querySelector('tbody td'));
        expect(container.querySelector('[data-app-cell-peek]')).toBeFalsy();
    });
});

/*
 * ROW-LEVEL WARNINGS.
 *
 * A status column marks the row that needs a human — in a badge that, on a
 * fifteen-column table, sits past the right edge of the screen. The one row
 * anybody had to act on was the least visible thing on the page.
 */
describe('AppDataGrid — rowTone', () => {
    const TONED = [
        { id: 1, name: 'Zoe', score: 30, status: 'open', check: 'ok' },
        { id: 2, name: 'Amy', score: 10, status: 'done', check: 'controleren' },
        { id: 3, name: 'Max', score: 20, status: 'open', check: 'onvolledig' },
    ];
    const toneNode = (rowTone) => gridNode({}, {
        source: { kind: 'static', value: TONED },
        rowTone,
    });

    it('marks only the rows a rule matches', () => {
        const { container } = withRuntime(<AppDataGrid node={toneNode([
            { field: 'check', value: 'controleren', tone: 'warning' },
        ])} />);
        const tones = Array.from(container.querySelectorAll('tbody tr')).map((tr) => tr.getAttribute('data-app-row-tone'));
        expect(tones).toEqual([null, 'warning', null]);
    });

    it('paints an edge as well as a wash — colour alone is not a signal', () => {
        const { container } = withRuntime(<AppDataGrid node={toneNode([
            { field: 'check', value: 'controleren', tone: 'warning' },
        ])} />);
        const marked = container.querySelector('tr[data-app-row-tone="warning"]');
        expect(marked.getAttribute('style')).toContain('inset 3px');
    });

    it('takes the FIRST matching rule, so the loudest can be put first', () => {
        const { container } = withRuntime(<AppDataGrid node={toneNode([
            { field: 'check', value: 'onvolledig', tone: 'danger' },
            { field: 'check', value: 'controleren', tone: 'warning' },
        ])} />);
        const tones = Array.from(container.querySelectorAll('tbody tr')).map((tr) => tr.getAttribute('data-app-row-tone'));
        expect(tones).toEqual([null, 'warning', 'danger']);
    });

    it('compares as text, so a select storing "1" still matches the number 1', () => {
        const rows = [{ id: 1, name: 'A', score: 1, status: 'x', flag: 1 }];
        const node = gridNode({}, { source: { kind: 'static', value: rows }, rowTone: [{ field: 'flag', value: '1', tone: 'danger' }] });
        const { container } = withRuntime(<AppDataGrid node={node} />);
        expect(container.querySelector('tbody tr').getAttribute('data-app-row-tone')).toBe('danger');
    });

    it('does nothing at all when no rules are set', () => {
        const { container } = withRuntime(<AppDataGrid node={gridNode()} />);
        expect(container.querySelector('tbody tr').getAttribute('data-app-row-tone')).toBeNull();
    });
});

/*
 * BULK ACTIONS.
 *
 * Selection worked and led nowhere: you could tick twenty rows and the bar
 * offered "Clear". Anything you actually wanted to do to them had to be done
 * one row at a time.
 */
describe('AppDataGrid — bulk actions on the selection', () => {
    const bulkNode = () => gridNode({}, {
        selectable: 'multi',
        bulkActions: [{ label: 'Verwijderen', actionId: 'act_del', tone: 'danger' }],
    });
    const tickFirstTwo = (container) => {
        const boxes = container.querySelectorAll('tbody input[type="checkbox"]');
        fireEvent.click(boxes[0]);
        fireEvent.click(boxes[1]);
    };

    it('offers nothing until rows are picked', () => {
        const { container } = withRuntime(<AppDataGrid node={bulkNode()} />);
        expect(container.querySelector('[data-app-grid-selection]')).toBeFalsy();
    });

    it('hands the action the picked records, their ids and the count', () => {
        const runAction = vi.fn();
        const { container } = withRuntime(<AppDataGrid node={bulkNode()} />, { runAction });
        tickFirstTwo(container);

        const bar = container.querySelector('[data-app-grid-selection]');
        fireEvent.click(within(bar).getByText('Verwijderen'));

        expect(runAction).toHaveBeenCalledTimes(1);
        const [actionId, payload] = runAction.mock.calls[0];
        expect(actionId).toBe('act_del');
        expect(payload.formValues.selectedCount).toBe(2);
        expect(payload.formValues.selectedIds).toEqual([1, 2]);
        expect(payload.formValues.selectedRows.map((r) => r.name)).toEqual(['Zoe', 'Amy']);
    });

    it('drops the selection after firing — a tick on a deleted row is a lie', () => {
        const { container } = withRuntime(<AppDataGrid node={bulkNode()} />, { runAction: vi.fn() });
        tickFirstTwo(container);
        fireEvent.click(within(container.querySelector('[data-app-grid-selection]')).getByText('Verwijderen'));
        expect(container.querySelector('[data-app-grid-selection]')).toBeFalsy();
    });

    it('stays out of the builder canvas', () => {
        const { container } = withRuntime(<AppDataGrid node={bulkNode()} />, { mode: 'edit' });
        const boxes = container.querySelectorAll('tbody input[type="checkbox"]');
        if (boxes.length >= 2) { fireEvent.click(boxes[0]); fireEvent.click(boxes[1]); }
        const bar = container.querySelector('[data-app-grid-selection]');
        if (bar) expect(within(bar).queryByText('Verwijderen')).toBeNull();
    });
});

/*
 * A COLUMN THAT IS A BUTTON.
 *
 * A status column is what people reach for when they want to change the
 * status; sending them to a button at the far end of the row is a detour.
 */
describe('AppDataGrid — columns[].actionId', () => {
    const clickableNode = () => gridNode({}, {
        columns: [
            { key: 'name', label: 'Name', format: 'text' },
            { key: 'status', label: 'Status', format: 'badge', actionId: 'act_mark' },
        ],
    });

    it('fires the column action with the row, and only that action', () => {
        const runAction = vi.fn();
        const { container } = withRuntime(<AppDataGrid node={clickableNode()} />, { runAction });
        const cells = container.querySelectorAll('tbody tr:first-child td');
        fireEvent.click(within(cells[1]).getByRole('button'));

        expect(runAction).toHaveBeenCalledTimes(1);
        const [actionId, payload] = runAction.mock.calls[0];
        expect(actionId).toBe('act_mark');
        expect(payload.item.name).toBe('Zoe');
        expect(payload.formValues.name).toBe('Zoe');
    });

    it('leaves columns without an actionId as plain cells', () => {
        const { container } = withRuntime(<AppDataGrid node={clickableNode()} />, { runAction: vi.fn() });
        const cells = container.querySelectorAll('tbody tr:first-child td');
        expect(within(cells[0]).queryByRole('button')).toBeNull();
    });

    it('does not double-fire the row click', () => {
        const runAction = vi.fn();
        const node = { ...clickableNode(), onRowClick: 'act_open' };
        const { container } = withRuntime(<AppDataGrid node={node} />, { runAction });
        const cells = container.querySelectorAll('tbody tr:first-child td');
        fireEvent.click(within(cells[1]).getByRole('button'));
        expect(runAction.mock.calls.map((c) => c[0])).toEqual(['act_mark']);
    });
});

/*
 * ADDING A ROW FROM INSIDE THE TABLE.
 *
 * The moment you notice a row is missing you are looking at the bottom of the
 * list — not at a button in the page header, which belongs to the page rather
 * than to this table.
 */
describe('AppDataGrid — add-row footer', () => {
    const addNode = (props = {}) => gridNode({}, { addRowActionId: 'act_add', ...props });

    it('sits inside the table body, after the rows', () => {
        const { container } = withRuntime(<AppDataGrid node={addNode()} />);
        const rows = Array.from(container.querySelectorAll('tbody tr'));
        expect(rows[rows.length - 1].getAttribute('data-app-grid-addrow')).toBe('true');
    });

    it('fires the action', () => {
        const runAction = vi.fn();
        const { container } = withRuntime(<AppDataGrid node={addNode()} />, { runAction });
        fireEvent.click(within(container.querySelector('[data-app-grid-addrow]')).getByRole('button'));
        expect(runAction).toHaveBeenCalledWith('act_add', {});
    });

    it('uses the authored label, and has a sensible one without', () => {
        const withLabel = withRuntime(<AppDataGrid node={addNode({ addRowLabel: 'Nieuwe projectregel' })} />);
        expect(withLabel.container.querySelector('[data-app-grid-addrow]').textContent).toContain('Nieuwe projectregel');
        const bare = withRuntime(<AppDataGrid node={addNode()} />);
        expect(bare.container.querySelector('[data-app-grid-addrow]').textContent).toContain('Add row');
    });

    it('still offers itself when the table is empty — that is when it matters most', () => {
        const node = gridNode({}, { addRowActionId: 'act_add', source: { kind: 'static', value: [] } });
        const { container } = withRuntime(<AppDataGrid node={node} />);
        expect(container.querySelector('[data-app-grid-addrow]')).toBeTruthy();
    });

    it('is absent without an action, and absent in the builder', () => {
        const { container } = withRuntime(<AppDataGrid node={gridNode()} />);
        expect(container.querySelector('[data-app-grid-addrow]')).toBeFalsy();
        const edit = withRuntime(<AppDataGrid node={addNode()} />, { mode: 'edit' });
        expect(edit.container.querySelector('[data-app-grid-addrow]')).toBeFalsy();
    });
});

/*
 * THE TABLE'S OWN TOOLBAR.
 *
 * An action that belongs to this table used to need a page header above it to
 * live in — which meant a second title bar repeating the tab's name purely to
 * have somewhere to put a button.
 */
describe('AppDataGrid — toolbarActions', () => {
    const barNode = () => gridNode({}, {
        toolbarActions: [
            { label: 'Portaal-CSV maken', actionId: 'act_csv', tone: 'primary' },
            { label: 'Nabewerken-CSV', actionId: 'act_nab' },
        ],
    });

    it('renders in the chrome row and fires its action', () => {
        const runAction = vi.fn();
        const { container } = withRuntime(<AppDataGrid node={barNode()} />, { runAction });
        fireEvent.click(within(container).getByText('Portaal-CSV maken'));
        expect(runAction).toHaveBeenCalledWith('act_csv', {});
    });

    it('fills a primary one and outlines the rest', () => {
        const { container } = withRuntime(<AppDataGrid node={barNode()} />, { runAction: vi.fn() });
        expect(within(container).getByText('Portaal-CSV maken').getAttribute('style')).toContain('--app-primary');
        expect(within(container).getByText('Nabewerken-CSV').getAttribute('style')).toContain('--border-default');
    });

    it('stays out of the builder canvas', () => {
        const { container } = withRuntime(<AppDataGrid node={barNode()} />, { mode: 'edit' });
        expect(within(container).queryByText('Portaal-CSV maken')).toBeNull();
    });
});

/*
 * WHAT IS IN THIS COLUMN.
 *
 * A heading squeezed to "Snijkw." names the column without saying anything
 * about its contents, and a column of bare 0s and 8s is unreadable to everyone
 * who did not pick those codes.
 */
describe('AppDataGrid — columns[].help', () => {
    it('explains the column on hover over its header', () => {
        const node = gridNode({}, {
            columns: [
                { key: 'name', label: 'Name', format: 'text', help: 'Wie het onderdeel maakt.' },
                { key: 'score', label: 'Snijkw.', format: 'number' },
            ],
        });
        const { container } = withRuntime(<AppDataGrid node={node} />);
        const [first, second] = container.querySelectorAll('thead th');
        expect(first.getAttribute('title')).toBe('Wie het onderdeel maakt.');
        // No help means no empty tooltip box on hover.
        expect(second.getAttribute('title')).toBeNull();
    });
});

describe('AppDataGrid — rowTone under the cards look', () => {
    const CARD_ROWS = [
        { id: 1, name: 'Zoe', score: 30, status: 'open', check: 'ok' },
        { id: 2, name: 'Amy', score: 10, status: 'done', check: 'controleren' },
    ];
    const cardNode = () => gridNode({}, {
        source: { kind: 'static', value: CARD_ROWS },
        look: 'cards',
        rowTone: [{ field: 'check', value: 'controleren', tone: 'warning' }],
    });

    it('hands the tone to the cells as a variable, since the cards paint over the row', () => {
        const { container } = withRuntime(<AppDataGrid node={cardNode()} />);
        const marked = container.querySelector('tr[data-app-row-tone="warning"]');
        expect(marked).toBeTruthy();
        expect(marked.getAttribute('style')).toContain('--app-row-tone');
    });

    it('leaves the card elevation alone — no inline shadow to replace it', () => {
        const { container } = withRuntime(<AppDataGrid node={cardNode()} />);
        const marked = container.querySelector('tr[data-app-row-tone="warning"]');
        expect(marked.getAttribute('style')).not.toContain('inset 3px');
    });

    it('still paints the row itself under every other look', () => {
        const node = gridNode({}, {
            source: { kind: 'static', value: CARD_ROWS },
            look: 'striped',
            rowTone: [{ field: 'check', value: 'controleren', tone: 'warning' }],
        });
        const { container } = withRuntime(<AppDataGrid node={node} />);
        expect(container.querySelector('tr[data-app-row-tone="warning"]').getAttribute('style')).toContain('inset 3px');
    });
});

describe('AppDataGrid — grouping (groupBy / groupOrder)', () => {
    const groupedNode = (propOverrides = {}) => gridNode({}, {
        groupBy: 'status',
        groupOrder: [{ value: 'done', label: 'In orde', tone: 'success' }],
        ...propOverrides,
    });
    const rowTexts = (container) => [...container.querySelectorAll('tbody tr')].map((tr) => tr.textContent);

    it('renders a header per group: groupOrder first, unlisted groups after in data order', () => {
        const { container } = withRuntime(<AppDataGrid node={groupedNode()} />);
        const headers = [...container.querySelectorAll('[data-app-grid-group]')];
        expect(headers.map((h) => h.getAttribute('data-app-grid-group'))).toEqual(['done', 'open']);
        expect(headers[0].textContent).toContain('In orde · 2');
        expect(headers[1].textContent).toContain('open · 3');
    });

    it('buckets the rows under their headers, keeping data order within a group', () => {
        const { container } = withRuntime(<AppDataGrid node={groupedNode()} />);
        expect(rowTexts(container)).toEqual([
            expect.stringContaining('In orde'), expect.stringContaining('Amy'), expect.stringContaining('Bea'),
            expect.stringContaining('open'), expect.stringContaining('Zoe'), expect.stringContaining('Max'), expect.stringContaining('Cy'),
        ]);
    });

    it('a group header carries the tone as readable text colour', () => {
        const { container, getByRole } = withRuntime(<AppDataGrid node={groupedNode()} />);
        const header = getByRole('button', { name: /In orde/ });
        // roleTextColor mixes the role hue with --text-primary for dark mode.
        expect(header.getAttribute('style')).toContain('color-mix');
        expect(container.querySelector('[data-app-grid-group="done"] td').getAttribute('style')).toContain('--bg-secondary');
    });

    it('sorting still works WITHIN groups — rows reorder, groups stay put', () => {
        const { container, getByRole } = withRuntime(<AppDataGrid node={groupedNode()} />);
        // Numeric columns sort DESCENDING on the first click (tanstack's
        // sortDescFirst for numbers). Scores: Cy 50, Bea 40, Zoe 30, Max 20,
        // Amy 10 — bucketed after the sort, so 'open' now reads Cy before Zoe.
        fireEvent.click(getByRole('button', { name: /Score/ }));
        expect(rowTexts(container)).toEqual([
            expect.stringContaining('In orde'), expect.stringContaining('Bea'), expect.stringContaining('Amy'),
            expect.stringContaining('open'), expect.stringContaining('Cy'), expect.stringContaining('Zoe'), expect.stringContaining('Max'),
        ]);
    });

    it('clicking a header collapses the group and clicking again reopens it', () => {
        const { container, getByRole } = withRuntime(<AppDataGrid node={groupedNode()} />);
        const header = () => getByRole('button', { name: /In orde/ });
        expect(rowTexts(container).join(',')).toContain('Amy');
        fireEvent.click(header());
        expect(rowTexts(container).join(',')).not.toContain('Amy');
        // The header itself stays, and says it is closed.
        expect(header().getAttribute('aria-expanded')).toBe('false');
        // The other group is untouched.
        expect(rowTexts(container).join(',')).toContain('Zoe');
        fireEvent.click(header());
        expect(rowTexts(container).join(',')).toContain('Amy');
    });

    it('collapsed:true starts a group closed until its header is clicked', () => {
        const node = groupedNode({
            groupOrder: [{ value: 'done', label: 'In orde', tone: 'success', collapsed: true }],
        });
        const { container, getByRole } = withRuntime(<AppDataGrid node={node} />);
        expect(rowTexts(container).join(',')).not.toContain('Amy');
        fireEvent.click(getByRole('button', { name: /In orde/ }));
        expect(rowTexts(container).join(',')).toContain('Amy');
    });

    it('an empty groupBy value gets its own trailing group under an em-dash header', () => {
        const rows = [{ id: 1, name: 'Zoe', status: 'open' }, { id: 2, name: 'Amy', status: null }];
        const node = gridNode({}, {
            source: { kind: 'static', value: rows },
            columns: [{ key: 'name', label: 'Name', format: 'text' }],
            groupBy: 'status', groupOrder: [],
        });
        const { container } = withRuntime(<AppDataGrid node={node} />);
        const headers = [...container.querySelectorAll('[data-app-grid-group]')];
        expect(headers.map((h) => h.getAttribute('data-app-grid-group'))).toEqual(['open', '']);
        expect(headers[1].textContent).toContain('—');
    });
});

describe('AppDataGrid — the active row (activeWhen)', () => {
    it('marks the matching row with the accent wash and 3px edge bar', () => {
        const { container } = withRuntime(
            <AppDataGrid node={gridNode({}, { activeWhen: 'item.id == 3' })} />,
        );
        const active = container.querySelector('tr[data-app-row-active]');
        expect(active).toBeTruthy();
        expect(active.textContent).toContain('Max');
        expect(container.querySelectorAll('tr[data-app-row-active]').length).toBe(1);
        expect(active.getAttribute('style')).toContain('--app-primary-soft');
        expect(active.style.boxShadow).toBe('inset 3px 0 0 0 var(--app-primary)');
    });

    it('wins the row paint over a matching rowTone; other rows keep their tone', () => {
        const node = gridNode({}, {
            activeWhen: 'item.id == 3',
            rowTone: [{ field: 'status', value: 'open', tone: 'danger' }],
        });
        const { container } = withRuntime(<AppDataGrid node={node} />);
        const active = container.querySelector('tr[data-app-row-active]');
        expect(active.getAttribute('style')).toContain('--app-primary-soft');
        expect(active.style.boxShadow).toBe('inset 3px 0 0 0 var(--app-primary)');
        // The two OTHER open rows still carry the danger paint.
        const toned = [...container.querySelectorAll('tr[data-app-row-tone="danger"]')]
            .filter((tr) => !tr.hasAttribute('data-app-row-active'));
        expect(toned.length).toBe(2);
        for (const tr of toned) expect(tr.getAttribute('style')).toContain('inset 3px');
    });

    it('under cards it hands the accent over as the row-tone variable, no inline shadow', () => {
        const { container } = withRuntime(
            <AppDataGrid node={gridNode({}, { look: 'cards', activeWhen: 'item.id == 3' })} />,
        );
        const active = container.querySelector('tr[data-app-row-active]');
        expect(active.getAttribute('data-app-row-tone')).toBe('primary');
        expect(active.getAttribute('style')).toContain('--app-row-tone');
        expect(active.getAttribute('style')).not.toContain('inset 3px');
    });
});

describe('AppDataGrid — new props at their defaults are the identity path', () => {
    it('renders byte-identically with groupBy/groupOrder/activeWhen at their defaults', () => {
        const plain = withRuntime(<AppDataGrid node={gridNode()} />).container.innerHTML;
        const withDefaults = withRuntime(
            <AppDataGrid node={gridNode({}, { groupBy: null, groupOrder: [], activeWhen: null })} />,
        ).container.innerHTML;
        expect(withDefaults).toBe(plain);
    });
});
