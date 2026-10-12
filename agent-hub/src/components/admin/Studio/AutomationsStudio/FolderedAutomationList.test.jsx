import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import FolderedAutomationList, { MoveToFolderDialog } from './FolderedAutomationList';

/**
 * Folders in the automations sidebar.
 *
 * The behaviours here are the ones that would quietly ruin the feature: a
 * automation vanishing because its folder is unknown, a folder header claiming
 * rows it isn't showing, and — the one users notice immediately — removing a
 * folder taking its automations with it.
 */
const automation = (id, over = {}) => ({
    id, title: `Automation ${id}`, isActive: true, isDraft: false, triggerType: 'manual', folderId: null, ...over,
});

const FOLDERS = [
    { id: 'f1', name: 'Klanten', icon: '📁' },
    { id: 'f2', name: 'Intern', icon: '📁' },
];

function renderList(automations, folders = FOLDERS, props = {}) {
    const handlers = {
        onCreateFolder: vi.fn(),
        onRenameFolder: vi.fn(),
        onDeleteFolder: vi.fn(),
        onMoveToFolder: vi.fn(),
        ...props,
    };
    const utils = render(
        <FolderedAutomationList
            automations={automations}
            folders={folders}
            rowProps={(a) => ({ automation: a, kind: 'automation', selected: false, onSelect: () => {} })}
            {...handlers}
        />,
    );
    return { ...utils, ...handlers };
}

describe('FolderedAutomationList', () => {
    beforeEach(cleanup);

    it('shows loose automations without needing a folder to exist', () => {
        renderList([automation('a'), automation('b')], []);
        expect(screen.getByText('Automation a')).toBeTruthy();
        expect(screen.getByText('Automation b')).toBeTruthy();
    });

    it('lists loose automations BEFORE the folders', () => {
        // Everything is loose on day one; a row of folder headers above the
        // whole list would make this feature a regression for most people.
        const { container } = renderList([automation('loose')], FOLDERS);
        const text = container.textContent;
        expect(text.indexOf('Automation loose')).toBeLessThan(text.indexOf('Klanten'));
    });

    it('counts a folder’s automations on its header', () => {
        renderList([automation('a', { folderId: 'f1' }), automation('b', { folderId: 'f1' }), automation('c')]);
        const header = screen.getByLabelText('Expand Klanten').closest('div');
        expect(within(header).getByText('2')).toBeTruthy();
    });

    it('keeps a folder’s rows hidden until it is opened', () => {
        renderList([automation('inside', { folderId: 'f1' })]);
        expect(screen.queryByText('Automation inside')).toBeNull();
        fireEvent.click(screen.getByLabelText('Expand Klanten'));
        expect(screen.getByText('Automation inside')).toBeTruthy();
    });

    it('never loses an automation whose folder it does not know about', () => {
        // A folder deleted in another tab, or one belonging to a colleague:
        // the automation falls back to the loose list rather than disappearing.
        renderList([automation('orphan', { folderId: 'gone' })]);
        expect(screen.getByText('Automation orphan')).toBeTruthy();
    });

    it('hides empty folders while filtering', () => {
        renderList([automation('a', { folderId: 'f1' })], FOLDERS, {});
        cleanup();
        render(
            <FolderedAutomationList
                automations={[automation('a', { folderId: 'f1' })]}
                folders={FOLDERS}
                filtering
                rowProps={(a) => ({ automation: a, kind: 'automation', selected: false, onSelect: () => {} })}
            />,
        );
        expect(screen.getByLabelText('Expand Klanten')).toBeTruthy();
        // 'Intern' holds no match, so its header would announce nothing.
        expect(screen.queryByLabelText('Expand Intern')).toBeNull();
    });

    it('offers no "New folder" button while filtering', () => {
        render(
            <FolderedAutomationList
                automations={[]}
                folders={FOLDERS}
                filtering
                rowProps={(a) => ({ automation: a, kind: 'automation', selected: false, onSelect: () => {} })}
            />,
        );
        expect(screen.queryByText('New folder')).toBeNull();
    });

    describe('creating a folder', () => {
        it('names it in the app, never through a browser prompt', () => {
            const promptSpy = vi.spyOn(window, 'prompt');
            const { onCreateFolder } = renderList([]);
            fireEvent.click(screen.getByText('New folder'));

            const input = screen.getByLabelText('New folder name');
            fireEvent.change(input, { target: { value: 'Offertes' } });
            fireEvent.keyDown(input, { key: 'Enter' });

            expect(onCreateFolder).toHaveBeenCalledWith('Offertes');
            expect(promptSpy).not.toHaveBeenCalled();
            promptSpy.mockRestore();
        });

        it('drops an empty name instead of making a nameless folder', () => {
            const { onCreateFolder } = renderList([]);
            fireEvent.click(screen.getByText('New folder'));
            const input = screen.getByLabelText('New folder name');
            fireEvent.change(input, { target: { value: '   ' } });
            fireEvent.keyDown(input, { key: 'Enter' });
            expect(onCreateFolder).not.toHaveBeenCalled();
        });

        it('abandons on Escape', () => {
            const { onCreateFolder } = renderList([]);
            fireEvent.click(screen.getByText('New folder'));
            const input = screen.getByLabelText('New folder name');
            fireEvent.change(input, { target: { value: 'Nope' } });
            fireEvent.keyDown(input, { key: 'Escape' });
            expect(onCreateFolder).not.toHaveBeenCalled();
            expect(screen.getByText('New folder')).toBeTruthy();
        });
    });

    describe('removing a folder', () => {
        it('asks in the app, and promises the automations survive', () => {
            const confirmSpy = vi.spyOn(window, 'confirm');
            const { onDeleteFolder } = renderList([automation('a', { folderId: 'f1' })]);
            fireEvent.click(screen.getByLabelText('Delete Klanten'));

            expect(screen.getByRole('dialog', { name: 'Remove folder' })).toBeTruthy();
            expect(screen.getByText(/will stay/)).toBeTruthy();
            expect(confirmSpy).not.toHaveBeenCalled();
            expect(onDeleteFolder).not.toHaveBeenCalled();

            fireEvent.click(screen.getByText('Remove folder'));
            expect(onDeleteFolder).toHaveBeenCalledWith(expect.objectContaining({ id: 'f1' }));
            confirmSpy.mockRestore();
        });

        it('says so plainly when the folder is empty', () => {
            renderList([]);
            fireEvent.click(screen.getByLabelText('Delete Klanten'));
            expect(screen.getByText('The folder is empty.')).toBeTruthy();
        });

        it('cancelling changes nothing', () => {
            const { onDeleteFolder } = renderList([automation('a', { folderId: 'f1' })]);
            fireEvent.click(screen.getByLabelText('Delete Klanten'));
            fireEvent.click(screen.getByText('Cancel'));
            expect(onDeleteFolder).not.toHaveBeenCalled();
        });
    });

    it('renames a folder inline', () => {
        const { onRenameFolder } = renderList([]);
        fireEvent.click(screen.getByLabelText('Rename Klanten'));
        const input = screen.getByLabelText('Folder name');
        fireEvent.change(input, { target: { value: 'Klantwerk' } });
        fireEvent.keyDown(input, { key: 'Enter' });
        expect(onRenameFolder).toHaveBeenCalledWith('f1', 'Klantwerk');
    });

    it('moves an automation when it is dropped on a folder', () => {
        const { onMoveToFolder, container } = renderList([automation('a')]);
        const row = container.querySelector('[draggable="true"]');
        const data = new Map();
        const dataTransfer = {
            setData: (k, v) => data.set(k, v),
            getData: (k) => data.get(k) || '',
            effectAllowed: '',
            dropEffect: '',
        };
        fireEvent.dragStart(row, { dataTransfer });
        const header = screen.getByLabelText('Expand Klanten').closest('div');
        fireEvent.dragOver(header, { dataTransfer });
        fireEvent.drop(header, { dataTransfer });
        expect(onMoveToFolder).toHaveBeenCalledWith('a', 'f1');
    });
});

describe('MoveToFolderDialog', () => {
    beforeEach(cleanup);

    it('renders nothing without an automation', () => {
        const { container } = render(<MoveToFolderDialog automation={null} folders={FOLDERS} onPick={vi.fn()} onClose={vi.fn()} />);
        expect(container.firstChild).toBeNull();
    });

    it('offers every folder plus a way back out', () => {
        const onPick = vi.fn();
        render(<MoveToFolderDialog automation={automation('a')} folders={FOLDERS} onPick={onPick} onClose={vi.fn()} />);
        expect(screen.getByText('No folder')).toBeTruthy();
        fireEvent.click(screen.getByText('Klanten'));
        expect(onPick).toHaveBeenCalledWith('f1');
    });

    it('can take an automation out of its folder', () => {
        const onPick = vi.fn();
        render(<MoveToFolderDialog automation={automation('a', { folderId: 'f1' })} folders={FOLDERS} onPick={onPick} onClose={vi.fn()} />);
        fireEvent.click(screen.getByText('No folder'));
        expect(onPick).toHaveBeenCalledWith(null);
    });

    it('explains the empty state instead of showing a blank list', () => {
        render(<MoveToFolderDialog automation={automation('a')} folders={[]} onPick={vi.fn()} onClose={vi.fn()} />);
        expect(screen.getByText(/No folders yet/)).toBeTruthy();
    });
});
