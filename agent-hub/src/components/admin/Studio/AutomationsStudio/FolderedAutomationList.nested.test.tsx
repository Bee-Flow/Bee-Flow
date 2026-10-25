import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FolderedAutomationList from './FolderedAutomationList';

/**
 * Nested folders in the automations sidebar: the tree, "new subfolder", the
 * move dialog, and what removing a folder says about its subfolders.
 */
const automation = (id: string, over: Record<string, unknown> = {}) => ({
    id, title: `Automation ${id}`, isActive: true, isDraft: false, triggerType: 'manual', folderId: null, ...over,
});

const FOLDERS = [
    { id: 'fin', name: 'Finance', parentId: null },
    { id: 'inv', name: 'Invoices', parentId: 'fin' },
    { id: 'y26', name: '2026', parentId: 'inv' },
    { id: 'cli', name: 'Clients', parentId: null },
];

const List = FolderedAutomationList as unknown as React.ComponentType<Record<string, unknown>>;

function renderList(automations: ReturnType<typeof automation>[], props: Record<string, unknown> = {}) {
    const handlers = {
        onCreateFolder: vi.fn(),
        onMoveFolder: vi.fn(),
        onRenameFolder: vi.fn(),
        onDeleteFolder: vi.fn(),
        onMoveToFolder: vi.fn(),
        ...props,
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
        <QueryClientProvider client={client}>
            <List
                automations={automations}
                folders={FOLDERS}
                rowProps={(a: ReturnType<typeof automation>) => ({ automation: a, kind: 'automation', selected: false, onSelect: () => {} })}
                {...handlers}
            />
        </QueryClientProvider>,
    );
    return handlers;
}

describe('nested folders in the sidebar', () => {
    beforeEach(() => { try { localStorage.clear(); } catch { /* none */ } });
    afterEach(cleanup);

    it('shows only the top level until a folder is opened, then its subfolders inside it', async () => {
        const user = userEvent.setup();
        renderList([]);
        expect(screen.getByText('Finance')).toBeTruthy();
        expect(screen.getByText('Clients')).toBeTruthy();
        expect(screen.queryByText('Invoices')).toBeNull();
        await user.click(screen.getByRole('button', { name: 'Expand Finance' }));
        const finance = screen.getByTestId('folder-fin');
        expect(within(finance).getByText('Invoices')).toBeTruthy();
        expect(screen.queryByText('2026')).toBeNull();
        await user.click(screen.getByRole('button', { name: 'Expand Invoices' }));
        expect(within(screen.getByTestId('folder-inv')).getByText('2026')).toBeTruthy();
    });

    it('counts the automations of a folder and everything below it', () => {
        renderList([automation('a', { folderId: 'y26' }), automation('b', { folderId: 'inv' })]);
        expect(within(screen.getByTestId('folder-fin')).getAllByText('2')[0]).toBeTruthy();
    });

    it('a search keeps a folder when only a subfolder matches, and drops the empty ones', async () => {
        const user = userEvent.setup();
        renderList([automation('a', { folderId: 'y26' })], { filtering: true });
        expect(screen.getByText('Finance')).toBeTruthy();
        expect(screen.queryByText('Clients')).toBeNull();
        await user.click(screen.getByRole('button', { name: 'Expand Finance' }));
        expect(screen.getByText('Invoices')).toBeTruthy();
    });

    it('"new subfolder" asks for a name and creates it inside that folder', async () => {
        const user = userEvent.setup();
        const { onCreateFolder } = renderList([]);
        await user.click(screen.getByRole('button', { name: 'New subfolder in Clients' }));
        await user.type(screen.getByRole('textbox', { name: 'Subfolder name' }), 'Retail{Enter}');
        expect(onCreateFolder).toHaveBeenCalledWith('Retail', 'cli');
    });

    it('the move dialog does not offer the folder itself or anything below it', async () => {
        const user = userEvent.setup();
        const { onMoveFolder } = renderList([]);
        await user.click(screen.getByRole('button', { name: 'Move Finance' }));
        const dialog = screen.getByRole('dialog');
        expect(within(dialog).getByRole('button', { name: 'Top level' })).toBeTruthy();
        expect(within(dialog).getByRole('button', { name: /Clients/ })).toBeTruthy();
        expect(within(dialog).queryByRole('button', { name: /Invoices/ })).toBeNull();
        expect(within(dialog).queryByRole('button', { name: /2026/ })).toBeNull();
        await user.click(within(dialog).getByRole('button', { name: /Clients/ }));
        expect(onMoveFolder).toHaveBeenCalledWith('fin', 'cli');
    });

    it('moving to the top level passes null', async () => {
        const user = userEvent.setup();
        const { onMoveFolder } = renderList([]);
        await user.click(screen.getByRole('button', { name: 'Expand Finance' }));
        await user.click(screen.getByRole('button', { name: 'Move Invoices' }));
        await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Top level' }));
        expect(onMoveFolder).toHaveBeenCalledWith('inv', null);
    });

    it('removing a folder with subfolders says they move up', async () => {
        const user = userEvent.setup();
        const { onDeleteFolder } = renderList([]);
        await user.click(screen.getByRole('button', { name: 'Delete Finance' }));
        expect(screen.getByText('Its 1 subfolder moves up one level.')).toBeTruthy();
        await user.click(screen.getByRole('button', { name: 'Remove folder' }));
        expect(onDeleteFolder).toHaveBeenCalledWith(expect.objectContaining({ id: 'fin' }));
    });
});
