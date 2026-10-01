import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withQueryClient } from '../../../../test/queryWrapper';
import { EDITOR_ID, getRouter, MEMBERS, OWNER_ID, tabProps } from '../content/contentTestKit';
import type { ProjectTask } from '../../../../api/queries/projectTasks';

const { client } = vi.hoisted(() => ({ client: {} as Record<'get' | 'post' | 'put' | 'patch' | 'delete', ReturnType<typeof vi.fn>> }));
vi.mock('../../../../api/client', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../../api/client')>()),
    apiClient: client,
    default: client,
}));
vi.mock('../../../../api/queries/modelTiers', () => ({ useModelTiersQuery: () => ({ data: {} }) }));

import TasksTab from './TasksTab';
import scopedStorage, { setCurrentUser } from '../../../../utils/scopedStorage';

const task = (id: string, extra: Partial<ProjectTask> = {}): ProjectTask => ({
    id, title: `Task ${id}`, description: '', status: 'todo', priority: 'normal', labels: [], checklist: [], sortOrder: 1000, source: null,
    assigneeIds: [], links: [], dueDate: null, createdBy: OWNER_ID, completedAt: null, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', ...extra,
});

let tasks: ProjectTask[];

function renderTab(role: 'owner' | 'editor' | 'viewer' = 'editor') {
    const handlers = { onOpenSub: vi.fn(), onNavigate: vi.fn(), onOpenTab: vi.fn() };
    render(withQueryClient(<TasksTab {...tabProps(role, handlers)} />));
    return handlers;
}

beforeEach(() => {
    setCurrentUser(EDITOR_ID);
    try { localStorage.clear(); scopedStorage.setItem('projectTasksView', 'list'); } catch { /* none */ }
    tasks = [
        task('1', { assigneeIds: [EDITOR_ID], priority: 'urgent', labels: ['launch'], checklist: [{ id: 'c1', text: 'a', done: true }, { id: 'c2', text: 'b', done: false }] }),
        task('2', { status: 'doing', sortOrder: 1000 }),
        task('3', { status: 'done', sortOrder: 1000 }),
    ];
    for (const m of ['get', 'post', 'put', 'patch', 'delete'] as const) client[m] = vi.fn();
    client.get.mockImplementation(getRouter({
        '/api/projects/p1/board': { columns: ['todo','doing','done'].map(id => ({ id, title: '', status: id, wipLimit: null })), assignments: {}, version: 0 },
        '/api/projects/p1/tasks': () => ({ tasks, role: 'editor' }),
        '/api/projects/p1/members': MEMBERS,
        '/api/projects/p1/resources': { role: 'editor', documents: [], notebooks: [], meetings: [{ id: 'mt-1', title: 'Weekly', actionItemCount: 2 }] },
        '/api/projects/p1/chats': { chats: [], role: 'editor' },
    }));
    client.patch.mockImplementation(async (_path: string, body: Partial<ProjectTask>) => ({ task: { ...tasks[0], ...body } }));
});

describe('TasksTab', () => {
    it('groups tasks by status and shows priority, labels and checklist progress', async () => {
        renderTab();
        const row = await screen.findByTestId('project-task-1');
        expect(within(row).getByText('Urgent')).toBeInTheDocument();
        expect(within(row).getByText('launch')).toBeInTheDocument();
        expect(within(row).getByText('1/2')).toBeInTheDocument();
        expect(screen.getByRole('region', { name: 'To do' })).toBeInTheDocument();
        expect(screen.getByRole('region', { name: 'In progress' })).toBeInTheDocument();
        expect(screen.getByText('2 open')).toBeInTheDocument();
    });

    it('filters by who a task is given to, and shows the filter as a pill', async () => {
        const user = userEvent.setup();
        renderTab();
        await screen.findByTestId('project-task-1');
        await user.click(screen.getByRole('button', { name: /Filter/ }));
        await user.click(screen.getByRole('menuitem', { name: 'Me' }));
        expect(screen.getByTestId('project-task-1')).toBeInTheDocument();
        expect(screen.queryByTestId('project-task-2')).not.toBeInTheDocument();
        expect(screen.getByTestId('task-filter-pill-who')).toHaveTextContent('Assignee: Me');
        expect(screen.getByRole('button', { name: /Filter/ })).toHaveTextContent('1');
        await user.keyboard('{Escape}');
        await user.click(screen.getByRole('button', { name: 'Clear filters' }));
        expect(screen.getByTestId('project-task-2')).toBeInTheDocument();
        expect(screen.queryByTestId('task-filter-pill-who')).not.toBeInTheDocument();
    });

    it('removes one filter from its pill and keeps the others', async () => {
        const user = userEvent.setup();
        renderTab();
        await screen.findByTestId('project-task-1');
        await user.click(screen.getByRole('button', { name: /Filter/ }));
        await user.click(screen.getByRole('menuitem', { name: 'Urgent' }));
        await user.click(screen.getByRole('menuitem', { name: 'launch' }));
        await user.keyboard('{Escape}');
        expect(screen.queryByTestId('project-task-2')).not.toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Remove filter Priority: Urgent' }));
        expect(screen.queryByTestId('task-filter-pill-priority')).not.toBeInTheDocument();
        expect(screen.getByTestId('task-filter-pill-label')).toHaveTextContent('Label: launch');
        expect(screen.getByTestId('project-task-1')).toBeInTheDocument();
    });

    it('says when nothing matches and clears the filters from there', async () => {
        const user = userEvent.setup();
        renderTab();
        await screen.findByTestId('project-task-1');
        await user.click(screen.getByRole('button', { name: /Filter/ }));
        await user.click(screen.getByRole('menuitem', { name: 'Overdue only' }));
        await user.keyboard('{Escape}');
        const empty = await screen.findByTestId('tasks-no-match');
        await user.click(within(empty).getByRole('button', { name: 'Clear filters' }));
        expect(screen.getByTestId('project-task-1')).toBeInTheDocument();
    });

    it('sorts the list from a menu that only the list shows', async () => {
        const user = userEvent.setup();
        renderTab();
        await screen.findByTestId('project-task-1');
        await user.click(screen.getByRole('button', { name: /Sort by/ }));
        await user.click(screen.getByRole('menuitem', { name: 'Newest' }));
        expect(screen.getByRole('button', { name: /Sort by/ })).toHaveTextContent('Newest');
        await user.click(screen.getByRole('radio', { name: 'Board' }));
        expect(screen.queryByRole('button', { name: /Sort by/ })).not.toBeInTheDocument();
    });

    it('folds a status group and remembers it', async () => {
        const user = userEvent.setup();
        const { unmount } = render(withQueryClient(<TasksTab {...tabProps('editor', { onOpenSub: vi.fn(), onNavigate: vi.fn() })} />));
        await screen.findByTestId('project-task-2');
        await user.click(within(screen.getByRole('region', { name: 'In progress' })).getByRole('button', { name: /In progress/ }));
        expect(screen.queryByTestId('project-task-2')).not.toBeInTheDocument();
        unmount();
        renderTab();
        await screen.findByTestId('project-task-1');
        expect(screen.queryByTestId('project-task-2')).not.toBeInTheDocument();
    });

    it('folds a long Done group by default', async () => {
        tasks = [task('1'), ...['a', 'b', 'c', 'd', 'e', 'f'].map(id => task(id, { status: 'done' }))];
        renderTab();
        await screen.findByTestId('project-task-1');
        expect(within(screen.getByRole('region', { name: 'Done' })).getByRole('button', { name: /Done/ })).toHaveAttribute('aria-expanded', 'false');
        expect(screen.queryByTestId('project-task-a')).not.toBeInTheDocument();
    });

    it('adds a task from the end of To do', async () => {
        const user = userEvent.setup();
        renderTab();
        await user.click(await screen.findByTestId('task-list-add'));
        expect(await screen.findByRole('dialog')).toBeInTheDocument();
    });

    it('gives an empty project one empty state in the list, and keeps the board and hierarchy usable', async () => {
        const user = userEvent.setup();
        tasks = [];
        renderTab();
        expect(await screen.findByText('No tasks yet')).toBeInTheDocument();
        const [fromEmptyState] = screen.getAllByRole('button', { name: 'New task' }).filter(b => b.dataset.testid !== 'new-item-menu');
        await user.click(fromEmptyState);
        expect(await screen.findByRole('dialog')).toBeInTheDocument();
        await user.keyboard('{Escape}');
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
        await user.click(screen.getByRole('radio', { name: 'Board' }));
        // The empty lanes stay, so a card can be added straight into a column.
        expect(await screen.findByTestId('board-column-todo')).toBeInTheDocument();
        expect(screen.queryByText('No tasks yet')).not.toBeInTheDocument();
        await user.click(screen.getByRole('radio', { name: 'Hierarchy' }));
        expect(await screen.findByText('No work items yet')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Create an epic' })).toBeInTheDocument();
    });

    it('shows a board with a column per status, and moves a card through its actions menu', async () => {
        const user = userEvent.setup();
        renderTab();
        await screen.findByTestId('project-task-1');
        await user.click(screen.getByRole('radio', { name: 'Board' }));
        const board = await screen.findByTestId('project-task-board');
        const todo = within(within(board).getByTestId('board-column-todo'));
        expect(todo.getByTestId('board-task-1')).toBeInTheDocument();
        await user.click(within(screen.getByTestId('board-task-1')).getByRole('button', { name: 'Task actions' }));
        await user.click(within(screen.getByRole('menu', { name: 'Task actions' })).getByRole('menuitem', { name: 'In progress' }));
        await waitFor(() => expect(client.patch).toHaveBeenCalled());
        const [path, body] = client.patch.mock.calls[0];
        expect(path).toBe('/api/projects/p1/board/tasks/1');
        expect(body).toEqual({ columnId: 'doing', beforeId: null });
    });

    it('ticks a task done from the list', async () => {
        const user = userEvent.setup();
        renderTab();
        const row = await screen.findByTestId('project-task-2');
        await user.click(within(row).getByRole('button', { name: 'Mark as done' }));
        await waitFor(() => expect(client.patch).toHaveBeenCalledWith('/api/projects/p1/tasks/2', { status: 'done' }, expect.anything()));
    });

    it('offers "From a meeting" in the New menu, and board settings only on the board', async () => {
        const user = userEvent.setup();
        renderTab();
        await screen.findByTestId('project-task-1');
        expect(screen.queryByTestId('tasks-from-meeting')).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Configure board' })).not.toBeInTheDocument();
        await user.click(screen.getByTestId('new-item-menu'));
        expect(screen.getByTestId('tasks-from-meeting')).toBeInTheDocument();
        await user.keyboard('{Escape}');
        await user.click(screen.getByRole('radio', { name: 'Board' }));
        await user.click(await screen.findByRole('button', { name: 'Configure board' }));
        expect(await screen.findByTestId('board-settings')).toBeInTheDocument();
        expect(screen.getByTestId('project-task-board')).toBeInTheDocument();
    });

    it('offers no way to make or move tasks to a viewer', async () => {
        renderTab('viewer');
        await screen.findByTestId('project-task-1');
        expect(screen.queryByRole('button', { name: 'New task' })).not.toBeInTheDocument();
        expect(screen.queryByTestId('tasks-from-meeting')).not.toBeInTheDocument();
        expect(within(screen.getByTestId('project-task-2')).getByRole('button', { name: 'Mark as done' })).toBeDisabled();
    });

    it('opens the task a route points at', async () => {
        const handlers = { onOpenSub: vi.fn(), onNavigate: vi.fn(), onOpenTab: vi.fn() };
        render(withQueryClient(<TasksTab {...tabProps('editor', handlers, { sub: '2' })} />));
        expect(await screen.findByRole('dialog')).toBeInTheDocument();
        expect(screen.getByDisplayValue('Task 2')).toBeInTheDocument();
    });

    it('says by name who a task is given to, and says so plainly when nobody has it', async () => {
        renderTab();
        const row = await screen.findByTestId('project-task-1');
        expect(within(row).getByTestId('task-assignees')).toHaveTextContent('Eddie Editor');
        expect(within(screen.getByTestId('project-task-2')).getByTestId('task-unassigned')).toHaveTextContent('Not assigned');
        const user = userEvent.setup();
        await user.click(screen.getByRole('radio', { name: 'Board' }));
        expect(within(await screen.findByTestId('board-task-1')).getByTestId('task-assignees')).toHaveTextContent('Eddie Editor');
        expect(within(screen.getByTestId('board-task-2')).getByTestId('task-unassigned')).toBeInTheDocument();
    });

    it('shows more than one person as the first name and how many more', async () => {
        tasks[1] = { ...tasks[1], assigneeIds: [EDITOR_ID, OWNER_ID] };
        renderTab();
        expect(within(await screen.findByTestId('project-task-2')).getByTestId('task-assignees')).toHaveTextContent('Eddie Editor +1');
    });

    it('improves a task with the AI: the suggestion fills the form, keeps what is there, and saves nothing', async () => {
        const user = userEvent.setup();
        client.post.mockImplementation(async () => ({ suggestion: { title: 'Task 2', description: 'A clearer description.', priority: 'high', labels: ['ops'], checklist: [{ id: 'c1', text: 'Step one', done: false }], assigneeId: EDITOR_ID } }));
        renderTab();
        await user.click(await screen.findByTestId('project-task-2'));
        await user.click(await screen.findByTestId('task-improve-ai'));
        expect(await screen.findByTestId('task-ai-note')).toBeInTheDocument();
        expect(screen.getByLabelText('Description')).toHaveValue('A clearer description.');
        expect(within(screen.getByRole('dialog')).getByLabelText('Priority')).toHaveValue('high');
        expect(screen.getByText('ops')).toBeInTheDocument();
        expect(screen.getByDisplayValue('Step one')).toBeInTheDocument();
        expect(client.post).toHaveBeenCalledWith('/api/projects/p1/tasks/2/improve', {}, expect.anything());
        expect(client.patch).not.toHaveBeenCalled();
    });

    describe('deleting a task', () => {
        beforeEach(() => {
            client.delete.mockImplementation(async () => ({ ok: true }));
        });

        it('asks first, then deletes, from the list', async () => {
            const user = userEvent.setup();
            renderTab('owner');
            await user.click(await screen.findByTestId('delete-task-2'));
            const dialog = await screen.findByRole('dialog');
            expect(dialog).toHaveTextContent('"Task 2" disappears for everyone in the project.');
            expect(client.delete).not.toHaveBeenCalled();
            await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
            await waitFor(() => expect(client.delete).toHaveBeenCalledWith('/api/projects/p1/tasks/2', expect.anything()));
        });

        it('leaves the task when the person says no', async () => {
            const user = userEvent.setup();
            renderTab('owner');
            await user.click(await screen.findByTestId('delete-task-2'));
            await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
            expect(client.delete).not.toHaveBeenCalled();
        });

        it('deletes from a board card too', async () => {
            const user = userEvent.setup();
            renderTab('owner');
            await user.click(await screen.findByRole('radio', { name: 'Board' }));
            await user.click(within(await screen.findByTestId('board-task-3')).getByRole('button', { name: 'Task actions' }));
            await user.click(await screen.findByTestId('delete-task-3'));
            await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
            await waitFor(() => expect(client.delete).toHaveBeenCalledWith('/api/projects/p1/tasks/3', expect.anything()));
        });

        it('offers it to the owner for every task, to an editor only for the tasks they made, and to a viewer never', async () => {
            tasks = [task('own', { createdBy: EDITOR_ID }), task('theirs', { createdBy: OWNER_ID })];
            const { unmount } = render(withQueryClient(<TasksTab {...tabProps('editor', { onOpenSub: vi.fn(), onNavigate: vi.fn() }, { onOpenTab: vi.fn() })} />));
            await screen.findByTestId('project-task-own');
            expect(screen.getByTestId('delete-task-own')).toBeInTheDocument();
            expect(screen.queryByTestId('delete-task-theirs')).not.toBeInTheDocument();
            unmount();
            renderTab('viewer');
            await screen.findByTestId('project-task-own');
            expect(screen.queryByTestId('delete-task-own')).not.toBeInTheDocument();
        });

        it('has Delete in the task form only for someone who may delete it', async () => {
            tasks = [task('theirs', { createdBy: OWNER_ID })];
            const user = userEvent.setup();
            renderTab('editor');
            await user.click(await screen.findByTestId('project-task-theirs'));
            const form = await screen.findByRole('dialog');
            expect(within(form).queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
        });
    });

    describe('a person\'s colour on the tasks', () => {
        beforeEach(() => {
            client.get.mockImplementation(getRouter({
        '/api/projects/p1/board': { columns: ['todo','doing','done'].map(id => ({ id, title: '', status: id, wipLimit: null })), assignments: {}, version: 0 },
                '/api/projects/p1/tasks': () => ({ tasks, role: 'editor' }),
                '/api/projects/p1/members': { ...MEMBERS, people: { ...MEMBERS.people, [EDITOR_ID]: { name: 'Eddie Editor', color: '#f97316' } } },
                '/api/projects/p1/resources': { role: 'editor', documents: [], notebooks: [], meetings: [] },
                '/api/projects/p1/chats': { chats: [], role: 'editor' },
            }));
        });

        it('keeps rows neutral: the person\'s colour lives only in their avatar', async () => {
            renderTab();
            const row = await screen.findByTestId('project-task-1');
            expect(row.getAttribute('style') || '').not.toContain('border-left');
            const avatar = within(row).getByTestId('task-assignees').querySelector('[title="Eddie Editor"]') as HTMLElement;
            expect(avatar.getAttribute('style')).toMatch(/#f97316|rgb\(249, 115, 22\)/);
        });

        it('names the person in the row for a screen reader and the tooltip, in neutral ink', async () => {
            renderTab();
            const row = await screen.findByTestId('project-task-1');
            const assignees = within(row).getByTestId('task-assignees');
            expect(assignees).toHaveAttribute('title', 'Eddie Editor');
            const name = within(assignees).getByText('Eddie Editor');
            expect(name).toHaveClass('sr-only');
            expect(name.getAttribute('style')).toBeNull();
        });

        it('tints the avatar on a board card the same way', async () => {
            const user = userEvent.setup();
            renderTab();
            await user.click(await screen.findByRole('radio', { name: 'Board' }));
            const card = await screen.findByTestId('board-task-1');
            expect(card.getAttribute('style') || '').not.toContain('border-left');
            const avatar = within(card).getByTestId('task-assignees').querySelector('[title="Eddie Editor"]') as HTMLElement;
            expect(avatar.getAttribute('style')).toMatch(/#f97316|rgb\(249, 115, 22\)/);
        });
    });
});


describe('TasksTab: keyboard and saving', () => {
    it('ticks a task from the keyboard without opening it', async () => {
        const user = userEvent.setup();
        renderTab();
        const row = await screen.findByTestId('project-task-2');
        within(row).getByRole('button', { name: 'Mark as done' }).focus();
        await user.keyboard('{Enter}');
        await waitFor(() => expect(client.patch).toHaveBeenCalledWith('/api/projects/p1/tasks/2', { status: 'done' }, expect.anything()));
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('still opens a task with Enter on the row itself', async () => {
        const user = userEvent.setup();
        renderTab();
        (await screen.findByTestId('project-task-2')).focus();
        await user.keyboard('{Enter}');
        expect(await screen.findByRole('dialog')).toBeInTheDocument();
    });

    it('opens a board card with Enter on its title: the drag does not take the key', async () => {
        const user = userEvent.setup();
        renderTab();
        await screen.findByTestId('project-task-1');
        await user.click(screen.getByRole('radio', { name: 'Board' }));
        const card = await screen.findByTestId('board-task-2');
        within(card).getByRole('button', { name: 'Task 2' }).focus();
        await user.keyboard('{Enter}');
        expect(await screen.findByRole('dialog')).toBeInTheDocument();
    });

    it('saves only what was changed, so a colleague\'s change to another field is not undone', async () => {
        const user = userEvent.setup();
        renderTab();
        await user.click(await screen.findByTestId('project-task-2'));
        const title = await screen.findByDisplayValue('Task 2');
        await user.clear(title);
        await user.type(title, 'Renamed');
        await user.click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(client.patch).toHaveBeenCalled());
        expect(client.patch.mock.calls[0][1]).toEqual({ title: 'Renamed' });
    });

    it('sends nothing when nothing was changed', async () => {
        const user = userEvent.setup();
        renderTab();
        await user.click(await screen.findByTestId('project-task-2'));
        await screen.findByDisplayValue('Task 2');
        await user.click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
        expect(client.patch).not.toHaveBeenCalled();
    });

    describe('Improve with AI', () => {
        const suggestion = { title: 'Task 2', description: 'A clearer description.', priority: 'normal', labels: [], checklist: [], assigneeId: null };

        it('does not replace a description the person just typed: it offers the suggestion beside it', async () => {
            const user = userEvent.setup();
            client.post.mockImplementation(async () => ({ suggestion }));
            renderTab();
            await user.click(await screen.findByTestId('project-task-2'));
            await user.type(await screen.findByLabelText('Description'), 'My own words');
            await user.click(screen.getByTestId('task-improve-ai'));
            const offer = await screen.findByTestId('task-ai-description');
            expect(screen.getByLabelText('Description')).toHaveValue('My own words');
            expect(offer).toHaveTextContent('A clearer description.');
            await user.click(within(offer).getByRole('button', { name: 'Use this description' }));
            expect(screen.getByLabelText('Description')).toHaveValue('A clearer description.');
            expect(screen.queryByTestId('task-ai-description')).not.toBeInTheDocument();
        });
    });
});

it('searches task descriptions and restores the search after reopening the tab', async () => {
    const user = userEvent.setup();
    tasks[1].description = 'Unique handover notes';
    const mounted = render(withQueryClient(<TasksTab {...tabProps('editor', { onOpenSub: vi.fn(), onNavigate: vi.fn() })} />));
    await screen.findByTestId('project-task-2');
    await user.type(screen.getByRole('searchbox', { name: 'Search tasks' }), 'handover');
    expect(screen.queryByTestId('project-task-1')).not.toBeInTheDocument();
    expect(screen.getByTestId('project-task-2')).toBeInTheDocument();
    mounted.unmount();
    renderTab();
    await screen.findByTestId('project-task-2');
    expect(screen.getByRole('searchbox', { name: 'Search tasks' })).toHaveValue('handover');
});

it('opens planning, edits a task date range, and sends only changed fields', async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(await screen.findByRole('radio', { name: 'Planning' }));
    expect(await screen.findByTestId('task-planning')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Task 1/ }));
    const dialog = screen.getByRole('dialog', { name: 'Task' });
    const start = within(dialog).getByLabelText('Start date');
    const due = within(dialog).getByLabelText('Due date');
    // Date inputs are edited as ISO dates in every locale.
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.change(start, { target: { value: '2026-10-02' } });
    fireEvent.change(due, { target: { value: '2026-10-06' } });
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(client.patch).toHaveBeenCalledWith('/api/projects/p1/tasks/1', { startDate: '2026-10-02', dueDate: '2026-10-06' }, expect.anything()));
});

it('keeps edited task details when closing is cancelled', async () => {
    const user = userEvent.setup(); renderTab();
    await user.click(await screen.findByText('Task 1'));
    const dialog = screen.getByRole('dialog', { name: 'Task' });
    await user.type(within(dialog).getByLabelText('What needs to be done?'), ' updated');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await user.click(await screen.findByRole('button', { name: 'Keep editing' }));
    expect(within(dialog).getByLabelText('What needs to be done?')).toHaveValue('Task 1 updated');
    expect(client.patch).not.toHaveBeenCalled();
});


describe('planning dependencies', () => {
    it('shows saved hierarchy and related task relationships automatically', async () => {
        const user = userEvent.setup();
        const today = new Date().toISOString().slice(0, 10);
        tasks = [
            task('1', { itemType: 'epic', startDate: today, dueDate: today }),
            task('2', { itemType: 'user-story', parentTaskId: '1', startDate: today, dueDate: today, links: [{ kind: 'task', id: '3' }] }),
            task('3', { parentTaskId: '2', status: 'done', startDate: today, dueDate: today }),
        ];
        renderTab('viewer');
        await screen.findByTestId('project-task-1');
        await user.click(screen.getByRole('radio', { name: 'Planning' }));
        expect(await screen.findByTestId('hierarchy-1:2')).not.toHaveAttribute('marker-end');
        expect(screen.getByTestId('hierarchy-2:3')).not.toHaveAttribute('marker-end');
        expect(screen.getByTestId('related-2:3')).not.toHaveAttribute('marker-end');
        expect(screen.queryByTestId('dependency-1:2')).not.toBeInTheDocument();
        expect(screen.getByRole('img', { name: 'Task relationships' })).toBeInTheDocument();
        expect(client.patch).not.toHaveBeenCalled();
        await user.click(screen.getByRole('button', { name: 'Display' }));
        await user.click(screen.getByRole('checkbox', { name: 'Hide completed' }));
        expect(screen.getByTestId('hierarchy-1:2')).toBeInTheDocument();
        expect(screen.queryByTestId('hierarchy-2:3')).not.toBeInTheDocument();
        expect(screen.queryByTestId('related-2:3')).not.toBeInTheDocument();
    });

    it('updates timeline lines when Relationships are changed and saved in the task dialog', async () => {
        const user = userEvent.setup();
        const today = new Date().toISOString().slice(0, 10);
        tasks = [
            task('1', { itemType: 'epic', startDate: today, dueDate: today }),
            task('2', { itemType: 'user-story', parentTaskId: '1', startDate: today, dueDate: today, links: [{ kind: 'task', id: '1' }] }),
        ];
        client.patch.mockImplementation(async (path: string, patch: Partial<ProjectTask>) => {
            const id = path.split('/').at(-1);
            tasks = tasks.map(item => item.id === id ? { ...item, ...patch } : item);
            return { task: tasks.find(item => item.id === id) };
        });
        renderTab();
        await user.click(await screen.findByRole('radio', { name: 'Planning' }));
        expect(await screen.findByTestId('hierarchy-1:2')).toBeInTheDocument();
        expect(screen.getByTestId('related-1:2')).toBeInTheDocument();
        await user.click(within(screen.getByTestId('planning-row-2')).getByRole('button', { name: /^Task 2/ }));
        const dialog = await screen.findByRole('dialog', { name: 'Task' });
        await user.selectOptions(within(dialog).getByLabelText('Parent work item'), '');
        await user.selectOptions(within(dialog).getByLabelText('Relationship with Task 1'), 'depends_on');
        await user.click(within(dialog).getByRole('button', { name: 'Save' }));
        expect(await screen.findByTestId('dependency-1:2')).toHaveAttribute('marker-end');
        expect(screen.queryByTestId('hierarchy-1:2')).not.toBeInTheDocument();
        expect(screen.queryByTestId('related-1:2')).not.toBeInTheDocument();
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
        await user.click(within(screen.getByTestId('planning-row-2')).getByRole('button', { name: /^Task 2/ }));
        await user.click(screen.getByRole('button', { name: 'Unlink Task 1' }));
        await user.click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(screen.queryByTestId('dependency-1:2')).not.toBeInTheDocument());
    });

    it('connects two scheduled tasks and shows existing dependency arrows', async () => {
        const user = userEvent.setup();
        const today = new Date().toISOString().slice(0, 10);
        tasks[0] = { ...tasks[0], startDate: today, dueDate: today };
        tasks[1] = { ...tasks[1], startDate: today, dueDate: today, links: [{ kind: 'task', id: '1', relation: 'depends_on' }] };
        renderTab();
        await screen.findByTestId('project-task-1');
        await user.click(screen.getByRole('radio', { name: 'Planning' }));
        expect(await screen.findByTestId('dependency-1:2')).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Connect dependency from Task 1' }));
        await user.click(screen.getByRole('button', { name: 'Make Task 2 depend on the selected task' }));
        await waitFor(() => expect(client.patch).toHaveBeenCalledWith('/api/projects/p1/tasks/2', { links: [{ kind: 'task', id: '1', relation: 'depends_on' }] }, expect.anything()));
    });
});
