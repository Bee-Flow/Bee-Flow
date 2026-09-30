import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withQueryClient } from '../../../../test/queryWrapper';
import { EDITOR_ID, getRouter, MEMBERS, OWNER_ID, tabProps, type RouteAnswer } from './contentTestKit';
import type { ContentTabProps } from './types';

// Fresh spies per test (assigned in beforeEach) rather than reset ones.
const { client, capture, recorder } = vi.hoisted(() => ({
    client: {} as Record<'get' | 'post' | 'put' | 'patch' | 'delete', ReturnType<typeof vi.fn>>,
    capture: { open: false, session: 0, openCapture: (() => 0) as (mode?: string) => number },
    recorder: {
        version: 0,
        lastResultId: null as string | null,
        uploading: false,
        recorder: { state: 'idle' },
        consumeLastResult: (() => ({ id: null, meta: null })) as () => { id: string | null; meta: unknown },
    },
}));
vi.mock('../../../../api/client', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../../api/client')>()),
    apiClient: client,
    default: client,
}));
vi.mock('../../../../pages/meeting-notes/capture/CaptureContext', () => ({ useCapture: () => capture }));
vi.mock('../../../../pages/meeting-notes/hooks/RecorderContext', () => ({ useRecorder: () => recorder }));
vi.mock('../../../../pages/meeting-notes/detail/MeetingDetail', () => ({
    default: ({ id, onBack, onDeleted }: { id: string; onBack: () => void; onDeleted: () => void }) => (
        <div data-testid="meeting-detail">
            meeting {id}
            <button type="button" onClick={onBack}>detail back</button>
            <button type="button" onClick={onDeleted}>detail deleted</button>
        </div>
    ),
}));

import MeetingsTab from './MeetingsTab';
import { resetCaptureArm } from './useProjectMeetingCapture';

const MEETINGS = [
    { id: 'm-1', title: 'Weekly sync', userId: EDITOR_ID, status: 'completed', durationSeconds: 2527, actionItemCount: 4, createdAt: '2026-09-20T10:00:00Z' },
    { id: 'm-2', title: 'Client call', userId: OWNER_ID, status: 'processing', durationSeconds: null, actionItemCount: 0, createdAt: '2026-09-22T10:00:00Z' },
];

function routes(meetings: RouteAnswer, extra: Record<string, RouteAnswer> = {}) {
    return getRouter({
        '/api/projects/p1/resources': typeof meetings === 'function' || meetings instanceof Error ? meetings : { role: 'editor', meetings },
        '/api/projects/p1/members': MEMBERS,
        ...extra,
    });
}

function renderTab(role: ContentTabProps['role'], extra: Partial<ContentTabProps> = {}) {
    const handlers = { onOpenSub: vi.fn(), onNavigate: vi.fn() };
    const ui = (more: Partial<ContentTabProps> = {}) => withQueryClient(<MeetingsTab {...tabProps(role, handlers, { ...extra, ...more })} />);
    const view = render(ui());
    return { ...handlers, rerender: (more: Partial<ContentTabProps> = {}) => view.rerender(ui(more)), unmount: view.unmount };
}

beforeEach(() => {
    for (const m of ['get', 'post', 'put', 'patch', 'delete'] as const) client[m] = vi.fn();
    client.get.mockImplementation(routes(MEETINGS));
    client.put.mockImplementation(async () => ({ success: true }));
    resetCaptureArm();
    Object.assign(capture, {
        open: false, session: 0,
        openCapture: vi.fn(() => { capture.open = true; capture.session += 1; return capture.session; }),
    });
    Object.assign(recorder, {
        version: 0, lastResultId: null, uploading: false, recorder: { state: 'idle' },
        consumeLastResult: vi.fn(() => { const id = recorder.lastResultId; recorder.lastResultId = null; return { id, meta: null }; }),
    });
});

describe('MeetingsTab: list and states', () => {
    it('lists each meeting with date, length, action items and owner, and opens one in place', async () => {
        const user = userEvent.setup();
        const { onOpenSub } = renderTab('editor');
        const row = await screen.findByTestId('project-meeting-m-1');
        expect(within(row).getByText('42:07')).toBeInTheDocument();
        expect(within(row).getByText('4')).toBeInTheDocument();
        expect(within(row).getByText('You')).toBeInTheDocument();
        expect(within(screen.getByTestId('project-meeting-m-2')).getByText('Transcribing…')).toBeInTheDocument();
        await user.click(within(row).getByText('Weekly sync'));
        expect(onOpenSub).toHaveBeenCalledWith('m-1');
    });

    it('says the meetings could not be loaded rather than that there are none', async () => {
        client.get.mockImplementation(routes(new Error('HTTP 500')));
        renderTab('editor');
        expect(await screen.findByText('The meetings of this project could not be loaded.')).toBeInTheDocument();
        expect(screen.queryByText('No meetings yet')).not.toBeInTheDocument();
    });

    it('explains meetings with a record action when there are none', async () => {
        client.get.mockImplementation(routes([]));
        renderTab('editor');
        expect(await screen.findByText('No meetings yet')).toBeInTheDocument();
        expect(screen.getAllByRole('button', { name: 'Record or upload' }).length).toBe(2);
    });

    it('gives a viewer no record, add or remove controls', async () => {
        renderTab('viewer');
        await screen.findByText('Weekly sync');
        expect(screen.queryByRole('button', { name: 'Record or upload' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Add existing meeting' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /from the project/ })).not.toBeInTheDocument();
    });
});

describe('MeetingsTab: add and remove', () => {
    it('offers only my own recordings in the picker and files the one I pick', async () => {
        const user = userEvent.setup();
        client.get.mockImplementation(routes(MEETINGS, {
            '/api/transcriptions': { transcriptions: [
                { id: 'm-mine', title: 'Design review', isOwner: true, durationSeconds: 600 },
                { id: 'm-published', title: 'All hands', isOwner: false },
            ] },
        }));
        renderTab('editor', { intent: 'add' });
        const dialog = await screen.findByRole('dialog', { name: 'Add a meeting' });
        expect(await within(dialog).findByText('Design review')).toBeInTheDocument();
        expect(within(dialog).queryByText('All hands')).not.toBeInTheDocument();
        await user.click(within(dialog).getByRole('button', { name: 'Add Design review' }));
        await waitFor(() => expect(client.put).toHaveBeenCalledWith(
            '/api/projects/p1/resources', { kind: 'meeting', id: 'm-mine', attach: true }, { retry: false },
        ));
        expect(await within(dialog).findByText('Added')).toBeInTheDocument();
    });

    it('takes my meeting out of the project after confirmation', async () => {
        const user = userEvent.setup();
        renderTab('editor');
        await user.click(await screen.findByRole('button', { name: 'Remove Weekly sync from the project' }));
        await user.click(screen.getByTestId('confirm-dialog-confirm'));
        await waitFor(() => expect(client.put).toHaveBeenCalledWith(
            '/api/projects/p1/resources', { kind: 'meeting', id: 'm-1', attach: false }, { retry: false },
        ));
    });
});

describe('MeetingsTab: record or upload', () => {
    it('opens the recorder and files the finished meeting into the project, then opens it', async () => {
        const user = userEvent.setup();
        const view = renderTab('editor');
        await user.click(await screen.findByTestId('meetings-capture'));
        expect(capture.openCapture).toHaveBeenCalled();
        Object.assign(recorder, { version: 1, lastResultId: 'm-new' });
        view.rerender();
        await waitFor(() => expect(client.put).toHaveBeenCalledWith(
            '/api/projects/p1/resources', { kind: 'meeting', id: 'm-new', attach: true }, { retry: false },
        ));
        await waitFor(() => expect(view.onOpenSub).toHaveBeenCalledWith('m-new'));
    });

    it('shows that the recording is being transcribed', async () => {
        const user = userEvent.setup();
        const view = renderTab('editor');
        await user.click(await screen.findByTestId('meetings-capture'));
        recorder.uploading = true;
        view.rerender();
        expect(screen.getByTestId('meeting-capture-status')).toHaveTextContent('Transcribing your recording');
    });

    it('does not file a later, unrelated recording after the recorder was closed unused', async () => {
        const user = userEvent.setup();
        const view = renderTab('editor');
        await user.click(await screen.findByTestId('meetings-capture'));
        view.rerender();
        capture.open = false;
        view.rerender();
        Object.assign(recorder, { version: 1, lastResultId: 'm-elsewhere' });
        view.rerender();
        await new Promise(r => setTimeout(r, 20));
        expect(client.put).not.toHaveBeenCalled();
        expect(recorder.consumeLastResult).not.toHaveBeenCalled();
    });

    it('files a meeting that finishes while another one is open, without leaving it', async () => {
        const user = userEvent.setup();
        const view = renderTab('editor');
        await user.click(await screen.findByTestId('meetings-capture'));
        view.rerender({ sub: 'm-1' });
        Object.assign(recorder, { version: 1, lastResultId: 'm-new' });
        view.rerender({ sub: 'm-1' });
        await waitFor(() => expect(client.put).toHaveBeenCalledWith(
            '/api/projects/p1/resources', { kind: 'meeting', id: 'm-new', attach: true }, { retry: false },
        ));
        expect(view.onOpenSub).not.toHaveBeenCalled();
    });

    it('opens the recorder at once when the shell asks for a capture', async () => {
        renderTab('editor', { intent: 'capture' });
        await waitFor(() => expect(capture.openCapture).toHaveBeenCalledTimes(1));
    });

    it('never opens the recorder for a viewer, whatever the shell asks', async () => {
        renderTab('viewer', { intent: 'capture' });
        await screen.findByText('Weekly sync');
        expect(capture.openCapture).not.toHaveBeenCalled();
    });
});

describe('MeetingsTab: a meeting captured elsewhere is never filed', () => {
    it('does not file a later meeting captured elsewhere after leaving the tab mid-recording', async () => {
        const user = userEvent.setup();
        const first = renderTab('editor');
        await user.click(await screen.findByTestId('meetings-capture'));
        // Recording runs on; the modal closes and the member leaves the tab.
        Object.assign(recorder, { recorder: { state: 'recording' } });
        capture.open = false;
        first.rerender();
        first.unmount();
        // Their own recording finishes unclaimed, then a private 1:1 is
        // recorded from the meeting palette.
        Object.assign(recorder, { version: 1, lastResultId: 'm-ours', recorder: { state: 'idle' } });
        capture.openCapture('record');
        capture.open = false;
        Object.assign(recorder, { version: 2, lastResultId: 'm-private' });
        // Back on the project's meetings tab.
        renderTab('editor');
        await screen.findByText('Weekly sync');
        await new Promise(r => setTimeout(r, 20));
        expect(client.put).not.toHaveBeenCalled();
        expect(recorder.consumeLastResult).not.toHaveBeenCalled();
    });

    it('does not file the first meeting to finish when it was captured from elsewhere', async () => {
        const user = userEvent.setup();
        const first = renderTab('editor');
        await user.click(await screen.findByTestId('meetings-capture'));
        Object.assign(recorder, { recorder: { state: 'recording' } });
        capture.open = false;
        first.rerender();
        first.unmount();
        // The armed recording failed (no result); a capture opened from the
        // palette is the next one to finish.
        Object.assign(recorder, { recorder: { state: 'idle' } });
        capture.openCapture('upload');
        capture.open = false;
        Object.assign(recorder, { version: 1, lastResultId: 'm-private' });
        renderTab('editor');
        await screen.findByText('Weekly sync');
        await new Promise(r => setTimeout(r, 20));
        expect(client.put).not.toHaveBeenCalled();
        expect(recorder.consumeLastResult).not.toHaveBeenCalled();
    });
});

describe('MeetingsTab: one meeting', () => {
    it('shows the meeting in place, with a way back and back again after a delete', async () => {
        const user = userEvent.setup();
        const { onOpenSub } = renderTab('viewer', { sub: 'm-2' });
        expect(await screen.findByTestId('meeting-detail')).toHaveTextContent('meeting m-2');
        await user.click(screen.getByRole('button', { name: 'detail back' }));
        expect(onOpenSub).toHaveBeenLastCalledWith(null);
        await user.click(screen.getByRole('button', { name: 'detail deleted' }));
        expect(onOpenSub).toHaveBeenCalledTimes(2);
    });

    describe('making tasks from the action items', () => {
        const SUGGESTIONS = { meeting: { id: 'm-1', title: 'Weekly sync' }, suggestions: [
            { itemId: 'ai-1', text: 'Send the offer', assigneeName: 'Eddie', suggestedAssigneeId: EDITOR_ID, dueDate: null, at: '', done: false, createdTaskId: null },
        ] };
        beforeEach(() => {
            client.get.mockImplementation(routes(MEETINGS, { '/api/projects/p1/meetings/m-1/task-suggestions': SUGGESTIONS }));
            client.post.mockImplementation(async (_p: string, body: { items: unknown[] }) => ({ tasks: body.items, skipped: 0 }));
        });

        it('offers it to an editor, whoever recorded the meeting, and opens the review', async () => {
            const user = userEvent.setup();
            renderTab('editor', { sub: 'm-2' });
            await user.click(await screen.findByTestId('meeting-make-tasks'));
            expect(await screen.findByRole('dialog')).toBeInTheDocument();
        });

        it('makes the tasks with their link to the meeting item, then takes the person to the Tasks tab', async () => {
            const user = userEvent.setup();
            const onOpenTab = vi.fn();
            renderTab('editor', { sub: 'm-1', onOpenTab });
            await user.click(await screen.findByTestId('meeting-make-tasks'));
            await user.click(await screen.findByRole('button', { name: 'Make 1 tasks' }));
            await waitFor(() => expect(client.post).toHaveBeenCalledWith('/api/projects/p1/tasks/batch', expect.objectContaining({
                items: [expect.objectContaining({ title: 'Send the offer', source: { kind: 'meeting', id: 'm-1', itemId: 'ai-1' } })],
            }), expect.anything()));
            await waitFor(() => expect(onOpenTab).toHaveBeenCalledWith('tasks'));
        });

        it('is not offered to a viewer, who can read the meeting but not add to the project', async () => {
            renderTab('viewer', { sub: 'm-1' });
            expect(await screen.findByTestId('meeting-detail')).toBeInTheDocument();
            expect(screen.queryByTestId('meeting-make-tasks')).not.toBeInTheDocument();
        });
    });
});

describe('MeetingsTab: adding a meeting that is already shared', () => {
    it('does not offer a meeting shared another way, and says why; a personal one can be added', async () => {
        const user = userEvent.setup();
        client.get.mockImplementation(routes([], { '/api/transcriptions': { transcriptions: [
            { id: 'own-1', title: 'Personal note', isOwner: true, isPublished: false, sharedGroups: [], createdAt: '2026-09-20T10:00:00Z' },
            { id: 'own-2', title: 'Org note', isOwner: true, isPublished: true, sharedGroups: [], createdAt: '2026-09-21T10:00:00Z' },
            { id: 'own-3', title: 'Group note', isOwner: true, isPublished: true, sharedGroups: ['g1'], createdAt: '2026-09-22T10:00:00Z' },
        ] } }));
        renderTab('editor');
        await user.click(await screen.findByTestId('meetings-add-existing'));
        expect(await screen.findByText('Org note')).toBeInTheDocument();
        expect(screen.getByTestId('picker-blocked-own-2')).toHaveTextContent('Already shared another way');
        expect(screen.getByTestId('picker-blocked-own-3')).toBeInTheDocument();
        expect(screen.queryByTestId('picker-blocked-own-1')).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Add Org note' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Add Personal note' })).toBeEnabled();
    });
});
