import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withQueryClient } from '../../../../test/queryWrapper';
import { EDITOR_ID, getRouter, OWNER_ID } from '../content/contentTestKit';
import type { PokerSession, ProjectTask } from '../../../../api/queries/projectTasks';
import { setCurrentUser } from '../../../../utils/scopedStorage';
import type { ChatPeople } from '../chat/chatPeople';

const { client } = vi.hoisted(() => ({ client: {} as Record<'get' | 'post' | 'put' | 'patch' | 'delete', ReturnType<typeof vi.fn>> }));
vi.mock('../../../../api/client', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../../api/client')>()),
    apiClient: client,
    default: client,
}));

import PokerPanel from './PokerPanel';

const task = (id: string, extra: Partial<ProjectTask> = {}): ProjectTask => ({
    id, title: `Task ${id}`, description: '', status: 'todo', priority: 'normal', labels: [], checklist: [], sortOrder: 1000, source: null,
    assigneeIds: [], links: [], dueDate: null, createdBy: OWNER_ID, completedAt: null, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', ...extra,
});

const PEOPLE: ChatPeople = {
    people: [{ id: OWNER_ID, name: 'Olivia Owner' }, { id: EDITOR_ID, name: 'Eddie Editor' }],
    nameOf: id => ({ [OWNER_ID]: 'Olivia Owner', [EDITOR_ID]: 'Eddie Editor' })[id || ''] || '',
    colorOf: () => '',
    avatarOf: () => undefined,
};

const session = (extra: Partial<PokerSession> = {}): PokerSession => ({
    sessionId: 'ps1', taskId: 't1', taskTitle: 'Task t1', phase: 'voting', startedBy: OWNER_ID,
    voterIds: [], ownVote: null, votes: null, queueTaskIds: [], queueTitles: [], ...extra,
});

let current: PokerSession | null;

beforeEach(() => {
    setCurrentUser(EDITOR_ID);
    current = null;
    for (const m of ['get', 'post', 'put', 'patch', 'delete'] as const) client[m] = vi.fn();
    client.get.mockImplementation(getRouter({
        '/api/projects/p1/tasks/poker/session': () => ({ session: current }),
    }));
    client.post.mockImplementation(async () => ({ session: current, ok: true }));
});

function renderPanel(tasks: ProjectTask[] = [task('t1'), task('t2'), task('t3')], canEdit = true) {
    render(withQueryClient(<PokerPanel projectId="p1" tasks={tasks} canEdit={canEdit} people={PEOPLE} />));
}

describe('PokerPanel', () => {
    it('starts a session for the chosen item', async () => {
        const user = userEvent.setup();
        renderPanel();
        await user.click(await screen.findByRole('button', { name: /Task t2/ }));
        await user.click(screen.getByRole('button', { name: /Start planning poker/ }));
        await waitFor(() => expect(client.post).toHaveBeenCalledWith('/api/projects/p1/tasks/poker/session/start', { taskId: 't2' }, expect.anything()));
    });

    it('shows the queued items and saves the estimate into the next one when revealed', async () => {
        current = session({ phase: 'revealed', queueTaskIds: ['t2', 't3'], queueTitles: ['Task t2', 'Task t3'] });
        const user = userEvent.setup();
        renderPanel();
        const queue = await screen.findByTestId('poker-queue');
        expect(queue).toHaveTextContent('Task t2');
        expect(queue).toHaveTextContent('Task t3');
        await user.click(screen.getByRole('button', { name: '5' }));
        await user.click(screen.getByRole('button', { name: 'Save estimate & next item' }));
        await waitFor(() => expect(client.post).toHaveBeenCalledWith('/api/projects/p1/tasks/poker/session/next', { sessionId: 'ps1', storyPoints: 5 }, expect.anything()));
    });

    it('shows who has voted while voting, and casts your card', async () => {
        current = session({ voterIds: [OWNER_ID] });
        const user = userEvent.setup();
        renderPanel();
        expect(await screen.findByText('Voting · 1 voted')).toBeInTheDocument();
        expect(screen.getByRole('img', { name: 'Ready' })).toBeInTheDocument();
        expect(screen.getByRole('img', { name: 'Choosing…' })).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: '8' }));
        await waitFor(() => expect(client.post).toHaveBeenCalledWith('/api/projects/p1/tasks/poker/session/vote', { sessionId: 'ps1', vote: '8' }, expect.anything()));
        await user.click(screen.getByRole('button', { name: 'Reveal votes' }));
        await waitFor(() => expect(client.post).toHaveBeenCalledWith('/api/projects/p1/tasks/poker/session/reveal', { sessionId: 'ps1' }, expect.anything()));
    });

    it('folds the queue away and back', async () => {
        current = session({ phase: 'revealed', queueTaskIds: ['t2'], queueTitles: ['Task t2'] });
        const user = userEvent.setup();
        renderPanel();
        const queue = await screen.findByTestId('poker-queue');
        await user.click(within(queue).getByRole('button', { name: /Up next/ }));
        expect(queue).not.toHaveTextContent('Task t2');
    });

    it('lets a viewer watch but not start a session', async () => {
        const user = userEvent.setup();
        renderPanel(undefined, false);
        await user.click(await screen.findByRole('button', { name: /Task t2/ }));
        expect(screen.getByRole('button', { name: /Start planning poker/ })).toBeDisabled();
    });

    it('finishes instead of advancing when the queue is empty', async () => {
        current = session({ phase: 'revealed' });
        const user = userEvent.setup();
        renderPanel();
        await screen.findByRole('button', { name: 'Save estimate & finish' });
        expect(screen.queryByTestId('poker-queue')).not.toBeInTheDocument();
    });
});
