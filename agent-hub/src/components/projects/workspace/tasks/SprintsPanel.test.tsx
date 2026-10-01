import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withQueryClient } from '../../../../test/queryWrapper';
import { EDITOR_ID, getRouter, OWNER_ID } from '../content/contentTestKit';
import type { ProjectTask } from '../../../../api/queries/projectTasks';
import type { Sprint } from '../../../../api/queries/projectSprints';
import scopedStorage, { setCurrentUser } from '../../../../utils/scopedStorage';

const { client } = vi.hoisted(() => ({ client: {} as Record<'get' | 'post' | 'put' | 'patch' | 'delete', ReturnType<typeof vi.fn>> }));
vi.mock('../../../../api/client', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../../api/client')>()),
    apiClient: client,
    default: client,
}));

import SprintsPanel from './SprintsPanel';

const task = (id: string, extra: Partial<ProjectTask> = {}): ProjectTask => ({
    id, title: `Task ${id}`, description: '', status: 'todo', priority: 'normal', labels: [], checklist: [], sortOrder: 1000, source: null,
    assigneeIds: [], links: [], dueDate: null, createdBy: OWNER_ID, completedAt: null, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', ...extra,
});

const sprint = (id: string, extra: Partial<Sprint> = {}): Sprint => ({
    id, name: `Sprint ${id}`, goal: '', status: 'planned', startDate: '2026-10-05', endDate: '2026-10-18', capacityPoints: 20,
    sortOrder: 1, itemCount: 1, pointsTotal: 5, pointsDone: 0, doneCount: 0,
    createdBy: OWNER_ID, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', ...extra,
});

let sprints: Sprint[];
let tasks: ProjectTask[];

function renderPanel(canEdit = true) {
    const handlers = { onOpen: vi.fn(), onPlanWithPoker: vi.fn() };
    render(withQueryClient(<SprintsPanel projectId="p1" tasks={tasks} canEdit={canEdit} {...handlers} />));
    return handlers;
}

beforeEach(() => {
    setCurrentUser(EDITOR_ID);
    try { localStorage.clear(); } catch { /* none */ }
    sprints = [sprint('s1'), sprint('s2', { name: 'Old sprint', status: 'closed', doneCount: 3, itemCount: 3, pointsDone: 8, pointsTotal: 8 })];
    tasks = [task('t1', { sprintId: 's1', storyPoints: 5 }), task('t2', { storyPoints: 3 })];
    for (const m of ['get', 'post', 'put', 'patch', 'delete'] as const) client[m] = vi.fn();
    client.get.mockImplementation(getRouter({
        '/api/projects/p1/sprints': () => ({ sprints }),
    }));
    client.post.mockImplementation(async (path: string, body: Record<string, unknown>) =>
        path === '/api/projects/p1/sprints' ? { sprint: sprint('s-new', { name: String(body?.name || ''), startDate: body?.startDate as string | null, endDate: body?.endDate as string | null }) } : { ok: true });
    client.patch.mockImplementation(async (_path: string, body: Partial<ProjectTask>) => ({ task: { ...tasks[0], ...body } }));
});

describe('SprintsPanel', () => {
    it('lists the sprints with status, dates, capacity and progress, and the closed ones in the folded history', async () => {
        const user = userEvent.setup();
        renderPanel();
        const row = await screen.findByTestId('sprint-card-s1');
        expect(row).toHaveTextContent('Sprint s1');
        expect(row).toHaveTextContent('Planned');
        expect(row).toHaveTextContent(/Oct 5|5 Oct/);
        expect(row).not.toHaveTextContent('2026-10-05');
        expect(row).toHaveTextContent('5/20 pts');
        const history = screen.getByTestId('sprint-history');
        expect(history).not.toHaveTextContent('Old sprint');
        await user.click(within(history).getByRole('button', { name: /Finished sprints/ }));
        expect(history).toHaveTextContent('Old sprint');
    });

    it('opens the panel on the work, with the create form only behind "New sprint"', async () => {
        renderPanel();
        await screen.findByTestId('sprint-detail');
        expect(screen.queryByTestId('sprint-create-form')).not.toBeInTheDocument();
        expect(screen.getByTestId('sprint-new-row')).toBeInTheDocument();
    });

});

describe('SprintsPanel actions', () => {
    it('offers planning with poker next to the list', async () => {
        const user = userEvent.setup();
        const handlers = renderPanel();
        await user.click(await screen.findByTestId('plan-sprint-with-poker'));
        expect(handlers.onPlanWithPoker).toHaveBeenCalled();
    });

    it('renders "New sprint" with the poker option in the sub-nav slot when one is given', async () => {
        const user = userEvent.setup();
        const slot = document.createElement('div');
        document.body.appendChild(slot);
        const onPlanWithPoker = vi.fn();
        render(withQueryClient(<SprintsPanel projectId="p1" tasks={tasks} canEdit onOpen={vi.fn()} onPlanWithPoker={onPlanWithPoker} actionsSlot={slot} />));
        await user.click(await within(slot).findByTestId('sprint-new-menu'));
        await user.click(await screen.findByTestId('plan-sprint-with-poker'));
        expect(onPlanWithPoker).toHaveBeenCalled();
        await user.click(within(slot).getByTestId('sprint-new-menu'));
        await user.click(await screen.findByRole('menuitem', { name: 'New sprint' }));
        expect(await screen.findByTestId('sprint-create-form')).toBeInTheDocument();
        slot.remove();
    });

    it('deletes a planned sprint from its menu after confirming', async () => {
        const user = userEvent.setup();
        renderPanel();
        await user.click(await screen.findByTestId('sprint-more'));
        await user.click(await screen.findByTestId('sprint-delete'));
        const dialog = await screen.findByRole('dialog');
        await user.click(within(dialog).getByRole('button', { name: 'Delete sprint' }));
        await waitFor(() => expect(client.delete).toHaveBeenCalledWith('/api/projects/p1/sprints/s1', expect.anything()));
    });

});

describe('SprintsPanel editing', () => {
    it('renames a sprint in place', async () => {
        const user = userEvent.setup();
        renderPanel();
        await user.click(await screen.findByTestId('sprint-more'));
        await user.click(await screen.findByRole('menuitem', { name: 'Rename' }));
        const input = screen.getByLabelText('Sprint name');
        await user.clear(input);
        await user.type(input, 'Sprint renamed{Enter}');
        await waitFor(() => expect(client.patch).toHaveBeenCalledWith('/api/projects/p1/sprints/s1', { name: 'Sprint renamed' }, expect.anything()));
    });

    it('carries the legacy sprint label of its items along with a rename', async () => {
        tasks = [task('t1', { sprintId: 's1', storyPoints: 5, labels: ['bf:sprint:Sprint s1'] }), task('t2', { storyPoints: 3 })];
        client.patch.mockImplementation(async (path: string, body: Record<string, unknown>) =>
            path.includes('/sprints/') ? { sprint: sprint('s1', { name: String(body.name) }) } : { task: { ...tasks[0], ...body } });
        const user = userEvent.setup();
        renderPanel();
        await user.click(await screen.findByTestId('sprint-more'));
        await user.click(await screen.findByRole('menuitem', { name: 'Rename' }));
        const input = screen.getByLabelText('Sprint name');
        await user.clear(input);
        await user.type(input, 'Sprint renamed{Enter}');
        await waitFor(() => expect(client.patch).toHaveBeenCalledWith(expect.stringContaining('/tasks/t1'),
            expect.objectContaining({ labels: expect.arrayContaining(['bf:sprint:Sprint renamed']) }), expect.anything()));
    });

    it('shows the done count of an open sprint as text in its row', async () => {
        sprints = [sprint('s1', { itemCount: 4, doneCount: 1 })];
        renderPanel();
        expect(await screen.findByTestId('sprint-card-s1')).toHaveTextContent('1/4 done');
    });

    it('shows no edit controls to a viewer', async () => {
        renderPanel(false);
        await screen.findByTestId('sprint-detail');
        expect(screen.queryByTestId('sprint-start')).not.toBeInTheDocument();
        expect(screen.queryByTestId('sprint-more')).not.toBeInTheDocument();
        expect(screen.queryByTestId('sprint-new-row')).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Add' })).not.toBeInTheDocument();
    });

    it('starts from a short empty state that opens the form in place', async () => {
        sprints = [];
        const user = userEvent.setup();
        renderPanel();
        expect(await screen.findByText('No sprints yet')).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Create sprint' }));
        expect(await screen.findByTestId('sprint-create-form')).toBeInTheDocument();
    });

    it('creates a sprint with a length-derived end date', async () => {
        const user = userEvent.setup();
        renderPanel();
        await user.click(await screen.findByTestId('sprint-new-row'));
        const form = await screen.findByTestId('sprint-create-form');
        await user.type(within(form).getByLabelText('Sprint name'), 'Sprint 9');
        await user.click(within(form).getByLabelText('Start date'));
        const { fireEvent } = await import('@testing-library/react');
        fireEvent.change(within(form).getByLabelText('Start date'), { target: { value: '2026-10-05' } });
        await user.click(within(form).getByRole('button', { name: 'Create sprint' }));
        await waitFor(() => expect(client.post).toHaveBeenCalledWith('/api/projects/p1/sprints', expect.objectContaining({ name: 'Sprint 9', startDate: '2026-10-05', endDate: '2026-10-18' }), expect.anything()));
    });

    it('adds a backlog item to the sprint and mirrors the membership into its labels', async () => {
        const user = userEvent.setup();
        renderPanel();
        const detail = await screen.findByTestId('sprint-detail');
        expect(within(detail).getByText('Task t1')).toBeInTheDocument();
        await user.click(within(detail).getByRole('button', { name: 'Add' }));
        await waitFor(() => expect(client.post).toHaveBeenCalledWith('/api/projects/p1/sprints/s1/items', { taskIds: ['t2'] }, expect.anything()));
        expect(client.patch).toHaveBeenCalledWith('/api/projects/p1/tasks/t2',
            { labels: ['bf:sprint:Sprint s1', 'bf:sprint-start:2026-10-05', 'bf:sprint-end:2026-10-18'] }, expect.anything());
    });

    it('starts a sprint only after the person confirms', async () => {
        const user = userEvent.setup();
        renderPanel();
        await user.click(await screen.findByTestId('sprint-start'));
        const dialog = await screen.findByRole('dialog');
        expect(client.post).not.toHaveBeenCalledWith('/api/projects/p1/sprints/s1/start', {}, expect.anything());
        await user.click(within(dialog).getByRole('button', { name: 'Start sprint' }));
        await waitFor(() => expect(client.post).toHaveBeenCalledWith('/api/projects/p1/sprints/s1/start', {}, expect.anything()));
    });

    it('offers to import locally saved sprints only when the server has none', async () => {
        scopedStorage.setItem('project-sprints:p1', JSON.stringify([{ name: 'Local sprint', start: '2026-09-01', end: '2026-09-14' }]));
        // Sprints exist on the server: no import offer.
        const first = render(withQueryClient(<SprintsPanel projectId="p1" tasks={tasks} canEdit onOpen={vi.fn()} />));
        await screen.findByTestId('sprints-panel');
        expect(screen.queryByTestId('sprint-legacy-import')).not.toBeInTheDocument();
        first.unmount();
        // Empty server list: the offer appears and recreates the local sprints.
        sprints = [];
        renderPanel();
        const user = userEvent.setup();
        await user.click(await screen.findByRole('button', { name: 'Import my locally saved sprints' }));
        await waitFor(() => expect(client.post).toHaveBeenCalledWith('/api/projects/p1/sprints', expect.objectContaining({ name: 'Local sprint', startDate: '2026-09-01', endDate: '2026-09-14' }), expect.anything()));
        await waitFor(() => expect(scopedStorage.getItem('project-sprints:p1')).toBeNull());
    });
});
