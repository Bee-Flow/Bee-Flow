import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withQueryClient } from '../../../../test/queryWrapper';
import { EDITOR_ID, getRouter, OWNER_ID } from '../content/contentTestKit';
import type { ProjectTask } from '../../../../api/queries/projectTasks';
import type { Sprint } from '../../../../api/queries/projectSprints';
import { setCurrentUser } from '../../../../utils/scopedStorage';
import type { ChatPeople } from '../chat/chatPeople';

const { client } = vi.hoisted(() => ({ client: {} as Record<'get' | 'post' | 'put' | 'patch' | 'delete', ReturnType<typeof vi.fn>> }));
vi.mock('../../../../api/client', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../../api/client')>()),
    apiClient: client,
    default: client,
}));

import SprintBuilder from './SprintBuilder';

const task = (id: string, extra: Partial<ProjectTask> = {}): ProjectTask => ({
    id, title: `Task ${id}`, description: '', status: 'todo', priority: 'normal', labels: [], checklist: [], sortOrder: 1000, source: null,
    assigneeIds: [], links: [], dueDate: null, createdBy: OWNER_ID, completedAt: null, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', ...extra,
});

const PEOPLE: ChatPeople = {
    people: [{ id: EDITOR_ID, name: 'Eddie Editor' }],
    nameOf: id => (id === EDITOR_ID ? 'Eddie Editor' : ''),
    colorOf: () => '',
    avatarOf: () => undefined,
};

let tasks: ProjectTask[];

beforeEach(() => {
    setCurrentUser(EDITOR_ID);
    try { localStorage.clear(); } catch { /* none */ }
    tasks = [
        task('t1', { priority: 'urgent', storyPoints: 3 }),
        task('t2', { priority: 'normal', storyPoints: 5 }),
        task('t3', { priority: 'normal' }),
        task('t4', { status: 'done', storyPoints: 8 }),
        task('t5', { sprintId: 's1', storyPoints: 2 }),
    ];
    for (const m of ['get', 'post', 'put', 'patch', 'delete'] as const) client[m] = vi.fn();
    client.get.mockImplementation(getRouter({
        '/api/projects/p1/tasks/poker/session': { session: null },
    }));
    client.post.mockImplementation(async (path: string) => {
        if (path === '/api/projects/p1/sprints') return { sprint: { id: 's-new' } as Sprint };
        return { ok: true };
    });
});

function renderBuilder() {
    const handlers = { onClose: vi.fn(), onCreated: vi.fn() };
    render(withQueryClient(<SprintBuilder projectId="p1" tasks={tasks} canEdit people={PEOPLE} {...handlers} />));
    return handlers;
}

describe('SprintBuilder', () => {
    it('lists only the open backlog items as candidates', async () => {
        renderBuilder();
        await screen.findByTestId('sprint-builder');
        expect(screen.getByTestId('builder-pick-t1')).toBeInTheDocument();
        expect(screen.queryByTestId('builder-pick-t4')).not.toBeInTheDocument();
        expect(screen.queryByTestId('builder-pick-t5')).not.toBeInTheDocument();
    });

    it('auto-fills the pick in priority order up to the capacity', async () => {
        const user = userEvent.setup();
        renderBuilder();
        await user.type(await screen.findByTestId('builder-capacity'), '4');
        await user.click(screen.getByTestId('builder-autofill'));
        expect(screen.getByTestId('builder-pick-t1')).toBeChecked();
        expect(screen.getByTestId('builder-pick-t2')).not.toBeChecked();
        expect(screen.getByTestId('builder-pick-t3')).not.toBeChecked();
    });

    it('starts a queued poker session over the picked unestimated items', async () => {
        const user = userEvent.setup();
        renderBuilder();
        await screen.findByTestId('sprint-builder');
        // An estimated pick alone does not open the estimate step.
        await user.click(screen.getByTestId('builder-pick-t1'));
        expect(screen.queryByTestId('builder-estimate')).not.toBeInTheDocument();
        // Picking an unestimated item does.
        await user.click(screen.getByTestId('builder-pick-t3'));
        await user.click(await screen.findByTestId('builder-estimate'));
        await waitFor(() => expect(client.post).toHaveBeenCalledWith('/api/projects/p1/tasks/poker/session/start', { taskIds: ['t3'] }, expect.anything()));
    });

    it('flags the picks without an estimate and warns when the plan runs over capacity', async () => {
        const user = userEvent.setup();
        renderBuilder();
        await screen.findByTestId('sprint-builder');
        expect(screen.getByText('No estimate')).toBeInTheDocument();
        await user.type(screen.getByTestId('builder-capacity'), '4');
        await user.click(screen.getByTestId('builder-pick-t1'));
        await user.click(screen.getByTestId('builder-pick-t2'));
        expect(screen.getByRole('status')).toHaveTextContent('8 of 4 pts picked');
        expect(screen.getByRole('progressbar', { name: /8 of 4 points planned/ })).toBeInTheDocument();
    });

    it('goes back to planning', async () => {
        const user = userEvent.setup();
        const handlers = renderBuilder();
        await user.click(await screen.findByRole('button', { name: 'Back to planning' }));
        expect(handlers.onClose).toHaveBeenCalled();
    });

    it('creates the sprint and assigns the picked items', async () => {
        const user = userEvent.setup();
        const handlers = renderBuilder();
        await screen.findByTestId('sprint-builder');
        await user.click(screen.getByTestId('builder-pick-t1'));
        await user.click(screen.getByTestId('builder-pick-t2'));
        await user.type(screen.getByTestId('builder-name'), 'Sprint 4');
        await user.click(screen.getByRole('button', { name: 'Create sprint with 2 items' }));
        await waitFor(() => expect(client.post).toHaveBeenCalledWith('/api/projects/p1/sprints', expect.objectContaining({ name: 'Sprint 4' }), expect.anything()));
        await waitFor(() => expect(client.post).toHaveBeenCalledWith('/api/projects/p1/sprints/s-new/items', { taskIds: ['t1', 't2'] }, expect.anything()));
        await waitFor(() => expect(handlers.onCreated).toHaveBeenCalled());
    });
});
