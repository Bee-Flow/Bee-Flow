import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { literalTableId, readValuesMap, withoutValuesInput } from './tablesRowValues';
import TablesRowValuesEditor from './TablesRowValuesEditor';
import { editor, typeInEditor } from '../../../../../test/refEditor';
import { authFetch } from '../../../../../utils/helpers';
import { VariablePickerProvider } from '../../mapping/VariablePickerContext';

vi.mock('../../../../../utils/helpers', async (orig) => ({
    ...(await orig()),
    API_BASE: '',
    authFetch: vi.fn(),
}));

/**
 * The column-aware editor for the `values` input of the Nextcloud Tables row
 * steps. What is pinned here:
 *
 *   1. one row per COLUMN of the table, typed, read through the authenticated
 *      fetch every builder panel uses;
 *   2. what it emits is the tool's own shape — the plain map keyed by column
 *      TITLE, bindings nested inside, never a JSON string;
 *   3. a key the AI wrote that is not a column is shown and removable, never
 *      silently dropped; one that only differs in spelling lands on its column;
 *   4. Auto-map fills by normalised name only — `excl_btw` reaches "Excl. btw",
 *      `amount_total` does NOT reach "Totaal";
 *   5. a tableId bound from a step, or a failed read, falls back to typed
 *      titles and SAYS why.
 *
 * Run: cd agent-hub && ./node_modules/.bin/vitest run src/components/automation/Builder/flow/settings/TablesRowValuesEditor.test.jsx
 */

const COLUMNS = [
    { id: 1, title: 'Bedrijf', type: 'text', subtype: 'line', mandatory: true, description: 'Naam van de leverancier' },
    { id: 2, title: 'Excl. btw', type: 'number', subtype: null, mandatory: false, description: '' },
    { id: 3, title: 'Totaal', type: 'number', subtype: null, mandatory: false, description: '' },
    { id: 4, title: 'Datum', type: 'datetime', subtype: 'date', mandatory: false, description: '' },
    { id: 5, title: 'Status', type: 'selection', subtype: null, mandatory: false, description: '' },
];

const ITEM = { excl_btw: 100, amount_total: 121, bedrijf: 'Acme BV', vat: 21 };
const SAMPLE = { loop: { e: { output: ITEM } }, steps: { s1: { output: { company: 'Acme BV' } } } };
const GROUPS = [
    {
        id: 's1', label: 'extract invoice', kind: 'integration_action',
        basePath: 'steps.s1.output', sample: SAMPLE.steps.s1.output,
        fields: [{ key: 'company', path: 'steps.s1.output.company', sample: 'Acme BV' }],
    },
    {
        id: 'lp1__foreach', label: 'Current item (e)', kind: 'loop',
        basePath: 'loop.e', sample: SAMPLE.loop.e,
        fields: [{
            key: 'output', path: 'loop.e.output', sample: ITEM,
            children: Object.entries(ITEM).map(([k, v]) => ({ key: k, path: `loop.e.output.${k}`, sample: v })),
        }],
    },
];

function mockColumns(columns = COLUMNS, { status = 200 } = {}) {
    authFetch.mockImplementation(async (url) => {
        if (!String(url).includes('/nextcloud-tables/')) return { ok: true, status: 200, json: async () => ({}) };
        if (status !== 200) return { ok: false, status, json: async () => ({ error: 'nope' }) };
        return { ok: true, status: 200, json: async () => ({ tableId: 7, count: columns.length, columns }) };
    });
}

const step = (over = {}) => ({
    id: 'act_1', type: 'integration_action', tool: 'nextcloud_tables_create_row',
    inputs: { tableId: { kind: 'literal', value: 7 } },
    forEach: { overRef: 'steps.s0.output.results', itemVar: 'e' },
    ...over,
});

function renderEditor({ value = undefined, tableId = { kind: 'literal', value: 7 }, stepOver = {}, onChange = vi.fn() } = {}) {
    render(
        <VariablePickerProvider groups={GROUPS} previewSample={SAMPLE} stepLabelById={new Map([['s1', 'extract invoice']])}>
            <TablesRowValuesEditor
                step={step(stepOver)}
                tableId={tableId}
                value={value}
                onChange={onChange}
                groups={GROUPS}
                previewSample={SAMPLE}
            />
        </VariablePickerProvider>,
    );
    return { onChange };
}

const rows = () => screen.queryAllByTestId('tables-row-column');
const rowTitled = (title) => rows().find(r => within(r).queryByText(title));

describe('TablesRowValuesEditor', () => {
    beforeEach(() => { cleanup(); authFetch.mockReset(); });

    it('renders one typed row per column of the table it fetched', async () => {
        mockColumns();
        renderEditor();
        await waitFor(() => expect(rows()).toHaveLength(COLUMNS.length));
        expect(authFetch).toHaveBeenCalledWith(expect.stringContaining('/api/automation/catalog/nextcloud-tables/7/columns'));
        for (const c of COLUMNS) expect(rowTitled(c.title)).toBeTruthy();
        // The type badge names the Nextcloud type, not a JSON word.
        const types = rows().map(r => within(r).getByTestId('tables-row-type').getAttribute('data-type'));
        expect(types).toEqual(['text', 'number', 'number', 'datetime', 'selection']);
        // A mandatory column on create_row is marked Required; the others are not.
        expect(within(rowTitled('Bedrijf')).getByText('Required')).toBeTruthy();
        expect(within(rowTitled('Totaal')).queryByText('Required')).toBeNull();
        // And there is no raw JSON box anywhere.
        expect(screen.queryByText(/"kind"/)).toBeNull();
    });

    it('emits the plain map keyed by column title — bindings nested, never a JSON string', async () => {
        mockColumns();
        const { onChange } = renderEditor({ value: {} });
        await waitFor(() => expect(rows()).toHaveLength(COLUMNS.length));
        typeInEditor(editor(rowTitled('Bedrijf')), 'Acme BV');
        expect(onChange).toHaveBeenCalledTimes(1);
        const emitted = onChange.mock.calls[0][0];
        expect(typeof emitted).toBe('object');
        expect(emitted.kind).toBeUndefined();
        expect(emitted).toEqual({ Bedrijf: { kind: 'literal', value: 'Acme BV' } });
    });

    it('shows a stored value on its column, and clearing it drops the key rather than writing an empty cell', async () => {
        mockColumns();
        const value = { Totaal: { kind: 'ref', path: 'loop.e.output.amount_total' }, Bedrijf: { kind: 'literal', value: 'Acme' } };
        const { onChange } = renderEditor({ value });
        await waitFor(() => expect(rows()).toHaveLength(COLUMNS.length));
        // The ref renders as a chip naming the step, not the raw path.
        expect(within(rowTitled('Totaal')).getByText('Loop item · e')).toBeTruthy();
        fireEvent.click(within(rowTitled('Totaal')).getByLabelText('Remove this value'));
        expect(onChange).toHaveBeenCalledWith({ Bedrijf: { kind: 'literal', value: 'Acme' } });
    });

    it('keeps keys that are not a column in a separate group with a remove button — nothing the AI wrote is lost', async () => {
        mockColumns();
        const value = {
            vat: { kind: 'ref', path: 'loop.e.output.vat' },
            excl_btw: { kind: 'ref', path: 'loop.e.output.excl_btw' },
        };
        const { onChange } = renderEditor({ value });
        await waitFor(() => expect(rows()).toHaveLength(COLUMNS.length));
        // `excl_btw` only differs from "Excl. btw" in spelling → it lands on
        // that row, exactly as the tool resolves it at run time.
        expect(within(rowTitled('Excl. btw')).getByText('Loop item · e')).toBeTruthy();
        // `vat` reaches no column → shown, named, removable.
        const stray = screen.getByTestId('tables-row-stray');
        expect(within(stray).getByText('vat')).toBeTruthy();
        expect(within(stray).queryByText('excl_btw')).toBeNull();
        fireEvent.click(within(stray).getByLabelText('Remove vat'));
        expect(onChange).toHaveBeenCalledWith({ excl_btw: { kind: 'ref', path: 'loop.e.output.excl_btw' } });
    });

    it('editing an aliased key writes it under the canonical column title', async () => {
        mockColumns();
        const { onChange } = renderEditor({ value: { excl_btw: { kind: 'literal', value: '1' } } });
        await waitFor(() => expect(rows()).toHaveLength(COLUMNS.length));
        typeInEditor(editor(rowTitled('Excl. btw')), '12');
        expect(onChange).toHaveBeenCalledWith({ 'Excl. btw': { kind: 'literal', value: '12' } });
    });

    it('Auto-map fills by normalised name only: excl_btw → "Excl. btw", bedrijf → "Bedrijf"; amount_total stays unmapped', async () => {
        mockColumns();
        const { onChange } = renderEditor({ value: {} });
        await waitFor(() => expect(rows()).toHaveLength(COLUMNS.length));
        // The step iterates over `e`, so the default source is its item group.
        expect(screen.getByLabelText('Map from').value).toBe('lp1__foreach');
        fireEvent.click(screen.getByText('Auto-map'));
        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onChange.mock.calls[0][0]).toEqual({
            'Excl. btw': { kind: 'ref', path: 'loop.e.output.excl_btw' },
            Bedrijf: { kind: 'ref', path: 'loop.e.output.bedrijf' },
        });
        const note = screen.getByTestId('tables-row-automap-note');
        expect(note.textContent).toContain('2 columns filled.');
        expect(note.textContent).toContain('amount_total');
        expect(note.textContent).toContain('vat');
    });

    it('Auto-map never overwrites a column that already holds a value', async () => {
        mockColumns();
        const value = { Bedrijf: { kind: 'literal', value: 'Keep me' } };
        const { onChange } = renderEditor({ value });
        await waitFor(() => expect(rows()).toHaveLength(COLUMNS.length));
        fireEvent.click(screen.getByText('Auto-map'));
        expect(onChange.mock.calls[0][0]).toEqual({
            Bedrijf: { kind: 'literal', value: 'Keep me' },
            'Excl. btw': { kind: 'ref', path: 'loop.e.output.excl_btw' },
        });
    });

    it('Auto-map can be pointed at another upstream step', async () => {
        mockColumns([{ id: 9, title: 'Company', type: 'text' }]);
        const { onChange } = renderEditor({ value: {} });
        await waitFor(() => expect(rows()).toHaveLength(1));
        fireEvent.change(screen.getByLabelText('Map from'), { target: { value: 's1' } });
        fireEvent.click(screen.getByText('Auto-map'));
        expect(onChange).toHaveBeenCalledWith({ Company: { kind: 'ref', path: 'steps.s1.output.company' } });
    });

    it('a tableId bound from a step shows the manual fallback and says why — no fetch is made', async () => {
        mockColumns();
        const { onChange } = renderEditor({ tableId: { kind: 'ref', path: 'steps.s0.output.tableId' }, value: {} });
        expect(screen.getByText(/The table is chosen while the routine runs/)).toBeTruthy();
        expect(authFetch).not.toHaveBeenCalled();
        expect(rows()).toHaveLength(0);
        // Typing titles adds untyped rows the author can bind.
        fireEvent.change(screen.getByLabelText('Column titles'), { target: { value: 'Bedrijf, Excl. btw' } });
        fireEvent.click(screen.getByText('Add columns'));
        expect(rows()).toHaveLength(2);
        expect(within(rowTitled('Excl. btw')).queryByTestId('tables-row-type')).toBeNull();
        typeInEditor(editor(rowTitled('Excl. btw')), '12');
        expect(onChange).toHaveBeenCalledWith({ 'Excl. btw': { kind: 'literal', value: '12' } });
    });

    it('a failed read falls back to typed titles, names the failure and offers a retry', async () => {
        mockColumns(COLUMNS, { status: 404 });
        renderEditor({ value: { vat: { kind: 'ref', path: 'loop.e.output.vat' } } });
        await waitFor(() => expect(screen.getByText(/Could not read the columns of table 7/)).toBeTruthy());
        // In manual mode the stored keys ARE the rows — nothing is called stray
        // when we cannot know what the columns are.
        expect(rows()).toHaveLength(1);
        expect(rowTitled('vat')).toBeTruthy();
        expect(screen.queryByTestId('tables-row-stray')).toBeNull();
        mockColumns();
        fireEvent.click(screen.getByText('Try again'));
        await waitFor(() => expect(rows()).toHaveLength(COLUMNS.length));
        expect(screen.getByTestId('tables-row-stray')).toBeTruthy();
    });

    it('a whole-row binding is shown as one slot with a way back to columns', async () => {
        mockColumns();
        const { onChange } = renderEditor({ value: { kind: 'ref', path: 'steps.s1.output.row' } });
        expect(screen.getByTestId('tables-row-whole')).toBeTruthy();
        expect(rows()).toHaveLength(0);
        fireEvent.click(screen.getByText('Fill in the columns one by one instead'));
        expect(onChange).toHaveBeenCalledWith({});
    });
});

describe('the pure helpers', () => {
    it('literalTableId accepts a number, a numeric string, a title or a literal binding — never a bound value', () => {
        expect(literalTableId(7)).toBe(7);
        expect(literalTableId('7')).toBe(7);
        expect(literalTableId({ kind: 'literal', value: 7 })).toBe(7);
        expect(literalTableId({ kind: 'literal', value: '7' })).toBe(7);
        // A title is a literal too: the columns route and the tool resolve it.
        expect(literalTableId('Facturen')).toBe('Facturen');
        expect(literalTableId({ kind: 'literal', value: '  Facturen  ' })).toBe('Facturen');
        expect(literalTableId({ kind: 'literal', value: '   ' })).toBeNull();
        expect(literalTableId(7.5)).toBeNull();
        expect(literalTableId({ kind: 'ref', path: 'steps.x.output.id' })).toBeNull();
        expect(literalTableId({ kind: 'template', value: '{{steps.x.output.id}}' })).toBeNull();
        expect(literalTableId({ kind: 'literal', value: '' })).toBeNull();
        expect(literalTableId(0)).toBeNull();
        expect(literalTableId(null)).toBeNull();
    });

    it('readValuesMap unwraps the shapes the AI has written and keeps a whole-row binding apart', () => {
        const map = { Bedrijf: { kind: 'literal', value: 'x' } };
        expect(readValuesMap(map)).toEqual({ map, whole: null });
        expect(readValuesMap({ kind: 'literal', value: map })).toEqual({ map, whole: null });
        expect(readValuesMap({ kind: 'literal', value: JSON.stringify(map) })).toEqual({ map, whole: null });
        expect(readValuesMap(JSON.stringify(map))).toEqual({ map, whole: null });
        expect(readValuesMap(undefined)).toEqual({ map: {}, whole: null });
        const ref = { kind: 'ref', path: 'steps.x.output.row' };
        expect(readValuesMap(ref)).toEqual({ map: {}, whole: ref });
    });

    it('withoutValuesInput strips only `values`, from properties and required alike', () => {
        const schema = {
            type: 'object',
            properties: { tableId: { type: 'integer' }, values: { type: 'object' } },
            required: ['tableId', 'values'],
        };
        expect(withoutValuesInput(schema)).toEqual({
            type: 'object', properties: { tableId: { type: 'integer' } }, required: ['tableId'],
        });
        const other = { properties: { q: {} }, required: ['q'] };
        expect(withoutValuesInput(other)).toBe(other);
        expect(withoutValuesInput(null)).toBeNull();
    });
});
