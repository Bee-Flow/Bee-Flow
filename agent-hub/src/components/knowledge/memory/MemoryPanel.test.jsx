import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import MemoryPanel from './MemoryPanel';

/**
 * The Manage-memories panel.
 *
 * Three defects are pinned here, all of the same shape — the panel knew
 * something had gone wrong and told the user nothing:
 *
 *   1. STICKY ERROR. `fetchMemories` never reset `error`, and the render checks
 *      `error` before the list, so one transient blip pinned "Failed to load
 *      memories" on screen forever; every later successful fetch was invisible
 *      until the panel was remounted.
 *
 *   2. SILENT MUTATIONS. Delete, edit, add, clear and export all acted only
 *      `if (res.ok)`. A 403 or a 500 produced no feedback at all — the row
 *      simply stayed put.
 *
 *   3. A VIEWER COULD REACH BULK DELETE. `canEdit` hid Add, Edit, Delete and
 *      Clear All, but not the Select toggle or the bulk-delete button, so a
 *      read-only project member could select everything, press Delete and watch
 *      nothing happen.
 */

const PAGE = (items, extra = {}) => ({
    ok: true, status: 200,
    json: async () => ({ memories: items, total: items.length, hasMore: false, ...extra }),
});

const MEMORIES = [
    { id: 'm1', content: 'I prefer Dutch', type: 'preference', created_at: '2026-08-01T00:00:00Z' },
    { id: 'm2', content: 'Works at Bee Flow', type: 'fact', created_at: '2026-08-02T00:00:00Z' },
];

beforeEach(() => {
    vi.spyOn(global, 'fetch').mockResolvedValue(PAGE(MEMORIES));
});
afterEach(() => { vi.restoreAllMocks(); });

const setup = (props = {}) => render(<MemoryPanel onClose={vi.fn()} {...props} />);

describe('MemoryPanel — failures are visible', () => {
    it('clears a load error once a later fetch succeeds', async () => {
        global.fetch.mockRejectedValueOnce(new Error('network'));
        setup();
        await waitFor(() => expect(screen.getByText('Failed to load memories')).toBeInTheDocument());

        // A search change triggers a refetch, which now succeeds.
        fireEvent.change(screen.getByTestId('memory-search'), { target: { value: 'dutch' } });

        await waitFor(() => {
            expect(screen.queryByText('Failed to load memories')).not.toBeInTheDocument();
        }, { timeout: 3000 });
    });

    it('treats a 403 as an error rather than silently keeping stale rows', async () => {
        // A 403 body has no `.memories`, so the old code fell through the `if`
        // and left the previous list on screen with no error shown at all.
        global.fetch.mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: 'nope' }) });
        setup();
        await waitFor(() => expect(screen.getByText(/no longer have access/)).toBeInTheDocument());
    });

    it('surfaces a failed delete and leaves the row in place', async () => {
        setup();
        await waitFor(() => expect(screen.getByTestId('memory-item-m1')).toBeInTheDocument());

        global.fetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
        fireEvent.click(screen.getByTestId('memory-delete-m1'));

        // Confirm through the app's own dialog, not window.confirm.
        fireEvent.click(await screen.findByTestId('confirm-dialog-confirm'));

        await waitFor(() => expect(screen.getByTestId('memory-action-error')).toBeInTheDocument());
        expect(screen.getByTestId('memory-item-m1')).toBeInTheDocument();
    });

    it('asks for confirmation in the app\'s own dialog, not window.confirm', async () => {
        const nativeConfirm = vi.fn(() => true);
        vi.stubGlobal('confirm', nativeConfirm);
        setup();
        await waitFor(() => expect(screen.getByTestId('memory-item-m1')).toBeInTheDocument());

        fireEvent.click(screen.getByTestId('memory-delete-m1'));

        expect(await screen.findByText(/It will no longer be used in your chats/)).toBeInTheDocument();
        expect(nativeConfirm).not.toHaveBeenCalled();
        vi.unstubAllGlobals();
    });
});

describe('MemoryPanel — a viewer cannot reach a write', () => {
    it('hides the select toggle and therefore bulk delete', async () => {
        setup({ projectId: 'p1', canEdit: false });
        await waitFor(() => expect(screen.getByTestId('memory-item-m1')).toBeInTheDocument());

        expect(screen.queryByTestId('memory-select-toggle')).not.toBeInTheDocument();
        expect(screen.queryByTestId('memory-bulk-delete-btn')).not.toBeInTheDocument();
    });

    it('still lets an editor select and bulk delete', async () => {
        // The control — the gate must not be over-broad.
        setup({ projectId: 'p1', canEdit: true });
        await waitFor(() => expect(screen.getByTestId('memory-item-m1')).toBeInTheDocument());
        expect(screen.getByTestId('memory-select-toggle')).toBeInTheDocument();
    });
});

/**
 * 4. CLEAR ALL IN A PROJECT WIPED YOUR PERSONAL MEMORY. The project's Memory tab
 *    renders this same panel with `projectId`, and "Clear All" sent
 *    POST /agents/memory/clear with no body, which is the PERSONAL clear: every
 *    personal memory went, the project's pool stayed, and the panel showed an
 *    empty list as if it had worked. The dialog said "Delete all memories?"
 *    either way, so nobody could tell which ones.
 */
describe('MemoryPanel — Clear All clears the memory on the screen', () => {
    const clearCall = () => global.fetch.mock.calls.find(([url]) => String(url).endsWith('/agents/memory/clear'));

    /** Open the panel, press Clear All, and hand back the dialog it asks in. */
    const openClearDialog = async (props) => {
        const user = userEvent.setup();
        setup(props);
        await screen.findByTestId('memory-item-m1');
        await user.click(screen.getByTestId('memory-clear-all'));
        return { user, dialog: await screen.findByRole('dialog') };
    };

    /** …then confirm it against a server answering `response`, and return the clear request. */
    const confirmClear = async (user, response = { ok: true, status: 200, json: async () => ({ success: true }) }) => {
        global.fetch.mockResolvedValueOnce(response);
        await user.click(screen.getByTestId('confirm-dialog-confirm'));
        await waitFor(() => expect(clearCall()).toBeTruthy());
        return clearCall()[1];
    };

    it('in a project, asks the server to clear THAT project, not your personal memory', async () => {
        const { user } = await openClearDialog({ projectId: 'p1', canEdit: true });
        const init = await confirmClear(user);

        expect(init.method).toBe('POST');
        expect(init.body, 'no body is the personal clear').toBeDefined();
        expect(JSON.parse(init.body)).toEqual({ projectId: 'p1' });
    });

    it('in Settings, still sends the personal clear, with no body', async () => {
        const { user } = await openClearDialog();
        const init = await confirmClear(user);

        expect(init.method).toBe('POST');
        expect(init.body).toBeUndefined();
    });

    it('in a project, the dialog says it is the project\'s memory that goes, for everyone', async () => {
        const { dialog } = await openClearDialog({ projectId: 'p1', canEdit: true });

        expect(dialog).toHaveTextContent(/this project/i);
        expect(dialog).toHaveTextContent(/all members/i);
        expect(dialog).toHaveTextContent(/personal memories are not affected/i);
    });

    it('in Settings, the dialog says it is your personal memory that goes', async () => {
        const { dialog } = await openClearDialog();

        expect(dialog).toHaveTextContent(/personal memories/i);
        expect(dialog).toHaveTextContent(/project memories are not affected/i);
    });

    it('keeps the project\'s rows on screen when the server refuses the clear, and names what failed', async () => {
        const { user } = await openClearDialog({ projectId: 'p1', canEdit: true });
        await confirmClear(user, { ok: false, status: 403, json: async () => ({ error: 'Editor role required for this project' }) });

        expect(await screen.findByTestId('memory-action-error')).toHaveTextContent(/this project's memories/i);
        expect(screen.getByTestId('memory-item-m1')).toBeInTheDocument();
    });
});

describe('MemoryPanel — pagination', () => {
    it('asks the server for the rows it has not seen yet', async () => {
        // `memories.length` is the correct offset even after a delete: the
        // server's result set shrinks by one at the same moment, so the rows
        // still held occupy 0..length-1 of the shrunk set. Pinned because it
        // reads like an off-by-one and has been "fixed" into one before.
        global.fetch.mockResolvedValue(PAGE(MEMORIES, { total: 10, hasMore: true }));
        setup();
        await waitFor(() => expect(screen.getByTestId('memory-item-m1')).toBeInTheDocument());

        global.fetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true }) });
        fireEvent.click(screen.getByTestId('memory-delete-m1'));
        fireEvent.click(await screen.findByTestId('confirm-dialog-confirm'));
        await waitFor(() => expect(screen.queryByTestId('memory-item-m1')).not.toBeInTheDocument());

        global.fetch.mockResolvedValue(PAGE([], { total: 9, hasMore: false }));
        fireEvent.click(screen.getByTestId('memory-load-more'));

        await waitFor(() => {
            const urls = global.fetch.mock.calls.map(c => String(c[0]));
            const lastList = urls.reverse().find(u => u.includes('offset='));
            // One row left in hand, nine on the server -> the next unseen row is at 1.
            expect(lastList).toContain('offset=1');
        });
    });
});
