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

describe('OverviewTab — the composer', () => {
    it('starts a private AI chat by default, with Enter', async () => {
        const { user, onStartChat, project } = renderOverview('editor');
        await user.type(screen.getByTestId('composer-input'), 'Draft the agenda{Enter}');
        expect(onStartChat).toHaveBeenCalledWith({ project, message: 'Draft the agenda', agentId: null, share: false });
        expect(screen.getByTestId('composer-input')).toHaveValue('');
    });

    it('keeps the message when the app refuses to start the chat', async () => {
        const { user, onStartChat } = renderOverview('editor');
        onStartChat.mockReturnValue(false);
        await user.type(screen.getByTestId('composer-input'), 'Draft the agenda{Enter}');
        expect(onStartChat).toHaveBeenCalledTimes(1);
        expect(screen.getByTestId('composer-input')).toHaveValue('Draft the agenda');
    });

    it('shares the new AI chat with members when asked', async () => {
        const { user, onStartChat } = renderOverview('editor');
        await user.click(screen.getByRole('checkbox', { name: 'Share with members' }));
        await user.type(screen.getByTestId('composer-input'), 'Summarise the brief');
        await user.click(screen.getByTestId('composer-send'));
        expect(onStartChat).toHaveBeenCalledWith(expect.objectContaining({ share: true, agentId: null }));
    });

    it('needs an agent picked before an agent chat can start', async () => {
        const { user, onStartChat } = renderOverview('editor');
        await user.click(screen.getByRole('radio', { name: 'Agent' }));
        await user.type(screen.getByTestId('composer-input'), 'Compare prices');
        expect(screen.getByTestId('composer-send')).toBeDisabled();
        const picker = await screen.findByTestId('composer-agent');
        await waitFor(() => expect(within(picker).getByRole('option', { name: 'Research agent' })).toBeInTheDocument());
        await user.selectOptions(picker, 'ag1');
        await user.click(screen.getByTestId('composer-send'));
        expect(onStartChat).toHaveBeenCalledWith(expect.objectContaining({ message: 'Compare prices', agentId: 'ag1' }));
    });

    it('creates a team chat (AI on mention) and opens it in the Chats tab', async () => {
        const { user, api, onOpenTab, onStartChat } = renderOverview('editor');
        await user.click(screen.getByRole('radio', { name: 'Team' }));
        expect(screen.queryByRole('checkbox', { name: 'Share with members' })).toBeNull();
        await user.type(screen.getByTestId('composer-input'), 'Hello team');
        await user.click(screen.getByTestId('composer-send'));
        await waitFor(() => expect(onOpenTab).toHaveBeenCalledWith('chats', 'c-new'));
        expect(api.callsTo('POST', '/api/projects/p1/chats')[0].body).toMatchObject({ aiMode: 'mention', message: 'Hello team' });
        expect(onStartChat).not.toHaveBeenCalled();
    });

    it('keeps the text and says so when the team chat is refused', async () => {
        const { user, onOpenTab } = renderOverview('editor', {
            'POST /api/projects/p1/chats': reply(403, { error: 'You need editor access to start a chat' }),
        });
        await user.click(screen.getByRole('radio', { name: 'Team' }));
        await user.type(screen.getByTestId('composer-input'), 'Hello team');
        await user.click(screen.getByTestId('composer-send'));
        expect(await screen.findByTestId('composer-error')).toHaveTextContent('You need editor access to start a chat');
        expect(screen.getByTestId('composer-input')).toHaveValue('Hello team');
        expect(onOpenTab).not.toHaveBeenCalled();
    });

    it('says a refusal the server names by code in the reader’s language', async () => {
        const { user } = renderOverview('editor', {
            'POST /api/projects/p1/chats': reply(409, { error: 'English from the server.', code: 'SOLUTION_HOLDS_NO_CHATS' }),
        });
        await user.click(screen.getByRole('radio', { name: 'Team' }));
        await user.type(screen.getByTestId('composer-input'), 'Hello team');
        await user.click(screen.getByTestId('composer-send'));
        expect(await screen.findByTestId('composer-error')).toHaveTextContent(/a Solution holds no chats/);
    });

    it('offers no composer in a Studio Solution, which holds no chats', () => {
        renderOverview('owner', {}, { kind: 'solution' });
        expect(screen.getByTestId('composer-solution')).toBeInTheDocument();
        expect(screen.queryByTestId('composer-input')).toBeNull();
    });

    it('is read-only for a viewer, without quick actions', async () => {
        renderOverview('viewer');
        expect(screen.getByTestId('composer-readonly')).toBeInTheDocument();
        expect(screen.queryByTestId('composer-input')).toBeNull();
        expect(screen.queryByTestId('quick-document')).toBeNull();
    });
});

describe('OverviewTab — the agent picker', () => {
    it('offers the agents published to the organisation as well as the person\'s own', async () => {
        const { user, onStartChat } = renderOverview('editor', {
            'GET /agents/published': [{ id: 'org-ag', name: 'Handbook helper' }, { id: 'ag1', name: 'Research agent' }],
        });
        await user.click(screen.getByRole('radio', { name: 'Agent' }));
        const picker = await screen.findByTestId('composer-agent');
        await waitFor(() => expect(within(picker).getByRole('option', { name: 'Handbook helper' })).toBeInTheDocument());
        expect(within(picker).getAllByRole('option', { name: 'Research agent' })).toHaveLength(1);
        await user.selectOptions(picker, 'org-ag');
        await user.type(screen.getByTestId('composer-input'), 'Where is the leave policy?');
        await user.click(screen.getByTestId('composer-send'));
        expect(onStartChat).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'org-ag' }));
    });

    it('still offers the published agents when the person\'s own list cannot be read', async () => {
        const { user } = renderOverview('editor', {
            'GET /agents': reply(500, { error: 'boom' }),
            'GET /agents/published': [{ id: 'org-ag', name: 'Handbook helper' }],
        });
        await user.click(screen.getByRole('radio', { name: 'Agent' }));
        const picker = await screen.findByTestId('composer-agent');
        await waitFor(() => expect(within(picker).getByRole('option', { name: 'Handbook helper' })).toBeInTheDocument());
    });

    it('says the agents could not be loaded only when neither list can be read', async () => {
        const { user } = renderOverview('editor', { 'GET /agents': reply(500, { error: 'boom' }) });
        await user.click(screen.getByRole('radio', { name: 'Agent' }));
        expect(await screen.findByText('Could not load your agents.')).toBeInTheDocument();
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
        expect(await within(screen.getByTestId('overview-members')).findByText(/4 in total/)).toBeInTheDocument();
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
        expect(onNavigate).toHaveBeenCalledWith('notebooks/n1');
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
