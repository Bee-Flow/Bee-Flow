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
    try { localStorage.clear(); } catch { /* none */ }
    tasks = [
        task('1', { assigneeIds: [EDITOR_ID], priority: 'urgent', labels: ['launch'], checklist: [{ id: 'c1', text: 'a', done: true }, { id: 'c2', text: 'b', done: false }] }),
        task('2', { status: 'doing', sortOrder: 1000 }),
        task('3', { status: 'done', sortOrder: 1000 }),
    ];
    for (const m of ['get', 'post', 'put', 'patch', 'delete'] as const) client[m] = vi.fn();
    client.get.mockImplementation(getRouter({
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

    it('filters by who a task is given to', async () => {
        const user = userEvent.setup();
        renderTab();
        await screen.findByTestId('project-task-1');
        await user.selectOptions(screen.getByLabelText('Show'), 'me');
        expect(screen.getByTestId('project-task-1')).toBeInTheDocument();
        expect(screen.queryByTestId('project-task-2')).not.toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Clear filters' }));
        expect(screen.getByTestId('project-task-2')).toBeInTheDocument();
    });

    it('shows a board with a column per status, and moves a card through its Move-to list', async () => {
        const user = userEvent.setup();
        renderTab();
        await screen.findByTestId('project-task-1');
        await user.click(screen.getByRole('radio', { name: 'Board' }));
        const board = await screen.findByTestId('project-task-board');
        const todo = within(within(board).getByTestId('board-column-todo'));
        expect(todo.getByTestId('board-task-1')).toBeInTheDocument();
        await user.selectOptions(within(screen.getByTestId('board-task-1')).getByLabelText('Move to'), 'doing');
        await waitFor(() => expect(client.patch).toHaveBeenCalled());
        const [path, body] = client.patch.mock.calls[0];
        expect(path).toBe('/api/projects/p1/tasks/1');
        expect(body).toEqual({ status: 'doing', beforeId: null });
    });

    it('ticks a task done from the list', async () => {
        const user = userEvent.setup();
        renderTab();
        const row = await screen.findByTestId('project-task-2');
        await user.click(within(row).getByRole('button', { name: 'Mark as done' }));
        await waitFor(() => expect(client.patch).toHaveBeenCalledWith('/api/projects/p1/tasks/2', { status: 'done' }, expect.anything()));
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
                '/api/projects/p1/tasks': () => ({ tasks, role: 'editor' }),
                '/api/projects/p1/members': { ...MEMBERS, people: { ...MEMBERS.people, [EDITOR_ID]: { name: 'Eddie Editor', color: '#f97316' } } },
                '/api/projects/p1/resources': { role: 'editor', documents: [], notebooks: [], meetings: [] },
                '/api/projects/p1/chats': { chats: [], role: 'editor' },
            }));
        });

        it('gives a task a quiet edge in the colour of the person who has it, and none when nobody does', async () => {
            renderTab();
            const row = await screen.findByTestId('project-task-1');
            expect(row.getAttribute('style')).toMatch(/border-left-color: color-mix\(in srgb, (#f97316|rgb\(249, 115, 22\)) 60%/);
            expect(screen.getByTestId('project-task-2').getAttribute('style') || '').not.toContain('border-left');
        });

        it('names the person in their colour', async () => {
            renderTab();
            const row = await screen.findByTestId('project-task-1');
            const name = within(row).getByTestId('task-assignees').querySelector('span:last-child') as HTMLElement;
            expect(name.getAttribute('style')).toMatch(/#f97316|rgb\(249, 115, 22\)/);
        });

        it('paints the card on the board the same way', async () => {
            const user = userEvent.setup();
            renderTab();
            await user.click(await screen.findByRole('radio', { name: 'Board' }));
            expect((await screen.findByTestId('board-task-1')).getAttribute('style')).toMatch(/#f97316|rgb\(249, 115, 22\)/);
        });
    });
});

