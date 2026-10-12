import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OPEN_MEMORY_PANEL_EVENT } from '../../../utils/memoryMode';
import { toast } from '../../shared/Toast';
import { deleteMemory, fetchRecentMemories } from './memoryApi';
import RememberedChip from './RememberedChip';

vi.mock('./memoryApi', () => ({ fetchRecentMemories: vi.fn(), deleteMemory: vi.fn() }));

const fetchRecent = vi.mocked(fetchRecentMemories);
const remove = vi.mocked(deleteMemory);
const SINCE = '2026-10-10T10:00:00.000Z';

beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fetchRecent.mockReset();
    remove.mockReset();
    remove.mockResolvedValue(undefined);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

async function showChip(items: Array<{ id: string; type: string; content: string }>) {
    fetchRecent.mockResolvedValue(items);
    render(<RememberedChip conversationId="c1" since={SINCE} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
}

describe('RememberedChip', () => {
    it('shows nothing until something was saved', async () => {
        fetchRecent.mockResolvedValue([]);
        render(<RememberedChip conversationId="c1" since={SINCE} />);
        await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
        expect(screen.queryByTestId('memory-remembered')).not.toBeInTheDocument();
    });

    it('names the first memory and counts the rest', async () => {
        await showChip([
            { id: 'm1', type: 'fact', content: 'Lives in Utrecht' },
            { id: 'm2', type: 'preference', content: 'Prefers short answers' },
            { id: 'm3', type: 'person', content: 'Anouk is in finance' },
        ]);
        expect(screen.getByTestId('memory-remembered')).toHaveTextContent('Remembered: Lives in Utrecht (+2 more)');
    });

    it('Undo forgets every new memory, confirms with a toast and removes the chip', async () => {
        const success = vi.spyOn(toast, 'success').mockReturnValue(1);
        await showChip([
            { id: 'm1', type: 'fact', content: 'Lives in Utrecht' },
            { id: 'm2', type: 'fact', content: 'Has two cats' },
        ]);
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        await user.click(screen.getByRole('button', { name: 'Undo' }));
        expect(remove.mock.calls.map((c) => c[0])).toEqual(['m1', 'm2']);
        // Only the chip's Undo asks the server to restore what a memory replaced.
        expect(remove.mock.calls.every((c) => c[1]?.undo === true)).toBe(true);
        await waitFor(() => expect(success).toHaveBeenCalledWith('Forgotten again (2 memories).'));
        await waitFor(() => expect(screen.queryByTestId('memory-remembered')).not.toBeInTheDocument());
    });

    it('a failed Undo keeps the chip and says so', async () => {
        const error = vi.spyOn(toast, 'error').mockReturnValue(1);
        remove.mockRejectedValue(new Error('nope'));
        await showChip([{ id: 'm1', type: 'fact', content: 'Lives in Utrecht' }]);
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        await user.click(screen.getByRole('button', { name: 'Undo' }));
        await waitFor(() => expect(error).toHaveBeenCalled());
        expect(screen.getByTestId('memory-remembered')).toBeInTheDocument();
    });

    it('Edit asks the app to open the memory panel', async () => {
        let opened = 0;
        const onOpen = () => { opened += 1; };
        window.addEventListener(OPEN_MEMORY_PANEL_EVENT, onOpen);
        await showChip([{ id: 'm1', type: 'fact', content: 'Lives in Utrecht' }]);
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        await user.click(screen.getByRole('button', { name: 'Edit' }));
        window.removeEventListener(OPEN_MEMORY_PANEL_EVENT, onOpen);
        expect(opened).toBe(1);
    });
});
