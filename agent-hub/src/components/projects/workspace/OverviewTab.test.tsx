import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withQueryClient } from '../../../test/queryWrapper';
import OverviewTab, { type OverviewTabProps } from './OverviewTab';
import { EDITOR_ID, makeFakeApi, makeMembers, makeProject, OWNER_ID, reply, VIEWER_ID } from './workspaceTestApi';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('../../../utils/helpers', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    API_BASE: '',
    authFetch: fetchMock,
}));

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

const BASE_ROUTES: Record<string, unknown> = {
    'GET /api/projects/p1/members': makeMembers(),
    'GET /api/projects/p1/chats': { chats: [{ id: 'c1', title: 'Standup', lastMessageAt: ago(1), updatedAt: ago(1), createdAt: ago(60) }], role: 'owner' },
    'GET /api/projects/p1/threads': { threads: [{ id: 't1', type: 'agent', agentId: 'ag1', ownerId: EDITOR_ID, title: 'Pricing research', updatedAt: ago(5) }] },
    'GET /api/projects/p1/resources': {
        documents: [{ id: 'd1', name: 'Launch brief', updatedAt: ago(10) }],
        notebooks: [{ id: 'n1', name: 'Interview notes', updatedAt: ago(20) }],
        meetings: [{ id: 'm1', title: 'Kick-off', createdAt: ago(30) }],
        knowledgeBases: [{ id: 'kb1' }],
    },
    'GET /api/projects/p1/files': { files: [{ id: 'f1', name: 'a.pdf', status: 'ready' }], kbId: 'kb-files' },
    'GET /agents': [{ id: 'ag1', name: 'Research agent' }],
    'POST /api/projects/p1/chats': { chat: { id: 'c-new', title: 'Hello team' }, message: null, ai: { status: 'skipped' } },
    'POST /api/projects/p1/visit': { prevVisitAt: null, visitStartedAt: ago(0) },
    'GET /api/projects/p1/changes': { groups: [], since: 'visit', prevVisitAt: null, visitStartedAt: ago(0) },
};

function renderOverview(role: OverviewTabProps['role'], routes: Record<string, unknown> = {}, projectOverrides: Record<string, unknown> = {}, extra: Partial<OverviewTabProps> = {}) {
    const api = makeFakeApi({ ...BASE_ROUTES, ...routes });
    fetchMock.mockImplementation(api.fetchImpl);
    const project = makeProject({ role, ...projectOverrides });
    const handlers = { onOpenTab: vi.fn(), onStartChat: vi.fn(() => true), onOpenThread: vi.fn(), onNavigate: vi.fn(), onOpenSub: vi.fn() };
    const userId = role === 'owner' ? OWNER_ID : role === 'editor' ? EDITOR_ID : VIEWER_ID;
    render(withQueryClient(
        <OverviewTab projectId="p1" project={project} role={role} currentUser={{ id: userId }} sub={null} {...handlers} {...extra} />,
    ));
    return { api, project, user: userEvent.setup(), ...handlers };
}

beforeEach(() => { fetchMock.mockReset(); });

describe('OverviewTab — the shared project composer', () => {
    it('starts one shared project chat with Enter, with no chat-type choices', async () => {
        const { user, api, onOpenTab, onStartChat } = renderOverview('editor');
        expect(screen.queryByRole('radiogroup', { name: 'Chat type' })).not.toBeInTheDocument();
        await user.type(screen.getByTestId('composer-input'), 'Draft the agenda{Enter}');
        await waitFor(() => expect(onOpenTab).toHaveBeenCalledWith('chats', 'c-new'));
        expect(api.callsTo('POST', '/api/projects/p1/chats')[0].body).toMatchObject({ aiMode: 'mention', message: 'Draft the agenda' });
        expect(onStartChat).not.toHaveBeenCalled();
        expect(screen.getByTestId('composer-input')).toHaveValue('');
    });
    it('keeps the draft if creating the shared chat fails', async () => {
        const { user, onOpenTab } = renderOverview('editor', { 'POST /api/projects/p1/chats': reply(403, { error: 'You need editor access to start a chat' }) });
        await user.type(screen.getByTestId('composer-input'), 'Hello team');
        await user.click(screen.getByTestId('composer-send'));
        expect(await screen.findByTestId('composer-error')).toHaveTextContent('You need editor access to start a chat');
        expect(screen.getByTestId('composer-input')).toHaveValue('Hello team');
        expect(onOpenTab).not.toHaveBeenCalled();
    });
    it('translates a known server refusal', async () => {
        const { user } = renderOverview('editor', { 'POST /api/projects/p1/chats': reply(409, { error: 'English from server', code: 'SOLUTION_HOLDS_NO_CHATS' }) });
        await user.type(screen.getByTestId('composer-input'), 'Hello team{Enter}');
        expect(await screen.findByTestId('composer-error')).toHaveTextContent(/a Solution holds no chats/);
    });
    it('does not offer a composer to viewers', () => {
        renderOverview('viewer');
        expect(screen.getByTestId('composer-readonly')).toBeInTheDocument();
        expect(screen.queryByTestId('composer-input')).not.toBeInTheDocument();
    });
    it('does not offer a composer in a Studio Solution', () => {
        renderOverview('owner', {}, { kind: 'solution' });
        expect(screen.getByTestId('composer-solution')).toBeInTheDocument();
        expect(screen.queryByTestId('composer-input')).not.toBeInTheDocument();
    });
});

describe('OverviewTab — quick actions and cards', () => {
    it('routes each quick action to its tab with an intent; invite is the owner’s', async () => {
        const editor = renderOverview('editor');
        expect(screen.queryByTestId('quick-invite')).toBeNull();
        await editor.user.click(screen.getByTestId('quick-files'));
        expect(editor.onOpenTab).toHaveBeenCalledWith('knowledge', null, 'upload');
        await editor.user.click(screen.getByTestId('quick-meeting'));
        expect(editor.onOpenTab).toHaveBeenCalledWith('meetings', null, 'capture');
    });

    it('offers the owner an invite, and shows counts only once known', async () => {
        const { user, onOpenTab } = renderOverview('owner');
        await user.click(screen.getByTestId('quick-invite'));
        expect(onOpenTab).toHaveBeenCalledWith('members', null, 'invite');
        const knowledge = screen.getByTestId('overview-knowledge');
        await waitFor(() => expect(within(knowledge).getByText('Files').nextSibling).toHaveTextContent('1'));
        expect(within(screen.getByTestId('overview-instructions')).getByText('Answer briefly.')).toBeInTheDocument();
        expect(await within(screen.getByTestId('overview-members')).findByText(/3 people · 1 groups/)).toBeInTheDocument();
    });
});

describe('OverviewTab — recent in this project', () => {
    it('merges chats and content newest first, and opens each where it lives', async () => {
        const { user, onOpenTab, onOpenThread, onNavigate } = renderOverview('editor');
        const recent = screen.getByTestId('overview-recent');
        await waitFor(() => expect(within(recent).getAllByRole('button')).toHaveLength(5));
        expect(within(recent).getAllByRole('button').map((b) => b.dataset.testid)).toEqual([
            'recent-team_chat-c1', 'recent-ai_chat-t1', 'recent-document-d1', 'recent-notebook-n1', 'recent-meeting-m1',
        ]);
        await user.click(screen.getByTestId('recent-team_chat-c1'));
        expect(onOpenTab).toHaveBeenCalledWith('chats', 'c1');
        await user.click(screen.getByTestId('recent-ai_chat-t1'));
        expect(onOpenThread).toHaveBeenCalledWith({ id: 't1', type: 'agent', agentId: 'ag1' });
        await user.click(screen.getByTestId('recent-notebook-n1'));
        expect(onOpenTab).toHaveBeenCalledWith('notebooks', 'n1');
        await user.click(screen.getByTestId('recent-meeting-m1'));
        expect(onOpenTab).toHaveBeenCalledWith('meetings', 'm1');
    });

    it('without notebooks: a notebook is listed but not a way in, and no quick action makes one', async () => {
        // Plan, role or operator switch: the notebook editor would refuse it,
        // so the overview never sends the reader there.
        const { user, onNavigate } = renderOverview('editor', {}, {}, { notebooksEnabled: false });
        const recent = screen.getByTestId('overview-recent');
        await waitFor(() => expect(within(recent).getAllByRole('button')).toHaveLength(4));
        const notebook = within(recent).getByTestId('recent-notebook-n1');
        expect(notebook.tagName).not.toBe('BUTTON');
        expect(notebook).toHaveTextContent('Interview notes');
        expect(notebook).toHaveTextContent('You cannot open notebooks');
        await user.click(notebook);
        expect(onNavigate).not.toHaveBeenCalled();
        expect(screen.queryByTestId('quick-notebook')).toBeNull();
        expect(screen.getByTestId('quick-document')).toBeInTheDocument();
    });

    it('says the list may be incomplete when a source failed', async () => {
        renderOverview('editor', { 'GET /api/projects/p1/threads': reply(403, { error: 'Forbidden' }) });
        expect(await screen.findByTestId('recent-partial')).toBeInTheDocument();
        expect(await screen.findByTestId('recent-document-d1')).toBeInTheDocument();
    });
});

describe('OverviewTab — since your last visit', () => {
    it('shows what others changed since the last visit, and opens the item where it lives', async () => {
        const { user, onOpenTab } = renderOverview('editor', {
            'POST /api/projects/p1/visit': { prevVisitAt: ago(600), visitStartedAt: ago(1) },
            'GET /api/projects/p1/changes': {
                groups: [{
                    item: { type: 'document', id: 'd1', title: 'Launch brief', available: true },
                    lastChangedAt: ago(30), changeCount: 3, contributors: [{ userId: OWNER_ID, kind: 'user' }],
                    stats: { wordsAdded: 20, wordsRemoved: 0, blocksChanged: 2 }, latestVersionId: 'v9', seenVersionId: 'v7',
                    kinds: ['edited'], aiAssisted: false, minor: false, unread: true,
                }],
                since: 'visit', prevVisitAt: ago(600), visitStartedAt: ago(1),
            },
        });
        const row = await screen.findByTestId('since-document-d1');
        expect(row).toHaveTextContent('Olivia Owner');
        expect(within(row).getByTestId('since-show-changes')).toBeInTheDocument();
        await user.click(within(row).getByTestId('since-open'));
        expect(onOpenTab).toHaveBeenCalledWith('documents', 'd1');
    });

    it('without notebooks: a changed notebook has no Open and no Show changes', async () => {
        renderOverview('editor', {
            'POST /api/projects/p1/visit': { prevVisitAt: ago(600), visitStartedAt: ago(1) },
            'GET /api/projects/p1/changes': {
                groups: [{
                    item: { type: 'notebook', id: 'n1', title: 'Interview notes', available: true },
                    lastChangedAt: ago(30), changeCount: 2, contributors: [{ userId: OWNER_ID, kind: 'user' }],
                    stats: { wordsAdded: 5, wordsRemoved: 0, blocksChanged: 1 }, latestVersionId: 'v2', seenVersionId: 'v1',
                    kinds: ['edited'], aiAssisted: false, minor: false, unread: true,
                }],
                since: 'visit', prevVisitAt: ago(600), visitStartedAt: ago(1),
            },
        }, {}, { notebooksEnabled: false });
        const row = await screen.findByTestId('since-notebook-n1');
        expect(row).toHaveTextContent('Interview notes');
        expect(within(row).queryByTestId('since-open')).toBeNull();
        expect(within(row).queryByTestId('since-show-changes')).toBeNull();
    });

    it('stays out of the way on a first visit', async () => {
        renderOverview('viewer');
        await screen.findByTestId('overview-recent');
        await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull());
        expect(screen.queryByTestId('overview-since')).toBeNull();
    });
});
