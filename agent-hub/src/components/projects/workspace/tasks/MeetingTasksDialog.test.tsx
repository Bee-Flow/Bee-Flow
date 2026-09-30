import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranslateFn } from '../../../../hooks/useTranslation';
import { withQueryClient } from '../../../../test/queryWrapper';
import { EDITOR_ID, getRouter, MEMBERS, OWNER_ID } from '../content/contentTestKit';

const { client } = vi.hoisted(() => ({ client: {} as Record<'get' | 'post' | 'put' | 'patch' | 'delete', ReturnType<typeof vi.fn>> }));
vi.mock('../../../../api/client', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../../api/client')>()),
    apiClient: client,
    default: client,
}));

import MeetingTasksDialog, { descriptionFor } from './MeetingTasksDialog';

const SUGGESTIONS = [
    { itemId: 'ai-1', text: 'Send the offer', assigneeName: 'Eddie', suggestedAssigneeId: EDITOR_ID, dueDate: '2026-11-03', at: '2:05', done: false, createdTaskId: null },
    { itemId: 'ai-2', text: 'Book a room', assigneeName: 'Carla', suggestedAssigneeId: null, dueDate: null, at: '', done: false, createdTaskId: null },
    { itemId: 'ai-3', text: 'Already handled', assigneeName: '', suggestedAssigneeId: null, dueDate: null, at: '', done: true, createdTaskId: null },
    { itemId: 'ai-5', text: 'Nobody named', assigneeName: 'Niet toegewezen', suggestedAssigneeId: null, dueDate: null, at: '', done: true, createdTaskId: null },
    { itemId: 'ai-4', text: 'Old news', assigneeName: '', suggestedAssigneeId: null, dueDate: null, at: '', done: false, createdTaskId: 't-9' },
];

const IMPROVED = [
    { itemId: 'ai-1', title: 'Send the offer to Acme', description: 'Eddie sends the offer, so Acme can decide this week.', priority: 'high', labels: ['sales'], checklist: [{ id: 'c1', text: 'Draft', done: false }], assigneeId: EDITOR_ID },
    { itemId: 'ai-2', title: 'Book a room for the workshop', description: 'Find a room for twelve people.', priority: 'normal', labels: ['workshop'], checklist: [], assigneeId: OWNER_ID },
];

function renderDialog(props: Partial<React.ComponentProps<typeof MeetingTasksDialog>> = {}) {
    const onClose = vi.fn();
    const onCreated = vi.fn();
    render(withQueryClient(<MeetingTasksDialog projectId="p1" currentUser={{ id: OWNER_ID, name: 'Olivia Owner' }} meetingId="mt-1" onClose={onClose} onCreated={onCreated} {...props} />));
    return { onClose, onCreated };
}

beforeEach(() => {
    for (const m of ['get', 'post', 'put', 'patch', 'delete'] as const) client[m] = vi.fn();
    client.get.mockImplementation(getRouter({
        '/api/projects/p1/meetings/mt-1/task-suggestions': { meeting: { id: 'mt-1', title: 'Weekly' }, suggestions: SUGGESTIONS },
        '/api/projects/p1/members': MEMBERS,
        '/api/projects/p1/resources': { role: 'editor', meetings: [{ id: 'mt-1', title: 'Weekly', actionItemCount: 4 }] },
    }));
    client.post.mockImplementation(async (path: string, body: { items: unknown[] }) => {
        if (path.endsWith('/task-suggestions/improve')) return { items: IMPROVED };
        return { tasks: body.items, skipped: 0 };
    });
});

describe('MeetingTasksDialog', () => {
    it('offers the open action items ticked, and leaves finished and already-made ones off', async () => {
        renderDialog();
        expect(await screen.findByTestId('suggestion-ai-1')).toBeInTheDocument();
        expect(within(screen.getByTestId('suggestion-ai-1')).getByRole('checkbox')).toBeChecked();
        expect(within(screen.getByTestId('suggestion-ai-2')).getByRole('checkbox')).toBeChecked();
        expect(within(screen.getByTestId('suggestion-ai-3')).getByRole('checkbox')).not.toBeChecked();
        const made = screen.getByTestId('suggestion-ai-4');
        expect(within(made).getByRole('checkbox')).toBeDisabled();
        expect(within(made).getByText('Already a task')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Make 2 tasks' })).toBeEnabled();
    });

    it('points a name at a member when the notes name one, and says what the notes said when not', async () => {
        renderDialog();
        const row = await screen.findByTestId('suggestion-ai-1');
        expect(within(row).getByLabelText('Assigned to')).toHaveValue(EDITOR_ID);
        expect(within(screen.getByTestId('suggestion-ai-2')).getByText('The notes say: Carla')).toBeInTheDocument();
        expect(screen.queryByText(/The notes say: Niet/)).not.toBeInTheDocument();
    });

    it('creates only the ticked items, with the edits, and links each back to its meeting item', async () => {
        const user = userEvent.setup();
        const { onCreated, onClose } = renderDialog();
        const second = await screen.findByTestId('suggestion-ai-2');
        await user.click(within(second).getByRole('checkbox'));
        const first = screen.getByTestId('suggestion-ai-1');
        const title = within(first).getByLabelText('What needs to be done?');
        await user.clear(title);
        await user.type(title, 'Send the offer to Acme');
        await user.selectOptions(within(first).getByLabelText('Priority'), 'high');
        await user.click(screen.getByRole('button', { name: 'Make 1 tasks' }));
        await waitFor(() => expect(client.post).toHaveBeenCalledWith('/api/projects/p1/tasks/batch', expect.anything(), expect.anything()));
        const [, body] = client.post.mock.calls.find(c => c[0] === '/api/projects/p1/tasks/batch')!;
        expect(body.items).toEqual([{
            title: 'Send the offer to Acme',
            description: 'Eddie sends the offer, so Acme can decide this week.\n\nFrom the meeting "Weekly", at 2:05.',
            labels: ['sales'],
            checklist: [{ id: 'c1', text: 'Draft', done: false }],
            assigneeIds: [EDITOR_ID],
            dueDate: '2026-11-03',
            priority: 'high',
            source: { kind: 'meeting', id: 'mt-1', itemId: 'ai-1' },
        }]);
        await waitFor(() => expect(onCreated).toHaveBeenCalledWith(1));
        expect(onClose).toHaveBeenCalled();
    });

    it('selects all or none, and cannot make tasks from nothing', async () => {
        const user = userEvent.setup();
        renderDialog();
        await screen.findByTestId('suggestion-ai-1');
        await user.click(screen.getByRole('button', { name: 'Select none' }));
        expect(screen.getByRole('button', { name: 'Make 0 tasks' })).toBeDisabled();
        await user.click(screen.getByRole('button', { name: 'Select all' }));
        expect(screen.getByRole('button', { name: 'Make 4 tasks' })).toBeEnabled();
        expect(within(screen.getByTestId('suggestion-ai-4')).getByRole('checkbox')).not.toBeChecked();
    });

    it('asks which meeting when none is given', async () => {
        const user = userEvent.setup();
        renderDialog({ meetingId: null });
        await user.click(await screen.findByTestId('pick-meeting-mt-1'));
        expect(await screen.findByTestId('suggestion-ai-1')).toBeInTheDocument();
    });

    it('says when a meeting has no action items', async () => {
        client.get.mockImplementation(getRouter({
            '/api/projects/p1/meetings/mt-1/task-suggestions': { meeting: { id: 'mt-1', title: 'Weekly' }, suggestions: [] },
            '/api/projects/p1/members': MEMBERS,
        }));
        renderDialog();
        expect(await screen.findByText('This meeting has no action items.')).toBeInTheDocument();
    });
});

describe('MeetingTasksDialog: the AI expands the items', () => {
    it('fills in description, labels and steps by itself, and picks a person only for an item the notes left open', async () => {
        renderDialog();
        const first = await screen.findByTestId('suggestion-ai-1');
        await waitFor(() => expect(within(first).getByLabelText('Description')).toHaveValue('Eddie sends the offer, so Acme can decide this week.'));
        expect(within(first).getByText('sales')).toBeInTheDocument();
        expect(within(first).getByText('1 steps')).toBeInTheDocument();
        expect(within(first).getByLabelText('Priority')).toHaveValue('high');
        // The notes named Eddie for the first item: that stays, and is not credited to the AI.
        expect(within(first).getByLabelText('Assigned to')).toHaveValue(EDITOR_ID);
        expect(screen.queryByTestId('ai-assignee-ai-1')).not.toBeInTheDocument();
        // Nobody was named for the second: the AI chose, and says so.
        const second = screen.getByTestId('suggestion-ai-2');
        await waitFor(() => expect(within(second).getByLabelText('Assigned to')).toHaveValue(OWNER_ID));
        expect(screen.getByTestId('ai-assignee-ai-2')).toBeInTheDocument();
        expect(client.post).toHaveBeenCalledWith('/api/projects/p1/meetings/mt-1/task-suggestions/improve', {}, expect.anything());
    });

    it('asks once when opened, and again only when the person asks', async () => {
        const user = userEvent.setup();
        renderDialog();
        await screen.findByTestId('suggestion-ai-1');
        await waitFor(() => expect(screen.getByTestId('ai-detail-ai-1')).toBeInTheDocument());
        const improveCalls = () => client.post.mock.calls.filter(c => String(c[0]).endsWith('/improve')).length;
        expect(improveCalls()).toBe(1);
        await user.click(screen.getByTestId('meeting-tasks-improve'));
        await waitFor(() => expect(improveCalls()).toBe(2));
    });

    it('says so when the AI cannot, and the plain items can still be made', async () => {
        const user = userEvent.setup();
        client.post.mockImplementation(async (path: string, body: { items: unknown[] }) => {
            if (path.endsWith('/improve')) throw new Error('503');
            return { tasks: body.items, skipped: 0 };
        });
        renderDialog();
        expect(await screen.findByTestId('ai-improve-failed')).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Make 2 tasks' }));
        await waitFor(() => expect(client.post).toHaveBeenCalledWith('/api/projects/p1/tasks/batch', expect.anything(), expect.anything()));
    });

    it('leaves out the AI part of a row that was unticked', async () => {
        const user = userEvent.setup();
        renderDialog();
        const second = await screen.findByTestId('suggestion-ai-2');
        await waitFor(() => expect(within(second).getByLabelText('Description')).toBeInTheDocument());
        await user.click(within(second).getByRole('checkbox'));
        expect(screen.queryByTestId('ai-detail-ai-2')).not.toBeInTheDocument();
    });
});

describe('MeetingTasksDialog: items that are already tasks', () => {
    const MADE = [
        { itemId: 'ai-1', text: 'Send the offer', assigneeName: '', suggestedAssigneeId: null, dueDate: null, at: '', done: false, createdTaskId: 't-1' },
        { itemId: 'ai-2', text: 'Book a room', assigneeName: '', suggestedAssigneeId: null, dueDate: null, at: '', done: false, createdTaskId: 't-2' },
    ];
    const EXISTING = [
        { id: 't-1', title: 'Send the offer', description: 'From the meeting "Weekly".', status: 'todo', priority: 'normal', labels: [], checklist: [], sortOrder: 1, source: null, assigneeIds: [], links: [], dueDate: null, createdBy: OWNER_ID, completedAt: null, createdAt: 'x', updatedAt: 'x' },
        { id: 't-2', title: 'Book a room', description: '', status: 'todo', priority: 'high', labels: ['ops'], checklist: [], sortOrder: 2, source: null, assigneeIds: [OWNER_ID], links: [], dueDate: '2026-12-01', createdBy: OWNER_ID, completedAt: null, createdAt: 'x', updatedAt: 'x' },
    ];
    beforeEach(() => {
        client.get.mockImplementation(getRouter({
            '/api/projects/p1/meetings/mt-1/task-suggestions': { meeting: { id: 'mt-1', title: 'Weekly' }, suggestions: MADE },
            '/api/projects/p1/members': MEMBERS,
            '/api/projects/p1/tasks': { tasks: EXISTING, role: 'editor' },
        }));
        client.post.mockImplementation(async () => ({ items: IMPROVED.map((i, n) => ({ ...i, createdTaskId: `t-${n + 1}` })) }));
        client.patch.mockImplementation(async (_p: string, body: object) => ({ task: { ...EXISTING[0], ...body } }));
    });

    it('says plainly that everything is already a task, and still lets the AI improve them', async () => {
        renderDialog();
        expect(await screen.findByTestId('all-already-tasks')).toBeInTheDocument();
        const first = screen.getByTestId('suggestion-ai-1');
        await waitFor(() => expect(within(first).getByRole('checkbox')).toBeEnabled());
        expect(within(first).getByText('Already a task: tick to let the AI improve it')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Improve with AI' })).toBeEnabled();
    });

    it('improves the existing tasks: the AI text goes in front, what the person set stays, and nothing is made twice', async () => {
        const user = userEvent.setup();
        const { onClose } = renderDialog();
        const first = await screen.findByTestId('suggestion-ai-1');
        await waitFor(() => expect(within(first).getByRole('checkbox')).toBeEnabled());
        await user.click(within(first).getByRole('checkbox'));
        await user.click(within(screen.getByTestId('suggestion-ai-2')).getByRole('checkbox'));
        await user.click(screen.getByRole('button', { name: 'Improve 2 tasks' }));
        await waitFor(() => expect(client.patch).toHaveBeenCalledTimes(2));
        const [[path1, one], [path2, two]] = client.patch.mock.calls;
        expect(path1).toBe('/api/projects/p1/tasks/t-1');
        expect(one).toMatchObject({
            description: 'Eddie sends the offer, so Acme can decide this week.\n\nFrom the meeting "Weekly".',
            labels: ['sales'], priority: 'high', assigneeIds: [EDITOR_ID],
            checklist: [{ id: 'c1', text: 'Draft', done: false }],
        });
        expect(path2).toBe('/api/projects/p1/tasks/t-2');
        expect(two).toMatchObject({ priority: 'high', labels: ['ops', 'workshop'], assigneeIds: [OWNER_ID], dueDate: '2026-12-01' });
        expect(client.post.mock.calls.some(c => String(c[0]).endsWith('/tasks/batch'))).toBe(false);
        await waitFor(() => expect(onClose).toHaveBeenCalled());
    });
});

describe('descriptionFor', () => {
    const t = ((_k: string, d: string, v?: Record<string, unknown>) => d.replace(/\{(\w+)\}/g, (_m, k) => String(v?.[k] ?? ''))) as unknown as TranslateFn;
    it('names the meeting and where in it, and who the notes gave it to when that was no member', () => {
        expect(descriptionFor(t, 'Weekly', { at: '', assigneeName: '', suggestedAssigneeId: null })).toBe('From the meeting "Weekly".');
        expect(descriptionFor(t, 'Weekly', { at: '1:02', assigneeName: 'Carla', suggestedAssigneeId: null }))
            .toBe('From the meeting "Weekly", at 1:02.\nIn the meeting this was for: Carla.');
        expect(descriptionFor(t, 'Weekly', { at: '', assigneeName: 'Eddie', suggestedAssigneeId: EDITOR_ID })).toBe('From the meeting "Weekly".');
        expect(descriptionFor(t, 'Weekly', { at: '', assigneeName: 'Niet toegewezen', suggestedAssigneeId: null })).toBe('From the meeting "Weekly".');
    });
});
