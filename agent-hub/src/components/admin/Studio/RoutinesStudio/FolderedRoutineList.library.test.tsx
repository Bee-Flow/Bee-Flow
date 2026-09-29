import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));

import { authFetch } from '../../../../utils/helpers';
import FolderedRoutineList from './FolderedRoutineList';

/**
 * Handoff 5 list states: routines shared with the caller in their own group,
 * and "Recently deleted" (the trash) with Restore at the foot of the list.
 */
const fetchMock = vi.mocked(authFetch);

function json(body: unknown, status = 200) {
    return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

const routine = (id: string, over: Record<string, unknown> = {}) => ({
    id, title: `Routine ${id}`, isActive: true, isDraft: false, triggerType: 'manual', folderId: null,
    neverLive: false, liveVersion: 1, pendingChanges: 0, ...over,
});

// The list is a .jsx module whose inferred prop types read the `= null`
// defaults as the only allowed value, so the test renders it untyped.
const List = FolderedRoutineList as unknown as React.ComponentType<Record<string, unknown>>;

function renderList(automations: ReturnType<typeof routine>[], props: Record<string, unknown> = {}) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onRestored = vi.fn();
    render(
        <QueryClientProvider client={client}>
            <List
                automations={automations}
                folders={[{ id: 'f1', name: 'Klanten' }]}
                rowProps={(a: ReturnType<typeof routine>) => ({ routine: a, kind: 'automation', selected: false, onSelect: () => {} })}
                onCreateFolder={vi.fn()}
                onRenameFolder={vi.fn()}
                onDeleteFolder={vi.fn()}
                onMoveToFolder={vi.fn()}
                onRestored={onRestored}
                {...props}
            />
        </QueryClientProvider>,
    );
    return { onRestored };
}

describe('FolderedRoutineList — shared with me', () => {
    beforeEach(() => fetchMock.mockReset());
    afterEach(cleanup);

    it('lists routines shared with the caller in their own group, out of the folders', () => {
        renderList([
            routine('mine'),
            routine('theirs', { myRole: 'run', folderId: 'f1' }),
            routine('also', { myRole: 'edit' }),
        ]);
        const shared = screen.getByTestId('folder-shared');
        expect(within(shared).getByText('Shared with me')).toBeTruthy();
        expect(within(shared).getByText('Routine theirs')).toBeTruthy();
        expect(within(shared).getByText('Can run')).toBeTruthy();
        expect(within(shared).getByText('Can edit')).toBeTruthy();
        expect(within(screen.getByTestId('folder-loose')).queryByText('Routine theirs')).toBeNull();
        expect(within(screen.getByTestId('folder-loose')).getByText('Routine mine')).toBeTruthy();
    });

    it('draws no shared group when nothing is shared', () => {
        renderList([routine('mine', { myRole: 'owner' })]);
        expect(screen.queryByTestId('folder-shared')).toBeNull();
    });
});

describe('FolderedRoutineList — recently deleted', () => {
    beforeEach(() => fetchMock.mockReset());
    afterEach(cleanup);

    it('reads the trash only once the section is opened', async () => {
        const user = userEvent.setup();
        fetchMock.mockResolvedValue(json({ automations: [], retentionDays: 30 }));
        renderList([routine('a')]);
        expect(fetchMock).not.toHaveBeenCalled();
        await user.click(screen.getByRole('button', { name: /Recently deleted/ }));
        expect(await screen.findByText('Nothing deleted in the last 30 days.')).toBeTruthy();
        expect(fetchMock).toHaveBeenCalledWith('/api/automation/_trash', expect.anything());
    });

    it('restores a trashed routine and tells the list to refresh', async () => {
        const user = userEvent.setup();
        const purgeAt = new Date(Date.now() + 12 * 86_400_000 - 60_000).toISOString();
        fetchMock.mockImplementation(async (url: string | URL | Request) => {
            if (String(url).endsWith('/_trash')) {
                return json({ automations: [{ id: 'gone', title: 'Old invoices', deletedAt: new Date().toISOString(), purgeAt }], retentionDays: 30 });
            }
            return json({ automation: { id: 'gone', isActive: false } });
        });
        const { onRestored } = renderList([routine('a')]);
        await user.click(screen.getByRole('button', { name: /Recently deleted/ }));
        expect(await screen.findByText('Old invoices')).toBeTruthy();
        expect(screen.getByText('12 days left')).toBeTruthy();
        await user.click(screen.getByRole('button', { name: 'Restore Old invoices' }));
        await vi.waitFor(() => expect(onRestored).toHaveBeenCalledWith('gone'));
        expect(fetchMock).toHaveBeenCalledWith('/api/automation/gone/restore', { method: 'POST' });
    });

    it('says so when the trash cannot be read', async () => {
        const user = userEvent.setup();
        fetchMock.mockResolvedValue(json({ error: 'boom' }, 500));
        renderList([routine('a')]);
        await user.click(screen.getByRole('button', { name: /Recently deleted/ }));
        expect((await screen.findByRole('alert')).textContent).toBe('The trash could not be read.');
    });

    it('hides the trash while filtering and without onRestored', () => {
        renderList([routine('a')], { filtering: true });
        expect(screen.queryByTestId('routines-trash')).toBeNull();
        cleanup();
        renderList([routine('a')], { onRestored: undefined });
        expect(screen.queryByTestId('routines-trash')).toBeNull();
    });
});

describe('FolderedRoutineList — the slot below the folders', () => {
    beforeEach(() => fetchMock.mockReset());
    afterEach(cleanup);

    it('draws `afterFolders` (the Building blocks group) below the folders and above Recently deleted', () => {
        renderList([routine('a', { folderId: 'f1' })], { afterFolders: <div data-testid="blocks-slot">blocks</div> });
        const folder = screen.getByTestId('folder-f1');
        const slot = screen.getByTestId('blocks-slot');
        const trash = screen.getByTestId('routines-trash');
        expect(folder.compareDocumentPosition(slot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(slot.compareDocumentPosition(trash) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('keeps the slot while filtering, when the trash and "New folder" step aside', () => {
        renderList([routine('a')], { filtering: true, afterFolders: <div data-testid="blocks-slot">blocks</div> });
        expect(screen.getByTestId('blocks-slot')).toBeTruthy();
        expect(screen.queryByTestId('routines-trash')).toBeNull();
    });
});
