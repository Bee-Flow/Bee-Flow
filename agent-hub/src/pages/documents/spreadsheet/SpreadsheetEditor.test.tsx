import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withQueryClient } from '../../../test/queryWrapper';
import type { StudioDocument } from '../documentQueries';
import SpreadsheetEditor from './SpreadsheetEditor';

/**
 * The spreadsheet as a person meets it: a grid moved and edited with the
 * keyboard, formulas that follow their cells, cells saved in one batch, a
 * failed save that says so and can be retried, text pasted from another
 * spreadsheet, and a viewer who can read but not change anything.
 */

const { sheetApi, docApi } = vi.hoisted(() => ({
    sheetApi: { getSheet: vi.fn(), patchSheet: vi.fn(), downloadSheetCsv: vi.fn() },
    docApi: { getDocument: vi.fn(), updateDocument: vi.fn() },
}));
vi.mock('./sheetApi', async (original) => ({ ...(await original<typeof import('./sheetApi')>()), ...sheetApi }));
vi.mock('../documentsApi', () => docApi);

const DOC = { id: 'doc-1', userId: 'u1', name: 'Budget', docType: 'spreadsheet', bodyHtml: '', versionId: 'v1' } as StudioDocument;

function load(cells: Record<string, string> = {}, readOnly = false) {
    sheetApi.getSheet.mockResolvedValue({ columns: 26, rows: 0, cells, readOnly });
}

/** Copy as the browser does it: a copy event whose clipboardData the page fills. (user.copy() only copies a text selection.) */
function copiedText(): string {
    const store: Record<string, string> = {};
    const event = new Event('copy', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { setData: (type: string, v: string) => { store[type] = v; } } });
    act(() => { screen.getByRole('grid').dispatchEvent(event); });
    return store['text/plain'];
}

async function open(onBack?: () => void) {
    const user = userEvent.setup();
    const view = render(withQueryClient(
        <SpreadsheetEditor key={DOC.id} initial={DOC} people={{}} variant="page" currentUser={{ id: 'u1' }} onBack={onBack} />,
    ));
    await screen.findByRole('grid');
    const cell = (name: string) => view.container.querySelector(`[data-cell="${name}"]`) as HTMLElement;
    const selected = () => view.container.querySelector('[role="gridcell"][aria-selected="true"]')?.getAttribute('data-cell') ?? null;
    return { user, cell, selected, ...view };
}

beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sheetApi.patchSheet.mockResolvedValue({});
    docApi.getDocument.mockResolvedValue({ ...DOC, versionId: 'v2' });
    docApi.updateDocument.mockImplementation(async (_id: string, patch: { name: string }) => ({ ...DOC, name: patch.name, versionId: 'v3' }));
    load();
});

it('shows a skeleton while loading, then the grid with its headers and a hint', async () => {
    const { container } = await open();
    expect(screen.getByRole('columnheader', { name: 'A' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Z' })).toBeInTheDocument();
    expect(container.querySelectorAll('tbody tr')).toHaveLength(50);
    expect(screen.getByTestId('sheet-empty-hint')).toHaveTextContent('=SUM(A1:A5)');
});

it('says so when the sheet cannot be loaded, and loads it on Retry', async () => {
    sheetApi.getSheet.mockRejectedValueOnce(new Error('boom'));
    const user = userEvent.setup();
    const onBack = vi.fn();
    render(withQueryClient(<SpreadsheetEditor initial={DOC} people={{}} variant="page" currentUser={null} onBack={onBack} />));
    expect(await screen.findByTestId('sheet-load-error')).toHaveTextContent('Could not load the spreadsheet.');
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('grid')).toBeInTheDocument();
});

describe('SpreadsheetEditor keyboard', () => {
    it('undoes and redoes manual edits with Ctrl+Z and Ctrl+Y', async () => {
        const { user, cell } = await open();
        await user.click(cell('A1'));
        await user.keyboard('1{Enter}2{Enter}');
        expect(cell('A1')).toHaveTextContent('1');
        expect(cell('A2')).toHaveTextContent('2');
        await user.keyboard('{Control>}z{/Control}');
        expect(cell('A2')).toHaveTextContent('');
        await user.keyboard('{Control>}z{/Control}');
        expect(cell('A1')).toHaveTextContent('');
        await user.keyboard('{Control>}y{/Control}');
        expect(cell('A1')).toHaveTextContent('1');
        await user.click(document.body);
        await waitFor(() => expect(sheetApi.patchSheet).toHaveBeenCalledWith('doc-1', { A1: '1', A2: '' }));
    });

    it('redoes with Ctrl+Shift+Z', async () => {
        load({ A1: 'x' });
        const { user, cell } = await open();
        await user.click(cell('A1'));
        await user.keyboard('y{Enter}');
        expect(cell('A1')).toHaveTextContent('y');
        await user.keyboard('{Control>}z{/Control}');
        expect(cell('A1')).toHaveTextContent('x');
        await user.keyboard('{Control>}{Shift>}z{/Shift}{/Control}');
        expect(cell('A1')).toHaveTextContent('y');
    });

    it('moves with the arrows and Tab, and stays inside the sheet', async () => {
        const { user, cell, selected } = await open();
        await user.click(cell('A1'));
        await user.keyboard('{ArrowUp}{ArrowLeft}');
        expect(selected()).toBe('A1');
        await user.keyboard('{ArrowRight}{ArrowDown}');
        expect(selected()).toBe('B2');
        expect(cell('B2')).toHaveAttribute('aria-selected', 'true');
        await user.keyboard('{Tab}');
        expect(selected()).toBe('C2');
        await user.keyboard('{Shift>}{Tab}{/Shift}');
        expect(selected()).toBe('B2');
    });

    it('types to replace, commits with Enter and moves down', async () => {
        const { user, cell, selected } = await open();
        await user.click(cell('A1'));
        await user.keyboard('hello{Enter}');
        expect(cell('A1')).toHaveTextContent('hello');
        expect(selected()).toBe('A2');
        expect(screen.queryByLabelText('Cell A1')).not.toBeInTheDocument();
        // The grid has the focus again: the next key still works.
        await user.keyboard('42{Tab}');
        expect(cell('A2')).toHaveTextContent('42');
        expect(selected()).toBe('B2');
    });

    it('Escape drops an edit, F2 edits keeping the content, Enter edits too', async () => {
        load({ A1: 'abc' });
        const { user, cell } = await open();
        await user.click(cell('A1'));
        await user.keyboard('xyz{Escape}');
        expect(cell('A1')).toHaveTextContent('abc');
        await user.keyboard('{F2}!{Enter}');
        expect(cell('A1')).toHaveTextContent('abc!');
        await user.keyboard('{ArrowUp}{Enter}');
        expect(screen.getByLabelText('Cell A1')).toHaveValue('abc!');
    });

    it('edits on double-click', async () => {
        load({ B2: 'two' });
        const { user, cell } = await open();
        await user.dblClick(cell('B2'));
        expect(screen.getByLabelText('Cell B2')).toHaveValue('two');
    });

    it('Delete and Backspace clear the selection', async () => {
        load({ A1: '1', A2: '2' });
        const { user, cell } = await open();
        await user.click(cell('A1'));
        await user.keyboard('{Delete}');
        expect(cell('A1')).toHaveTextContent('');
        await user.keyboard('{ArrowDown}{Backspace}');
        expect(cell('A2')).toHaveTextContent('');
    });

    it('Shift+arrows and a drag select a range that Delete clears', async () => {
        load({ A1: '1', B1: '2', A2: '3', B2: '4', C3: 'keep' });
        const { user, cell } = await open();
        await user.click(cell('A1'));
        await user.keyboard('{Shift>}{ArrowRight}{ArrowDown}{/Shift}');
        for (const n of ['A1', 'B1', 'A2', 'B2']) expect(cell(n)).toHaveAttribute('aria-selected', 'true');
        expect(cell('C3')).toHaveAttribute('aria-selected', 'false');
        await user.keyboard('{Delete}');
        expect(cell('B2')).toHaveTextContent('');
        expect(cell('C3')).toHaveTextContent('keep');

        await user.pointer([{ keys: '[MouseLeft>]', target: cell('C3') }, { target: cell('D4') }, { keys: '[/MouseLeft]' }]);
        expect(cell('D4')).toHaveAttribute('aria-selected', 'true');
        expect(cell('E5')).toHaveAttribute('aria-selected', 'false');
    });
});

describe('SpreadsheetEditor formulas', () => {
    it('recomputes =A1+A2 when A1 changes', async () => {
        load({ A1: '1', A2: '2', A3: '=A1+A2' });
        const { user, cell } = await open();
        expect(cell('A3')).toHaveTextContent('3');
        await user.click(cell('A1'));
        await user.keyboard('10{Enter}');
        expect(cell('A3')).toHaveTextContent('12');
    });

    it('aligns numbers to the right and text to the left', async () => {
        load({ A1: '5', B1: 'five' });
        const { cell } = await open();
        expect(cell('A1').firstElementChild).toHaveClass('text-right');
        expect(cell('B1').firstElementChild).toHaveClass('text-left');
    });

    it('shows an error cell with its code, in the error colour, and explains it', async () => {
        load({ A1: '=1/0' });
        const { cell } = await open();
        expect(cell('A1')).toHaveTextContent('#DIV/0!');
        expect(cell('A1').firstElementChild).toHaveClass('text-[var(--error)]');
        expect(cell('A1')).toHaveAttribute('title', expect.stringContaining('Division by zero'));
    });

    it('highlights the cells the formula being edited reads', async () => {
        const { user, cell } = await open();
        await user.click(cell('D1'));
        await user.keyboard('=SUM(A1:A2)+B1');
        for (const n of ['A1', 'A2', 'B1']) expect(cell(n).className).toContain('--warning');
        expect(cell('A3').className).not.toContain('--warning');
        await user.keyboard('{Escape}');
        expect(cell('A1').className).not.toContain('--warning');
    });
});

describe('SpreadsheetEditor formula bar', () => {
    it('is hidden by default and can be toggled', async () => {
        const { user } = await open();
        expect(screen.queryByRole('textbox', { name: 'Formula bar' })).not.toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Show formula bar' }));
        expect(screen.getByRole('textbox', { name: 'Formula bar' })).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Hide formula bar' }));
        expect(screen.queryByRole('textbox', { name: 'Formula bar' })).not.toBeInTheDocument();
    });

    it('shows the raw formula of the selected cell and edits it', async () => {
        load({ A1: '2', B1: '=A1*3' });
        const { user, cell } = await open();
        await user.click(screen.getByRole('button', { name: 'Show formula bar' }));
        await user.click(cell('B1'));
        const bar = screen.getByRole('textbox', { name: 'Formula bar' });
        expect(bar).toHaveValue('=A1*3');
        await user.clear(bar);
        await user.type(bar, '=A1*4{Enter}');
        expect(cell('B1')).toHaveTextContent('8');
        expect(screen.getByTestId('formula-bar-cell')).toHaveTextContent('B2');
    });

    it('offers the functions that match what is being typed', async () => {
        const { user, cell } = await open();
        await user.click(screen.getByRole('button', { name: 'Show formula bar' }));
        await user.click(cell('A1'));
        await user.type(screen.getByRole('textbox', { name: 'Formula bar' }), '=SU');
        await user.click(screen.getByRole('button', { name: 'SUM' }));
        expect(screen.getByRole('textbox', { name: 'Formula bar' })).toHaveValue('=SUM(');
    });
});

describe('SpreadsheetEditor saving', () => {
    it('sends several edits as one PATCH with all the cells', async () => {
        const { user, cell } = await open();
        await user.click(cell('A1'));
        await user.keyboard('1{Enter}2{Enter}=A1+A2{Enter}');
        expect(sheetApi.patchSheet).not.toHaveBeenCalled();
        expect(screen.getByTestId('document-save-state')).toHaveAttribute('data-state', 'unsaved');
        await user.click(document.body);
        await waitFor(() => expect(sheetApi.patchSheet).toHaveBeenCalledTimes(1));
        expect(sheetApi.patchSheet).toHaveBeenCalledWith('doc-1', { A1: '1', A2: '2', A3: '=A1+A2' });
        await waitFor(() => expect(screen.getByTestId('document-save-state')).toHaveAttribute('data-state', 'saved'));
    });

    it('says "Not saved" when a save fails, keeps the edit, and saves again on Retry', async () => {
        sheetApi.patchSheet.mockRejectedValueOnce(new Error('Server is down'));
        const { user, cell } = await open();
        await user.click(cell('A1'));
        await user.keyboard('7{Enter}');
        await user.click(document.body);
        const chip = await screen.findByRole('button', { name: /Not saved/ });
        expect(screen.getByRole('alert')).toHaveTextContent('Server is down');
        expect(cell('A1')).toHaveTextContent('7');
        await user.click(chip);
        await waitFor(() => expect(sheetApi.patchSheet).toHaveBeenCalledTimes(2));
        expect(sheetApi.patchSheet).toHaveBeenLastCalledWith('doc-1', { A1: '7' });
        await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    });

    it('saves what is queued before going back', async () => {
        const onBack = vi.fn();
        const { user, cell } = await open(onBack);
        await user.click(cell('B2'));
        await user.keyboard('x{Enter}');
        await user.click(screen.getByRole('button', { name: 'Back to Documents' }));
        await waitFor(() => expect(onBack).toHaveBeenCalled());
        expect(sheetApi.patchSheet).toHaveBeenCalledWith('doc-1', { B2: 'x' });
    });

    it('renames the document on the newest revision', async () => {
        const { user } = await open();
        await user.click(screen.getByTestId('studio-section-title'));
        const input = screen.getByTestId('studio-section-title-input');
        await user.clear(input);
        await user.type(input, 'Plan{Enter}');
        await waitFor(() => expect(docApi.updateDocument).toHaveBeenCalledWith('doc-1', { name: 'Plan', expectedVersionId: 'v2' }));
        expect(await screen.findByTestId('studio-section-title')).toHaveTextContent('Plan');
    });

    it('downloads the CSV after saving', async () => {
        const { user, cell } = await open();
        await user.click(cell('A1'));
        await user.keyboard('1{Enter}');
        await user.click(screen.getByRole('button', { name: 'Download CSV' }));
        await waitFor(() => expect(sheetApi.downloadSheetCsv).toHaveBeenCalledWith('doc-1', 'Budget'));
        expect(sheetApi.patchSheet).toHaveBeenCalledWith('doc-1', { A1: '1' });
    });
});

describe('SpreadsheetEditor copy and paste', () => {
    it('copies the selected range as tab-separated raw values', async () => {
        load({ A1: 'a', B1: '=1+1', A2: 'c', B2: 'd' });
        const { user, cell } = await open();
        await user.click(cell('A1'));
        await user.keyboard('{Shift>}{ArrowRight}{ArrowDown}{/Shift}');
        expect(copiedText()).toBe('a\t=1+1\nc\td');
    });

    it('pastes tab-separated text from the selected cell', async () => {
        const { user, cell } = await open();
        await user.click(cell('B2'));
        await user.paste('1\t2\n3\t=B2+C2');
        expect(cell('B2')).toHaveTextContent('1');
        expect(cell('C2')).toHaveTextContent('2');
        expect(cell('B3')).toHaveTextContent('3');
        expect(cell('C3')).toHaveTextContent('3');
        await user.click(document.body);
        await waitFor(() => expect(sheetApi.patchSheet).toHaveBeenCalledWith('doc-1', { B2: '1', C2: '2', B3: '3', C3: '=B2+C2' }));
    });
});

it('adds 50 rows', async () => {
    const { user, container } = await open();
    await user.click(screen.getByRole('button', { name: 'Add 50 rows' }));
    expect(container.querySelectorAll('tbody tr')).toHaveLength(100);
});

it('always shows 20 rows beyond the last used one', async () => {
    load({ A60: 'x' });
    const { container } = await open();
    expect(container.querySelectorAll('tbody tr')).toHaveLength(80);
});

describe('SpreadsheetEditor view only', () => {
    beforeEach(() => load({ A1: 'locked' }, true));

    it('lets a viewer move and read but not edit', async () => {
        const { user, cell, selected } = await open();
        expect(screen.getByTestId('sheet-view-only')).toHaveTextContent('View only');
        expect(screen.queryByTestId('sheet-empty-hint')).not.toBeInTheDocument();
        await user.click(cell('A1'));
        await user.keyboard('x{Enter}{F2}{Delete}');
        expect(screen.queryByLabelText('Cell A1')).not.toBeInTheDocument();
        expect(cell('A1')).toHaveTextContent('locked');
        await user.keyboard('{ArrowRight}');
        expect(selected()).toBe('B1');
        await user.paste('nope');
        expect(cell('B1')).toHaveTextContent('');
        await user.click(screen.getByRole('button', { name: 'Show formula bar' }));
        expect(screen.getByRole('textbox', { name: 'Formula bar' })).toHaveAttribute('readonly');
        await user.click(document.body);
        expect(sheetApi.patchSheet).not.toHaveBeenCalled();
    });

    it('still copies', async () => {
        const { user, cell } = await open();
        await user.click(cell('A1'));
        expect(copiedText()).toBe('locked');
    });
});
