import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import scopedStorage from '../../../../../../utils/scopedStorage';
import { PREVIEW_DELAY_MS } from '../../../../../../hooks/automationBuilder/useTablePreview';
import { COLUMNS, GROUPS, HANDLE, SAMPLE, SOURCE, TableHarness, fakePreview, okResponse, op, opResult } from './testKit';

const GROUP = (extra: Record<string, unknown> = {}) => op('group', 'op1', { by: ['Region'], aggregates: [{ fn: 'sum', column: 'Amount', as: 'Total' }], ...extra });
const FILTER = (id: string, extra: Record<string, unknown> = {}) => op('filter', id, extra);

function renderEditor(ops: ReturnType<typeof op>[], preview = fakePreview().fn, sample: unknown = SAMPLE) {
    const drafts: Record<string, unknown>[] = [];
    render(<TableHarness initial={{ source: SOURCE, ops }} preview={preview} sample={sample} onDraft={d => drafts.push(d)} />);
    return { drafts, last: () => drafts[drafts.length - 1] as { ops: ReturnType<typeof op>[]; source: unknown } };
}

beforeEach(() => {
    scopedStorage.setCurrentUser('test-user');
    try { localStorage.clear(); } catch { /* storage blocked */ }
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('the list of steps', () => {
    it('adds a step from the menu, grouped by what it is for, and opens its form', async () => {
        const user = userEvent.setup();
        const { last } = renderEditor([]);
        await user.click(screen.getByRole('button', { name: 'Add a step' }));
        const menu = screen.getByRole('menu');
        for (const group of ['Combine', 'Clean up', 'Calculate', 'Summarise', 'Protect', 'Inspect']) expect(within(menu).getByRole('group', { name: group })).toBeTruthy();
        expect(within(menu).getByText('Match each row with a row of a second table and bring its columns along.')).toBeTruthy();
        await user.click(within(menu).getByRole('menuitem', { name: /Keep rows that match/ }));
        expect(last().ops).toMatchObject([{ id: 'op1', op: 'filter', enabled: true, match: 'all', rules: [] }]);
        expect(screen.getByTestId('op-form-filter')).toBeTruthy();
    });

    it('moves a step up and down with the arrows', async () => {
        const user = userEvent.setup();
        const { last } = renderEditor([FILTER('a'), op('select', 'b')]);
        expect((screen.getByRole('button', { name: 'Move up: Keep rows that match' }) as HTMLButtonElement).disabled).toBe(true);
        expect((screen.getByRole('button', { name: 'Move down: Choose columns' }) as HTMLButtonElement).disabled).toBe(true);
        await user.click(screen.getByRole('button', { name: 'Move down: Keep rows that match' }));
        expect(last().ops.map(o => o.id)).toEqual(['b', 'a']);
        await user.click(screen.getByRole('button', { name: 'Move up: Keep rows that match' }));
        expect(last().ops.map(o => o.id)).toEqual(['a', 'b']);
    });

    it('switches a step off and on', async () => {
        const user = userEvent.setup();
        const { last } = renderEditor([FILTER('a')]);
        await user.click(screen.getByRole('checkbox', { name: 'Use this step: Keep rows that match' }));
        expect(last().ops[0].enabled).toBe(false);
        expect(screen.getByText('Off')).toBeTruthy();
        await user.click(screen.getByRole('checkbox', { name: 'Use this step: Keep rows that match' }));
        expect(last().ops[0].enabled).toBe(true);
    });

    it('duplicates and removes a step', async () => {
        const user = userEvent.setup();
        const { last } = renderEditor([FILTER('a'), op('select', 'b')]);
        await user.click(screen.getByRole('button', { name: 'Duplicate: Keep rows that match' }));
        expect(last().ops.map(o => o.id)).toEqual(['a', 'op3', 'b']);
        await user.click(screen.getAllByRole('button', { name: 'Remove: Keep rows that match' })[1]);
        expect(last().ops.map(o => o.id)).toEqual(['a', 'b']);
    });

    it('shows how many rows go in and come out of each step', async () => {
        const { fn } = fakePreview(okResponse({ opResults: [opResult('a', COLUMNS.map(c => c.key), { inputRows: 50, outputRows: 20 })] }));
        renderEditor([FILTER('a')], fn);
        expect(await screen.findByText(/50 → 20 rows/)).toBeTruthy();
    });
});

describe('the preview', () => {
    const isDescribe = (c: { ops: unknown[] }) => (c.ops[0] as { op?: string } | undefined)?.op === 'describe';
    const wait = (ms: number) => new Promise(resolve => { setTimeout(resolve, ms); });

    it('asks once per pause in editing, for the table of the last run', async () => {
        const user = userEvent.setup();
        const { fn, calls } = fakePreview();
        renderEditor([FILTER('a')], fn);
        expect(calls).toHaveLength(0);
        await waitFor(() => expect(calls.filter(c => !isDescribe(c))).toHaveLength(1));
        const source = { runId: 'run1', tableId: `rtb_${'a'.repeat(32)}` };
        expect(calls.find(isDescribe)).toMatchObject({ limit: 1, source });
        const first = calls.filter(c => !isDescribe(c))[0];
        expect(first.source).toEqual(source);
        expect(first.ops).toMatchObject([{ id: 'a', op: 'filter', enabled: true }]);
        expect(first.upToOpId).toBeUndefined();

        await user.click(screen.getByRole('checkbox', { name: 'Use this step: Keep rows that match' }));
        await wait(PREVIEW_DELAY_MS / 4);
        expect(calls.filter(c => !isDescribe(c))).toHaveLength(1);
        await waitFor(() => expect(calls.filter(c => !isDescribe(c))).toHaveLength(2));
        expect(calls.filter(c => !isDescribe(c))[1].ops).toMatchObject([{ id: 'a', enabled: false }]);
    });

    it('stops at the step that is open, unless it is the last one', async () => {
        const user = userEvent.setup();
        const { fn, calls } = fakePreview();
        renderEditor([FILTER('a'), FILTER('b')], fn);
        await user.click(screen.getByRole('button', { name: /1\. Keep rows that match/ }));
        await waitFor(() => expect(calls.find(c => c.upToOpId)?.upToOpId).toBe('a'));
        expect(await screen.findByText('Preview after: Keep rows that match')).toBeTruthy();
    });

    it('shows the first rows and says when it used only part of the table', async () => {
        const { fn } = fakePreview(okResponse({ inputCapped: true, inputRows: 1000, rowCount: 700 }));
        renderEditor([FILTER('a')], fn);
        expect(await screen.findByText('North')).toBeTruthy();
        expect(screen.getByText(/700 rows, 3 columns/)).toBeTruthy();
        expect(screen.getByText(/first 1000 rows of the table only/)).toBeTruthy();
    });

    it('puts the preview-only warnings in plain words', async () => {
        const { fn } = fakePreview(okResponse({ warnings: ['Step 1 (pseudonymise): The preview uses a fixed secret, so the codes differ from the codes a run makes.', 'Step 2 (filter): The rules that come from an earlier step are applied when the automation runs, not in the preview.'] }));
        renderEditor([FILTER('a')], fn);
        expect(await screen.findByText('The preview uses a fixed secret, so the codes are not the codes a real run makes.')).toBeTruthy();
        expect(screen.getByText('The rules from an earlier step are applied when the automation runs, not in this preview.')).toBeTruthy();
    });

    it('asks for a run when no earlier run made the table', () => {
        const { fn, calls } = fakePreview();
        renderEditor([FILTER('a')], fn, { steps: {} });
        expect(screen.getByText('Run the steps before this one once to see a preview.')).toBeTruthy();
        expect(calls).toHaveLength(0);
    });
});

describe('a problem with a setting', () => {
    it('is shown next to the field it names, and marks the step', async () => {
        const user = userEvent.setup();
        const message = 'Step 1 (Group): the column "Regio" is not in the table at this point.';
        const { fn } = fakePreview({ ok: false, opResults: [], findings: [{ code: 'table.column_missing', severity: 'error', path: 'ops[0].by[0]', message, hint: 'Available columns: Region, Amount, Email.' }] });
        renderEditor([GROUP({ by: ['Regio'] })], fn);
        await screen.findByTestId('op-error');
        await user.click(screen.getByRole('button', { name: /1\. Group and count/ }));
        const field = document.querySelector('[data-field="by"]') as HTMLElement;
        expect(field.getAttribute('data-invalid')).toBe('true');
        expect(within(field).getByRole('alert').textContent).toContain('the column "Regio" is not in the table');
        expect((document.querySelector('[data-field="weight"]') as HTMLElement).getAttribute('data-invalid')).toBeNull();
    });

    it('is shown at the field an engine error names', async () => {
        const user = userEvent.setup();
        const result = opResult('op1', [], { ok: false, error: { code: 'table_op_invalid', field: 'weight', message: 'The weight column holds text.' } });
        const { fn } = fakePreview({ ok: false, opResults: [result], findings: [] });
        renderEditor([GROUP({ weight: 'Region' })], fn);
        await screen.findByTestId('op-error');
        await user.click(screen.getByRole('button', { name: /1\. Group and count/ }));
        expect(within(document.querySelector('[data-field="weight"]') as HTMLElement).getByRole('alert').textContent).toBe('The weight column holds text.');
    });
});

describe('the column pickers', () => {
    const optionsOf = (label: string) => within(screen.getByRole('combobox', { name: label })).getAllByRole('option').map(o => o.getAttribute('value'));

    it('offer the columns of the table for the first step', async () => {
        const user = userEvent.setup();
        renderEditor([FILTER('a', { rules: [{ column: 'Region', test: 'equals' }] })]);
        await user.click(screen.getByRole('button', { name: /1\. Keep rows that match/ }));
        expect(optionsOf('Column')).toEqual(['Region', 'Amount', 'Email']);
    });

    it('offer the columns the previous step left, from its settings', async () => {
        const user = userEvent.setup();
        renderEditor([GROUP(), FILTER('b', { rules: [{ column: 'Total', test: 'gt', value: { kind: 'literal', value: 5 } }] })]);
        await user.click(screen.getByRole('button', { name: /2\. Keep rows that match/ }));
        expect(optionsOf('Column')).toEqual(['Region', 'Total', 'n', 'suppressed']);
    });

    it('offer the columns the preview says the previous step left', async () => {
        const user = userEvent.setup();
        const { fn } = fakePreview(okResponse({ opResults: [opResult('op1', ['Region', 'Total']), opResult('b', ['Region', 'Total'])] }));
        renderEditor([GROUP(), FILTER('b', { rules: [{ column: 'Total', test: 'gt', value: { kind: 'literal', value: 5 } }] })], fn);
        await user.click(screen.getByRole('button', { name: /2\. Keep rows that match/ }));
        await waitFor(() => expect(optionsOf('Column')).toEqual(['Region', 'Total']));
    });

    it('put the columns that suit first, and mark personal data', async () => {
        const user = userEvent.setup();
        const description = {
            rowCount: 50, provenance: null,
            columns: [
                { key: 'Region', label: 'Region', kind: 'single' as const, storageType: 'text', filled: 50, empty: 0, distinct: 4, usableAsSplit: true, looksPersonal: false, sampleValues: [] },
                { key: 'Amount', label: 'Amount', kind: 'numeric' as const, storageType: 'number', filled: 50, empty: 0, distinct: 40, usableAsSplit: false, looksPersonal: false, sampleValues: [] },
                { key: 'Email', label: 'Email', kind: 'identifier' as const, storageType: 'text', filled: 50, empty: 0, distinct: 50, usableAsSplit: false, looksPersonal: true, sampleValues: [] },
            ],
        };
        const { fn } = fakePreview(okResponse({ description }));
        renderEditor([op('pivot', 'p')], fn);
        await user.click(screen.getByRole('button', { name: /1\. Cross-tabulate/ }));
        const side = () => screen.getByRole('combobox', { name: 'Down the side' });
        await waitFor(() => expect(within(side()).getByRole('group', { name: 'Suggested' })).toBeTruthy());
        const suggested = within(within(side()).getByRole('group', { name: 'Suggested' })).getAllByRole('option').map(o => o.textContent);
        expect(suggested).toEqual(['Region · choice']);
        const others = within(within(side()).getByRole('group', { name: 'Other columns' })).getAllByRole('option').map(o => o.textContent);
        expect(others).toContain('Email · identifier · personal data');
    });
});

describe('the table to work on', () => {
    it('starts on the nearest earlier step that makes a table', async () => {
        const drafts: Record<string, unknown>[] = [];
        const { fn } = fakePreview();
        render(<TableHarness initial={{ source: null, ops: [] }} preview={fn} onDraft={d => drafts.push(d)} />);
        await waitFor(() => expect(drafts.at(-1)?.source).toEqual({ kind: 'ref', path: 'steps.s1.output.table' }));
    });

    it('offers each sheet of a workbook by name once a run has shown them', () => {
        const output = { ...SAMPLE.steps.s1.output, tablesByName: { Sheet1: HANDLE, Notes: HANDLE } };
        const groups = [{ ...GROUPS[0], sample: output }];
        render(<TableHarness initial={{ source: SOURCE, ops: [] }} preview={fakePreview().fn} groups={groups} />);
        const select = screen.getByRole('combobox', { name: 'Table to work on' });
        expect(within(select).getAllByRole('option').map(o => o.textContent)).toEqual(['Read table', 'Read table · Sheet1', 'Read table · Notes', 'Another reference…']);
    });
});
