import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withQueryClient } from '../../../test/queryWrapper';
import scopedStorage from '../../../utils/scopedStorage';
import type { StudioDocument } from '../documentQueries';
import SpreadsheetEditor from './SpreadsheetEditor';
import { SAVE_DEBOUNCE_MS } from './useSheet';

const { sheetApi, assistantApi, tiers } = vi.hoisted(() => ({
    sheetApi: { getSheet: vi.fn(), patchSheet: vi.fn(), downloadSheetCsv: vi.fn() },
    assistantApi: { askSheetAssistant: vi.fn() },
    tiers: { data: { fast: { modelId: 'm1' }, thinking: { modelId: 'm2' }, deep_thinking: { modelId: 'm3' } } as Record<string, unknown> },
}));
vi.mock('./sheetApi', async (original) => ({ ...(await original<typeof import('./sheetApi')>()), ...sheetApi }));
vi.mock('./sheetAssistantApi', () => assistantApi);
vi.mock('../documentsApi', () => ({ getDocument: vi.fn(), updateDocument: vi.fn() }));
vi.mock('../../../api/queries/modelTiers', () => ({ useModelTiersQuery: () => ({ data: tiers.data }) }));
vi.mock('../../../components/renderers/MarkdownRenderer', () => ({
    default: ({ content }: { content: string }) => <div data-testid="markdown">{content}</div>,
}));

const DOC = { id: 'doc-1', userId: 'u1', name: 'Budget', docType: 'spreadsheet', bodyHtml: '', versionId: 'v1' } as StudioDocument;

async function open(cells: Record<string, string> = {}, readOnly = false, stored: Record<string, string> = {}) {
    sheetApi.getSheet.mockResolvedValue({ columns: 26, rows: 0, cells, readOnly });
    scopedStorage.setCurrentUser('u1');
    localStorage.clear();
    for (const [k, v] of Object.entries(stored)) scopedStorage.setItem(k, v);
    const user = userEvent.setup();
    const view = render(withQueryClient(<SpreadsheetEditor initial={DOC} people={{}} variant="page" currentUser={{ id: 'u1' }} />));
    await screen.findByRole('grid');
    await user.click(screen.getByRole('button', { name: 'Assistant' }));
    const cell = (name: string) => view.container.querySelector(`[data-cell="${name}"]`) as HTMLElement;
    const ask = async (text: string) => { await user.type(screen.getByLabelText('Message to the assistant'), `${text}{Enter}`); };
    return { user, cell, ask, ...view };
}

beforeEach(() => {
    vi.clearAllMocks();
    sheetApi.patchSheet.mockResolvedValue({});
    assistantApi.askSheetAssistant.mockResolvedValue({ reply: 'Done.', changes: {}, rounds: 1, tier: null });
});

describe('sheet assistant panel', () => {
    it('posts message, selection, history and the chosen tier', async () => {
        const { ask, user, cell } = await open({ A1: '1' }, false, { sheetAssistantTier: 'thinking' });
        await user.click(cell('B2'));
        await ask('Hello');
        await screen.findByText('Done.');
        expect(assistantApi.askSheetAssistant).toHaveBeenCalledWith(
            'doc-1', { message: 'Hello', selection: 'B2', history: [], modelTier: 'thinking' }, expect.any(AbortSignal),
        );
        await ask('And again');
        await waitFor(() => expect(assistantApi.askSheetAssistant).toHaveBeenCalledTimes(2));
        expect(assistantApi.askSheetAssistant.mock.calls[1][1].history).toEqual([
            { role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Done.' },
        ]);
    });

    it('sends a range selection as B2:D9', async () => {
        const { ask, user, cell } = await open();
        await user.click(cell('B2'));
        await user.keyboard('{Shift>}{ArrowRight}{ArrowRight}{ArrowDown}{/Shift}');
        expect(screen.getByTestId('assistant-selection')).toHaveTextContent('Selection: B2:D3');
        await user.click(screen.getByLabelText('Message to the assistant'));
        await ask('x');
        await waitFor(() => expect(assistantApi.askSheetAssistant.mock.calls[0][1].selection).toBe('B2:D3'));
        expect(assistantApi.askSheetAssistant.mock.calls[0][1].modelTier).toBe('auto');
    });

    it('sends the queued edits before the question', async () => {
        const { ask, user, cell } = await open();
        await user.click(cell('A1'));
        await user.keyboard('5{Enter}');
        await ask('Sum it');
        await screen.findByText('Done.');
        expect(sheetApi.patchSheet).toHaveBeenCalledWith('doc-1', { A1: '5' });
        expect(sheetApi.patchSheet.mock.invocationCallOrder[0]).toBeLessThan(assistantApi.askSheetAssistant.mock.invocationCallOrder[0]);
    });

    it('applies the changes locally without saving, highlights them, and Undo saves the old values', async () => {
        assistantApi.askSheetAssistant.mockResolvedValue({
            reply: 'Added a total.', rounds: 2, tier: 'thinking',
            changes: { A3: { before: '', after: '=SUM(A1:A2)' }, B1: { before: 'old', after: 'new' } },
        });
        const { ask, user, cell } = await open({ A1: '1', A2: '2', B1: 'old' });
        await ask('Add a total row');
        await screen.findByText('Added a total.');
        expect(cell('A3')).toHaveTextContent('3');
        expect(cell('B1')).toHaveTextContent('new');
        expect(cell('A3')).toHaveAttribute('data-flash', 'true');
        expect(screen.getByTestId('assistant-changes')).toHaveTextContent('Changed 2 cells');
        expect(screen.getByTestId('assistant-tier')).toHaveTextContent('Auto · Think');
        expect(sheetApi.patchSheet).not.toHaveBeenCalled();

        await user.click(screen.getByRole('button', { name: 'Undo' }));
        expect(cell('B1')).toHaveTextContent('old');
        expect(cell('A3')).toHaveTextContent('');
        await waitFor(() => expect(sheetApi.patchSheet).toHaveBeenCalledWith('doc-1', { A3: '', B1: 'old' }), { timeout: SAVE_DEBOUNCE_MS + 1500 });
        expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
        expect(screen.getByText('Undone')).toBeInTheDocument();
    });

});

describe('sheet assistant panel errors and states', () => {
    it('shows the server message when the assistant fails', async () => {
        assistantApi.askSheetAssistant.mockRejectedValue(new Error('Usage limit reached'));
        const { ask } = await open();
        await ask('Hi');
        expect(await screen.findByRole('alert')).toHaveTextContent('Usage limit reached');
    });

    it('a suggestion chip sends at once', async () => {
        const { user } = await open();
        await user.click(screen.getByRole('button', { name: 'Find and fix errors' }));
        await waitFor(() => expect(assistantApi.askSheetAssistant).toHaveBeenCalledTimes(1));
        expect(assistantApi.askSheetAssistant.mock.calls[0][1].message).toBe('Find and fix errors');
    });

    it('Stop aborts the request and reloads the sheet', async () => {
        assistantApi.askSheetAssistant.mockImplementation((_id: string, _req: unknown, signal: AbortSignal) => new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }));
        const { ask, user } = await open({ A1: '1' });
        await ask('Slow one');
        expect(await screen.findByText('Working on your sheet…')).toBeInTheDocument();
        sheetApi.getSheet.mockClear();
        await user.click(screen.getByRole('button', { name: 'Stop' }));
        expect(await screen.findByText(/^Stopped\./)).toBeInTheDocument();
        expect(assistantApi.askSheetAssistant.mock.calls[0][2].aborted).toBe(true);
        await waitFor(() => expect(sheetApi.getSheet).toHaveBeenCalled());
        expect(screen.queryByText('Working on your sheet…')).not.toBeInTheDocument();
    });

    it('a viewer can ask; nothing changes and there is no Undo', async () => {
        const { ask } = await open({ A1: '1' }, true);
        expect(screen.getByText(/View only: I can answer/)).toBeInTheDocument();
        await ask('What is in A1?');
        await screen.findByText('Done.');
        expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
    });

    it('remembers whether the panel is open', async () => {
        const { user } = await open();
        expect(localStorage.getItem('sheetAssistantOpen')).toBe('1');
        await user.click(screen.getByRole('button', { name: 'Close the assistant' }));
        expect(localStorage.getItem('sheetAssistantOpen')).toBe('0');
    });
});
