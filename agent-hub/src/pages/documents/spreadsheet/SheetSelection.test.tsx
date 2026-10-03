import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openSheet } from './sheetTestKit';
import { SAVE_DEBOUNCE_MS } from './useSheet';

/**
 * Selecting the way a person thinks of it: whole columns and rows from their
 * headers, the used range, the numbers of a selection at a glance, and the
 * keyboard shortcuts that fill and add up without asking anyone.
 */

const { sheetApi } = vi.hoisted(() => ({
    sheetApi: { getSheet: vi.fn(), patchSheet: vi.fn(), downloadSheetCsv: vi.fn() },
}));
vi.mock('./sheetApi', async (original) => ({ ...(await original<typeof import('./sheetApi')>()), ...sheetApi }));
vi.mock('../documentsApi', () => ({ getDocument: vi.fn(), updateDocument: vi.fn() }));
vi.mock('../../../api/queries/modelTiers', () => ({ useModelTiersQuery: () => ({ data: {} }) }));

const open = (cells: Record<string, string> = {}, readOnly = false) => openSheet(sheetApi.getSheet, cells, readOnly);
const SAVED = { timeout: SAVE_DEBOUNCE_MS + 1500 };

beforeEach(() => {
    vi.clearAllMocks();
    sheetApi.patchSheet.mockResolvedValue({});
});

describe('whole column and row selection', () => {
    it('selects the whole column when its letter is clicked, and tints the header', async () => {
        const { user, header, cell, label } = await open({ C1: '1' });
        await user.click(header('C'));
        expect(header('C')).toHaveAttribute('aria-selected', 'true');
        expect(header('D')).toHaveAttribute('aria-selected', 'false');
        expect(cell('C1')).toHaveAttribute('aria-selected', 'true');
        expect(cell('C50')).toHaveAttribute('aria-selected', 'true');
        expect(cell('D1')).toHaveAttribute('aria-selected', 'false');
        expect(label()).toContain('column C');
        expect(screen.getByTestId('formula-bar-cell')).toHaveTextContent('C1');
    });

    it('selects the whole row when its number is clicked', async () => {
        const { user, rowHeader, cell, label } = await open();
        await user.click(rowHeader(3));
        expect(rowHeader(3)).toHaveAttribute('aria-selected', 'true');
        expect(cell('A3')).toHaveAttribute('aria-selected', 'true');
        expect(cell('Z3')).toHaveAttribute('aria-selected', 'true');
        expect(cell('A4')).toHaveAttribute('aria-selected', 'false');
        expect(label()).toContain('row 3');
    });

    it('extends to a block of columns and rows with shift-click', async () => {
        const { user, header, rowHeader, label, cell } = await open();
        await user.click(header('B'));
        await user.keyboard('{Shift>}');
        await user.click(header('D'));
        await user.keyboard('{/Shift}');
        expect(label()).toContain('columns B–D');
        expect(cell('C10')).toHaveAttribute('aria-selected', 'true');
        await user.click(rowHeader(2));
        await user.keyboard('{Shift>}');
        await user.click(rowHeader(4));
        await user.keyboard('{/Shift}');
        expect(label()).toContain('rows 2–4');
    });

    it('selects columns by dragging across the headers', async () => {
        const { user, header, label } = await open();
        await user.pointer([{ keys: '[MouseLeft>]', target: header('B') }, { target: header('C') }, { target: header('D') }, { keys: '[/MouseLeft]' }]);
        expect(label()).toContain('columns B–D');
    });

    it('Ctrl+Space selects the columns of the selection and Shift+Space its rows', async () => {
        const { user, cell, label } = await open();
        await user.click(cell('B2'));
        await user.keyboard('{Shift>}{ArrowRight}{/Shift}');
        await user.keyboard('{Control>} {/Control}');
        expect(label()).toContain('columns B–C');
        await user.click(cell('B2'));
        await user.keyboard('{Shift>}{ArrowDown}{/Shift}');
        await user.keyboard('{Shift>} {/Shift}');
        expect(label()).toContain('rows 2–3');
    });

    it('Ctrl+A selects the used range', async () => {
        const { user, cell, label } = await open({ A1: '1', C4: 'x' });
        await user.click(cell('B2'));
        await user.keyboard('{Control>}a{/Control}');
        expect(label()).toContain('A1:C4');
    });
});

describe('selection statistics', () => {
    it('shows Sum, Average and Count of the numbers, and copies a figure on click', async () => {
        const { user, cell } = await open({ A1: '1', A2: '2', A3: '=A1+A2', A4: 'text' });
        await user.click(cell('A1'));
        expect(screen.queryByTestId('stat-sum')).not.toBeInTheDocument();
        await user.keyboard('{Shift>}{ArrowDown}{ArrowDown}{ArrowDown}{/Shift}');
        expect(screen.getByTestId('stat-sum')).toHaveTextContent('Sum6');
        expect(screen.getByTestId('stat-average')).toHaveTextContent('Average2');
        expect(screen.getByTestId('stat-count')).toHaveTextContent('Count3');
        expect(screen.getByTestId('sheet-status-bar')).toHaveTextContent('4 cells');
        await user.click(screen.getByTestId('stat-sum'));
        expect(await navigator.clipboard.readText()).toBe('6');
        expect(screen.getByTestId('stat-sum')).toHaveTextContent('Copied');
    });

    it('counts a whole column over its used rows', async () => {
        const { user, header } = await open({ B1: '10', B2: '20.5' });
        await user.click(header('B'));
        expect(screen.getByTestId('stat-sum')).toHaveTextContent('30.5');
        expect(screen.getByTestId('stat-count')).toHaveTextContent('Count2');
    });
});

describe('fill and AutoSum from the keyboard', () => {
    it('Ctrl+D fills the first row down with shifted formulas, in one save', async () => {
        const { user, cell } = await open({ A1: '1', A2: '2', A3: '3', B1: '=A1*2' });
        await user.click(cell('B1'));
        await user.keyboard('{Shift>}{ArrowDown}{ArrowDown}{/Shift}');
        await user.keyboard('{Control>}d{/Control}');
        expect(cell('B3')).toHaveTextContent('6');
        await waitFor(() => expect(sheetApi.patchSheet).toHaveBeenCalledTimes(1), SAVED);
        expect(sheetApi.patchSheet).toHaveBeenCalledWith('doc-1', { B2: '=A2*2', B3: '=A3*2' });
    });

    it('Ctrl+D on one cell copies the cell above it', async () => {
        const { user, cell } = await open({ A1: '=B1+1', B1: '5' });
        await user.click(cell('A2'));
        await user.keyboard('{Control>}d{/Control}');
        await waitFor(() => expect(sheetApi.patchSheet).toHaveBeenCalledWith('doc-1', { A2: '=B2+1' }), SAVED);
    });

    it('Ctrl+R fills the first column to the right', async () => {
        const { user, cell } = await open({ A1: '=A2+1', A2: '1', B2: '2', C2: '3' });
        await user.click(cell('A1'));
        await user.keyboard('{Shift>}{ArrowRight}{ArrowRight}{/Shift}');
        await user.keyboard('{Control>}r{/Control}');
        await waitFor(() => expect(sheetApi.patchSheet).toHaveBeenCalledWith('doc-1', { B1: '=B2+1', C1: '=C2+1' }), SAVED);
    });

    it('Alt+= on an empty cell sums the numbers above it', async () => {
        const { user, cell } = await open({ A1: 'Total', A2: '1', A3: '2', A4: '3' });
        await user.click(cell('A5'));
        await user.keyboard('{Alt>}={/Alt}');
        expect(cell('A5')).toHaveTextContent('6');
        await waitFor(() => expect(sheetApi.patchSheet).toHaveBeenCalledWith('doc-1', { A5: '=SUM(A2:A4)' }), SAVED);
    });

    it('Alt+= sums to the left when nothing numeric is above', async () => {
        const { user, cell } = await open({ A1: '1', B1: '2' });
        await user.click(cell('C1'));
        await user.keyboard('{Alt>}={/Alt}');
        await waitFor(() => expect(sheetApi.patchSheet).toHaveBeenCalledWith('doc-1', { C1: '=SUM(A1:B1)' }), SAVED);
    });

    it('Alt+= on a selected column range with an empty last cell totals the cells above', async () => {
        const { user, cell } = await open({ A1: '1', A2: '2' });
        await user.click(cell('A1'));
        await user.keyboard('{Shift>}{ArrowDown}{ArrowDown}{/Shift}');
        await user.keyboard('{Alt>}={/Alt}');
        await waitFor(() => expect(sheetApi.patchSheet).toHaveBeenCalledWith('doc-1', { A3: '=SUM(A1:A2)' }), SAVED);
    });

    it('does nothing on a cell that is not empty', async () => {
        const { user, cell } = await open({ A1: '1', A2: '5' });
        await user.click(cell('A2'));
        await user.keyboard('{Alt>}={/Alt}');
        expect(cell('A2')).toHaveTextContent('5');
        expect(sheetApi.patchSheet).not.toHaveBeenCalled();
    });
});

describe('a view-only sheet', () => {
    it('blocks the editing shortcuts but still shows the statistics', async () => {
        const { user, cell } = await open({ A1: '1', A2: '2', B1: '=A1*2' }, true);
        await user.click(cell('B1'));
        await user.keyboard('{Shift>}{ArrowDown}{/Shift}');
        await user.keyboard('{Control>}d{/Control}');
        await user.click(cell('A3'));
        await user.keyboard('{Alt>}={/Alt}');
        expect(cell('A3')).toHaveTextContent('');
        expect(cell('B2')).toHaveTextContent('');
        await user.click(cell('A1'));
        await user.keyboard('{Shift>}{ArrowDown}{/Shift}');
        expect(screen.getByTestId('stat-sum')).toHaveTextContent('Sum3');
        await new Promise((r) => { setTimeout(r, SAVE_DEBOUNCE_MS + 200); });
        expect(sheetApi.patchSheet).not.toHaveBeenCalled();
    });
});
