import { act, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openSheet } from './sheetTestKit';
import { SAVE_DEBOUNCE_MS } from './useSheet';
import { RESULT_MS } from './useSheetAsk';

/**
 * The inline "Ask AI": select cells, rows or columns, press Ctrl+K (or the
 * round button), type, Enter. The answer comes back as a one-line toast with
 * Undo; the same conversation is in the side panel.
 */

const { sheetApi, assistantApi } = vi.hoisted(() => ({
    sheetApi: { getSheet: vi.fn(), patchSheet: vi.fn(), downloadSheetCsv: vi.fn() },
    assistantApi: { askSheetAssistant: vi.fn() },
}));
vi.mock('./sheetApi', async (original) => ({ ...(await original<typeof import('./sheetApi')>()), ...sheetApi }));
vi.mock('./sheetAssistantApi', () => assistantApi);
vi.mock('../documentsApi', () => ({ getDocument: vi.fn(), updateDocument: vi.fn() }));
vi.mock('../../../api/queries/modelTiers', () => ({ useModelTiersQuery: () => ({ data: {} }) }));
vi.mock('../../../components/renderers/MarkdownRenderer', () => ({
    default: ({ content }: { content: string }) => <div data-testid="markdown">{content}</div>,
}));

const open = (cells: Record<string, string> = {}, readOnly = false) => openSheet(sheetApi.getSheet, cells, readOnly);
const sent = () => assistantApi.askSheetAssistant.mock.calls[0][1];
const INPUT = 'Ask AI about the selection';
const TOTAL = { reply: 'Added a total. It sums A1:A2.', rounds: 1, tier: null, changes: { A3: { before: '', after: '=SUM(A1:A2)' } } };

beforeEach(() => {
    vi.clearAllMocks();
    sheetApi.patchSheet.mockResolvedValue({});
    assistantApi.askSheetAssistant.mockResolvedValue({ reply: 'Done.', changes: {}, rounds: 1, tier: null });
});
afterEach(() => { vi.useRealTimers(); });

describe('inline ask: the selection that travels', () => {
    it('sends a whole column as a bounded range with its kind', async () => {
        const { user, header } = await open({ C1: '1', C2: '2', C3: '3' });
        await user.click(header('C'));
        await user.keyboard('{Control>}k{/Control}');
        const input = screen.getByRole('textbox', { name: INPUT });
        expect(input).toHaveFocus();
        expect(input).toHaveAttribute('placeholder', expect.stringContaining('Ask AI about column C'));
        await user.type(input, 'add a total{Enter}');
        await waitFor(() => expect(assistantApi.askSheetAssistant).toHaveBeenCalledTimes(1));
        expect(assistantApi.askSheetAssistant.mock.calls[0][0]).toBe('doc-1');
        expect(sent()).toMatchObject({ message: 'add a total', selection: 'C1:C3', selectionKind: 'columns' });
    });

    it('sends whole rows as A{from}:Z{to}', async () => {
        const { user, rowHeader } = await open({ A1: '1' });
        await user.click(rowHeader(3));
        await user.keyboard('{Shift>}');
        await user.click(rowHeader(5));
        await user.keyboard('{/Shift}{Control>}k{/Control}');
        await user.type(screen.getByRole('textbox', { name: INPUT }), 'sum each row{Enter}');
        await waitFor(() => expect(assistantApi.askSheetAssistant).toHaveBeenCalled());
        expect(sent()).toMatchObject({ selection: 'A3:Z5', selectionKind: 'rows' });
    });

    it('sends a block as a range and a single cell as a cell', async () => {
        const { user, cell } = await open();
        await user.click(cell('B2'));
        await user.keyboard('{Shift>}{ArrowRight}{ArrowDown}{/Shift}{Control>}k{/Control}');
        await user.type(screen.getByRole('textbox', { name: INPUT }), 'x{Enter}');
        await waitFor(() => expect(assistantApi.askSheetAssistant).toHaveBeenCalled());
        expect(sent()).toMatchObject({ selection: 'B2:C3', selectionKind: 'range' });
    });
});

describe('inline ask: the box', () => {
    it('opens from the round button, which shows only while the grid has focus', async () => {
        const { user, cell } = await open();
        expect(screen.queryByRole('button', { name: 'Ask AI' })).not.toBeInTheDocument();
        await user.click(cell('A1'));
        await user.click(screen.getByRole('button', { name: 'Ask AI' }));
        expect(screen.getByRole('textbox', { name: INPUT })).toHaveFocus();
        expect(screen.queryByRole('button', { name: 'Ask AI' })).not.toBeInTheDocument();
    });

    it('closes on Escape and gives focus back to the grid', async () => {
        const { user, cell } = await open();
        await user.click(cell('A1'));
        await user.keyboard('{Control>}k{/Control}');
        await user.type(screen.getByRole('textbox', { name: INPUT }), 'half a question{Escape}');
        expect(screen.queryByTestId('sheet-ask-box')).not.toBeInTheDocument();
        expect(screen.getByRole('grid')).toHaveFocus();
        expect(assistantApi.askSheetAssistant).not.toHaveBeenCalled();
    });

    it('does not open the side panel, but the question and answer are in its history', async () => {
        const { user, cell } = await open({ A1: '1' });
        await user.click(cell('A1'));
        await user.keyboard('{Control>}k{/Control}');
        await user.type(screen.getByRole('textbox', { name: INPUT }), 'what is this?{Enter}');
        await screen.findByText('Done.');
        expect(screen.queryByTestId('sheet-assistant')).not.toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Open in panel' }));
        expect(screen.getByTestId('sheet-assistant')).toBeInTheDocument();
        expect(screen.getByText('what is this?')).toBeInTheDocument();
        expect(screen.queryByTestId('sheet-ask-box')).not.toBeInTheDocument();
    });

    it('works while viewing only: asking is allowed', async () => {
        const { user, cell } = await open({ A1: '1' }, true);
        await user.click(cell('A1'));
        await user.keyboard('{Control>}k{/Control}');
        expect(screen.getByRole('textbox', { name: INPUT })).toHaveAttribute('placeholder', expect.stringContaining('explain this'));
    });
});

describe('inline ask: working, result, errors', () => {
    it('shimmers the selection and offers Stop while the assistant works', async () => {
        assistantApi.askSheetAssistant.mockImplementation((_id: string, _req: unknown, signal: AbortSignal) => new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')));
        }));
        const { user, cell } = await open();
        await user.click(cell('A1'));
        await user.keyboard('{Control>}k{/Control}');
        await user.type(screen.getByRole('textbox', { name: INPUT }), 'slow one{Enter}');
        expect(await screen.findByTestId('sheet-ask-shimmer')).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Stop' }));
        expect(assistantApi.askSheetAssistant.mock.calls[0][2].aborted).toBe(true);
        await waitFor(() => expect(screen.queryByTestId('sheet-ask-shimmer')).not.toBeInTheDocument());
        expect(screen.getByRole('alert')).toHaveTextContent('Stopped');
    });

    it('turns into a one-line result with Undo, which puts the old values back', async () => {
        assistantApi.askSheetAssistant.mockResolvedValue(TOTAL);
        const { user, cell } = await open({ A1: '1', A2: '2' });
        await user.click(cell('A3'));
        await user.keyboard('{Control>}k{/Control}');
        await user.type(screen.getByRole('textbox', { name: INPUT }), 'add a total{Enter}');
        const toast = await screen.findByRole('status', { name: 'AI result' });
        expect(toast).toHaveTextContent('Added a total.');
        expect(toast).not.toHaveTextContent('It sums');
        expect(cell('A3')).toHaveTextContent('3');
        await user.click(screen.getByRole('button', { name: 'Undo' }));
        expect(cell('A3')).toHaveTextContent('');
        expect(screen.getByRole('status', { name: 'AI result' })).toHaveTextContent('Undone');
        await waitFor(() => expect(sheetApi.patchSheet).toHaveBeenCalledWith('doc-1', { A3: '' }), { timeout: SAVE_DEBOUNCE_MS + 1500 });
    });

    it('opens the side panel with the full answer', async () => {
        assistantApi.askSheetAssistant.mockResolvedValue(TOTAL);
        const { user, cell } = await open({ A1: '1', A2: '2' });
        await user.click(cell('A3'));
        await user.keyboard('{Control>}k{/Control}');
        await user.type(screen.getByRole('textbox', { name: INPUT }), 'add a total{Enter}');
        await user.click(await screen.findByRole('button', { name: 'Open in panel' }));
        expect(await screen.findByTestId('markdown')).toHaveTextContent('Added a total. It sums A1:A2.');
    });

    it('goes away on Escape and on a click elsewhere', async () => {
        const { user, cell } = await open();
        await user.click(cell('A1'));
        await user.keyboard('{Control>}k{/Control}');
        await user.type(screen.getByRole('textbox', { name: INPUT }), 'one{Enter}');
        await screen.findByRole('status', { name: 'AI result' });
        await user.keyboard('{Escape}');
        expect(screen.queryByTestId('sheet-ask-box')).not.toBeInTheDocument();
        await user.keyboard('{Control>}k{/Control}');
        await user.type(screen.getByRole('textbox', { name: INPUT }), 'two{Enter}');
        await screen.findByRole('status', { name: 'AI result' });
        await user.click(cell('B2'));
        expect(screen.queryByTestId('sheet-ask-box')).not.toBeInTheDocument();
    });

    it('dismisses the result by itself after a few seconds', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const { user, cell } = await open();
        await user.click(cell('A1'));
        await user.keyboard('{Control>}k{/Control}');
        await user.type(screen.getByRole('textbox', { name: INPUT }), 'one{Enter}');
        await screen.findByRole('status', { name: 'AI result' });
        act(() => { vi.advanceTimersByTime(RESULT_MS + 100); });
        expect(screen.queryByTestId('sheet-ask-box')).not.toBeInTheDocument();
    });

    it('shows an error inside the same box and keeps the question for another try', async () => {
        assistantApi.askSheetAssistant.mockRejectedValueOnce(new Error('Usage limit reached'));
        const { user, cell } = await open();
        await user.click(cell('A1'));
        await user.keyboard('{Control>}k{/Control}');
        await user.type(screen.getByRole('textbox', { name: INPUT }), 'try this{Enter}');
        expect(await screen.findByRole('alert')).toHaveTextContent('Usage limit reached');
        expect(screen.getByRole('textbox', { name: INPUT })).toHaveValue('try this');
        await user.type(screen.getByRole('textbox', { name: INPUT }), '{Enter}');
        expect(await screen.findByRole('status', { name: 'AI result' })).toHaveTextContent('Done.');
    });
});
