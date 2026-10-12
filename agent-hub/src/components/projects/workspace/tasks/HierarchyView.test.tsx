import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectTask } from '../../../../api/queries/projectTasks';
import scopedStorage, { setCurrentUser } from '../../../../utils/scopedStorage';
import HierarchyView from './HierarchyView';

const task = (id: string, extra: Partial<ProjectTask> = {}): ProjectTask => ({
    id, title: `Task ${id}`, description: '', status: 'todo', priority: 'normal', labels: [], checklist: [], sortOrder: 1000, source: null,
    assigneeIds: [], links: [], dueDate: null, createdBy: 'u-owner', completedAt: null, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', ...extra,
});

const TREE = [
    task('epic', { itemType: 'epic', storyPoints: 8 }),
    task('story', { itemType: 'story', parentTaskId: 'epic', storyPoints: 5, status: 'done' }),
    task('leaf', { itemType: 'task', parentTaskId: 'story', storyPoints: 3 }),
    task('plain'),
    task('orphan', { parentTaskId: 'gone' }),
];

function renderView(tasks: ProjectTask[] = TREE, canEdit = true) {
    const handlers = { onOpen: vi.fn(), onAddChild: vi.fn() };
    render(<HierarchyView projectId="p1" tasks={tasks} canEdit={canEdit} {...handlers} />);
    return handlers;
}

beforeEach(() => {
    setCurrentUser('u-editor');
    try { localStorage.clear(); } catch { /* none */ }
});

describe('HierarchyView', () => {
    it('renders the tree with a rollup chip and progress over an epic\'s descendants', () => {
        renderView();
        expect(screen.getByTestId('hierarchy-row-epic')).toBeInTheDocument();
        expect(screen.getByTestId('hierarchy-row-story')).toBeInTheDocument();
        expect(screen.getByTestId('hierarchy-row-leaf')).toBeInTheDocument();
        expect(screen.getByTestId('hierarchy-rollup-epic')).toHaveTextContent('1/3');
        expect(screen.getByTestId('hierarchy-rollup-epic')).toHaveTextContent('16 pts');
        expect(screen.getByTestId('hierarchy-rollup-epic')).toHaveAttribute('title', '1/3 done · 16 pts');
        // The tooltip is not announced, so the full sentence is also there for screen readers.
        expect(within(screen.getByTestId('hierarchy-rollup-epic')).getByText('1/3 done · 16 pts')).toHaveClass('sr-only');
        expect(screen.getByTestId('hierarchy-rollup-story')).toHaveTextContent('1/2');
        expect(screen.getByTestId('hierarchy-rollup-story')).toHaveTextContent('8 pts');
        expect(within(screen.getByTestId('hierarchy-row-leaf')).getByText('3 pts')).toBeInTheDocument();
    });

    it('shows items whose parent is missing under Ungrouped', () => {
        renderView();
        const ungrouped = screen.getByRole('region', { name: 'Ungrouped' });
        expect(within(ungrouped).getByTestId('hierarchy-row-orphan')).toBeInTheDocument();
    });

    it('opens a task from its row and starts a child from the hover action', async () => {
        const user = userEvent.setup();
        const handlers = renderView();
        await user.click(within(screen.getByTestId('hierarchy-row-leaf')).getByRole('button', { name: 'Task leaf' }));
        expect(handlers.onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'leaf' }));
        await user.click(screen.getByTestId('hierarchy-add-child-epic'));
        expect(handlers.onAddChild).toHaveBeenCalledWith(expect.objectContaining({ id: 'epic' }));
    });

    it('offers no Add child on a leaf task or to a viewer', () => {
        const { unmount } = render(<HierarchyView projectId="p1" tasks={TREE} canEdit onOpen={vi.fn()} onAddChild={vi.fn()} />);
        expect(screen.queryByTestId('hierarchy-add-child-leaf')).not.toBeInTheDocument();
        unmount();
        render(<HierarchyView projectId="p1" tasks={TREE} canEdit={false} onOpen={vi.fn()} onAddChild={vi.fn()} />);
        expect(screen.queryByTestId('hierarchy-add-child-epic')).not.toBeInTheDocument();
    });

});

describe('HierarchyView actions', () => {
    it('labels epics and stories with a translated type, and plain tasks with none', () => {
        renderView();
        expect(within(screen.getByTestId('hierarchy-row-epic')).getByText('Epic')).toBeInTheDocument();
        expect(within(screen.getByTestId('hierarchy-row-story')).getByText('Story')).toBeInTheDocument();
        expect(screen.getByTestId('hierarchy-row-leaf').querySelector('[data-type]')).toBeNull();
    });

    it('offers open, add child and new sibling from the row menu', async () => {
        const user = userEvent.setup();
        const onNewEpic = vi.fn();
        const handlers = { onOpen: vi.fn(), onAddChild: vi.fn() };
        render(<HierarchyView projectId="p1" tasks={TREE} canEdit {...handlers} onNewEpic={onNewEpic} />);
        await user.click(screen.getByRole('button', { name: 'More actions for Task story' }));
        await user.click(screen.getByRole('menuitem', { name: 'New sibling' }));
        expect(handlers.onAddChild).toHaveBeenCalledWith(expect.objectContaining({ id: 'epic' }));
        await user.click(screen.getByRole('button', { name: 'More actions for Task story' }));
        await user.click(screen.getByRole('menuitem', { name: 'Add child' }));
        expect(handlers.onAddChild).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'story' }));
        await user.click(screen.getByRole('button', { name: 'More actions for Task epic' }));
        await user.click(screen.getByRole('menuitem', { name: 'Open' }));
        expect(handlers.onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'epic' }));
        await user.click(screen.getByRole('button', { name: 'More actions for Task epic' }));
        await user.click(screen.getByRole('menuitem', { name: 'New sibling' }));
        expect(onNewEpic).toHaveBeenCalledTimes(1);
        await user.click(screen.getByTestId('hierarchy-new-epic'));
        expect(onNewEpic).toHaveBeenCalledTimes(2);
    });

    it('hides the row menu and New epic from a viewer', () => {
        render(<HierarchyView projectId="p1" tasks={TREE} canEdit={false} onOpen={vi.fn()} onAddChild={vi.fn()} onNewEpic={vi.fn()} />);
        expect(screen.queryByTestId('hierarchy-menu-epic')).not.toBeInTheDocument();
        expect(screen.queryByTestId('hierarchy-new-epic')).not.toBeInTheDocument();
    });

    it('collapses and expands everything at once', async () => {
        const user = userEvent.setup();
        renderView();
        await user.click(screen.getByRole('button', { name: 'Collapse all' }));
        expect(screen.queryByTestId('hierarchy-row-story')).not.toBeInTheDocument();
        expect(JSON.parse(scopedStorage.getItem('projectTaskHierarchy:p1') || '[]')).toEqual(expect.arrayContaining(['epic', 'story']));
        await user.click(screen.getByRole('button', { name: 'Expand all' }));
        expect(screen.getByTestId('hierarchy-row-leaf')).toBeInTheDocument();
    });

    it('shows the empty state with a single call to action', async () => {
        const user = userEvent.setup();
        const onNewEpic = vi.fn();
        render(<HierarchyView projectId="p1" tasks={[]} canEdit onOpen={vi.fn()} onAddChild={vi.fn()} onNewEpic={onNewEpic} />);
        expect(screen.getByText('No work items yet')).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Create an epic' }));
        expect(onNewEpic).toHaveBeenCalled();
    });

    it('collapses a branch and remembers it for the next visit', async () => {
        const user = userEvent.setup();
        const mounted = render(<HierarchyView projectId="p1" tasks={TREE} canEdit onOpen={vi.fn()} onAddChild={vi.fn()} />);
        await user.click(screen.getByRole('button', { name: 'Collapse Task epic' }));
        expect(screen.queryByTestId('hierarchy-row-story')).not.toBeInTheDocument();
        mounted.unmount();
        render(<HierarchyView projectId="p1" tasks={TREE} canEdit onOpen={vi.fn()} onAddChild={vi.fn()} />);
        expect(screen.queryByTestId('hierarchy-row-story')).not.toBeInTheDocument();
        expect(JSON.parse(scopedStorage.getItem('projectTaskHierarchy:p1') || '[]')).toContain('epic');
    });
});
