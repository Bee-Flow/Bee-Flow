import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { Project, ProjectRole } from '../../../../api/queries/projects';
import { takeFirstAnswer } from './firstAnswer';
import ProjectChatsTab from './ProjectChatsTab';
import {
    emit, installServer, MEMBERS, message, PROJECT, renderLive, reply, teamChat, type StreamHolder, type TestServer,
} from './teamChatTestKit';

const { fetchMock, stream } = vi.hoisted(() => ({ fetchMock: vi.fn(), stream: { onEvent: null } as StreamHolder }));
vi.mock('../../../../utils/helpers', () => ({ API_BASE: '', authFetch: fetchMock }));
vi.mock('../../../../hooks/useProjectStream', () => ({
    default: (opts: { onEvent: StreamHolder['onEvent'] }) => { stream.onEvent = opts.onEvent; },
}));
vi.mock('../../../renderers/MarkdownRenderer', () => ({
    default: ({ content }: { content: string }) => <div data-testid="markdown">{content}</div>,
}));

const BASE = '/api/projects/p1';
const recent = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
let server: TestServer;

beforeEach(() => {
    fetchMock.mockReset();
    stream.onEvent = null;
    server = installServer(fetchMock)
        .on('GET', `${BASE}/members`, MEMBERS)
        .on('GET', `${BASE}/chats`, ({ query }) => (query.archived === '1'
            ? { chats: [teamChat({ id: 'c9', title: 'Old plans', archived: true })], role: 'editor' }
            : {
                chats: [
                    teamChat({ id: 'c1', title: 'Kick-off', unread: 2, lastMessageAt: recent(1), lastMessage: { authorKind: 'user', authorUserId: 'u-ada', excerpt: 'See you at 10' } }),
                    teamChat({ id: 'c2', title: 'Design review', aiMode: 'always', lastMessageAt: recent(300) }),
                ],
                role: 'editor',
            }))
        .on('GET', `${BASE}/threads`, {
            threads: [
                { id: 't1', type: 'direct', ownerId: 'u-ada', title: 'Pricing research', updatedAt: recent(5) },
                { id: 't2', type: 'agent', agentId: 'a1', ownerId: 'u-me', title: 'My shared agent chat', updatedAt: recent(10) },
            ],
        })
        .on('GET', `${BASE}/my-chats`, {
            chats: [
                { id: 't2', type: 'agent', agentId: 'a1', title: 'My shared agent chat', shared: true, updatedAt: recent(10) },
                { id: 'd1', type: 'direct', title: 'Private draft', shared: false, updatedAt: recent(20) },
            ],
        })
        .on('POST', `${BASE}/threads`, { shared: true })
        .on('DELETE', `${BASE}/threads/t2`, { shared: false })
        .on('POST', `${BASE}/presence`, { ok: true })
        .on('GET', '/agents', [{ id: 'a1', name: 'Pricing coach' }]);
});

function renderTab({ role = 'editor', sub = null }: { role?: ProjectRole; sub?: string | null } = {}) {
    const props = {
        onOpenSub: vi.fn(), onOpenThread: vi.fn(), onStartChat: vi.fn(), onNavigate: vi.fn(),
    };
    const view = renderLive(
        <ProjectChatsTab projectId="p1" project={PROJECT as Project} role={role} currentUser={{ id: 'u-me', name: 'Tom Me' }}
            sub={sub} {...props} />,
    );
    return { ...view, ...props };
}

it('lists team chats, shared AI chats and my private chats, each once', async () => {
    renderTab();
    const kickoff = await screen.findByTestId('chat-row-c1');
    expect(kickoff).toHaveTextContent('Ada Lovelace: See you at 10');
    expect(within(kickoff).getByTestId('chat-row-unread')).toHaveTextContent('2');
    expect(await screen.findByTestId('chat-row-t1')).toHaveTextContent('AI chat · Shared by Ada Lovelace');
    expect(screen.getByTestId('chat-row-t2')).toHaveTextContent('Agent chat · Shared with the project by you');
    expect(await screen.findByTestId('chat-row-d1')).toHaveTextContent('Private: only you can see it');
    expect(screen.getAllByTestId('chat-row-t2')).toHaveLength(1);
    expect(screen.getByTestId('chat-row-c2')).toHaveTextContent('AI answers every message');
});

it('filters by unread and private conversations, and searches previews', async () => {
    const user = userEvent.setup();
    renderTab(); await screen.findByTestId('chat-row-d1');
    await user.click(screen.getByRole('radio', { name: /Unread/ }));
    expect(screen.getByTestId('chat-row-c1')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-row-c2')).not.toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /Private/ }));
    expect(screen.getByTestId('chat-row-d1')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-row-t1')).not.toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /All/ }));
    await user.type(screen.getByRole('searchbox', { name: 'Search conversations' }), 'See you at 10');
    expect(screen.getByTestId('chat-row-c1')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-row-d1')).not.toBeInTheDocument();
});

it('a team chat opens inside the tab; an AI chat opens through the app', async () => {
    const user = userEvent.setup();
    const { onOpenSub, onOpenThread } = renderTab();
    await user.click(await screen.findByTestId('chat-row-c1'));
    expect(onOpenSub).toHaveBeenCalledWith('c1');
    await user.click(screen.getByTestId('chat-row-t2'));
    expect(onOpenThread).toHaveBeenCalledWith({ id: 't2', type: 'agent', agentId: 'a1' });
});

it('with a team chat as sub it shows that chat, and back returns to the list', async () => {
    server
        .on('GET', `${BASE}/chats/c1`, { chat: teamChat({ id: 'c1', title: 'Kick-off' }), role: 'editor' })
        .on('GET', `${BASE}/chats/c1/messages`, { messages: [message(1, { content: 'Hello all' })], hasMore: false })
        .on('POST', `${BASE}/chats/c1/read`, { ok: true });
    const user = userEvent.setup();
    const { onOpenSub } = renderTab({ sub: 'c1' });
    expect(await screen.findByText('Hello all')).toBeInTheDocument();
    expect(screen.getByTestId('project-team-chat')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back to chats' }));
    expect(onOpenSub).toHaveBeenCalledWith(null);
});

it('shares a private chat after confirming, and stops sharing one of mine', async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(await screen.findByTestId('chat-row-share-d1'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Share this chat with the project?');
    await user.click(within(dialog).getByRole('button', { name: 'Share with members' }));
    await waitFor(() => expect(server.called('POST', `${BASE}/threads`)[0]?.body).toEqual({ conversationId: 'd1', type: 'direct' }));

    await user.click(screen.getByTestId('chat-row-unshare-t2'));
    await waitFor(() => expect(server.called('DELETE', `${BASE}/threads/t2`)[0]?.query).toEqual({ type: 'agent' }));
});

it('cancelling the share question shares nothing', async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(await screen.findByTestId('chat-row-share-d1'));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(server.called('POST', `${BASE}/threads`)).toHaveLength(0);
});

it('a viewer can read and open, but gets no New chat and no Share', async () => {
    renderTab({ role: 'viewer' });
    await screen.findByTestId('chat-row-d1');
    expect(screen.queryByRole('button', { name: 'New chat' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('chat-row-share-d1')).not.toBeInTheDocument();
    // Taking back your own chat stays possible: it is yours, whatever your role.
    expect(screen.getByTestId('chat-row-unshare-t2')).toBeInTheDocument();
});

it('a source that could not be read says so instead of reading as empty', async () => {
    server.on('GET', `${BASE}/threads`, reply(403, { error: 'Forbidden' })).on('GET', `${BASE}/chats`, { chats: [], role: 'editor' })
        .on('GET', `${BASE}/my-chats`, { chats: [] });
    renderTab();
    expect(await screen.findByTestId('chats-error-threads')).toHaveTextContent('Could not load the shared AI chats.');
    expect(screen.queryByText('No chats in this project yet')).not.toBeInTheDocument();
});

it('an empty project explains what chats are for', async () => {
    server.on('GET', `${BASE}/chats`, { chats: [], role: 'editor' }).on('GET', `${BASE}/threads`, { threads: [] })
        .on('GET', `${BASE}/my-chats`, { chats: [] });
    renderTab();
    expect(await screen.findByText('No chats in this project yet')).toBeInTheDocument();
    expect(screen.getByText('Start a conversation with your project members. Mention @AI whenever you need help.')).toBeInTheDocument();
});

it('New chat → Team chat creates the chat and opens it', async () => {
    server.on('POST', `${BASE}/chats`, { chat: teamChat({ id: 'c-new', title: 'Agenda?' }), message: null, ai: { status: 'skipped' } });
    const user = userEvent.setup();
    const { onOpenSub } = renderTab();
    await user.click(await screen.findByRole('button', { name: 'New chat' }));
    await user.type(screen.getByRole('textbox', { name: 'First message' }), 'Agenda?');
    await user.click(screen.getByTestId('new-chat-submit'));
    await waitFor(() => expect(onOpenSub).toHaveBeenCalledWith('c-new'));
    expect(server.called('POST', `${BASE}/chats`)[0].body).toMatchObject({ aiMode: 'mention', message: 'Agenda?' });
});

it('New chat → Team chat carries the AI result of the first message into the chat it opens', async () => {
    server.on('POST', `${BASE}/chats`, { chat: teamChat({ id: 'c-first' }), message: null, ai: { status: 'skipped', reason: 'limit' } });
    const user = userEvent.setup();
    const { onOpenSub } = renderTab();
    await user.click(await screen.findByRole('button', { name: 'New chat' }));
    await user.type(screen.getByRole('textbox', { name: 'First message' }), '@ai summarise');
    await user.click(screen.getByTestId('new-chat-submit'));
    await waitFor(() => expect(onOpenSub).toHaveBeenCalledWith('c-first'));
    expect(takeFirstAnswer('c-first')).toEqual({ ai: { status: 'skipped', reason: 'limit' }, askedAi: true });
});

it('New chat has one shared creation path and preserves the draft when creation fails', async () => {
    server.on('POST', `${BASE}/chats`, reply(500, { error: 'Could not create conversation' }));
    const user = userEvent.setup();
    const { onStartChat, onOpenSub } = renderTab();
    await user.click(await screen.findByRole('button', { name: 'New chat' }));
    expect(screen.queryByRole('radiogroup', { name: 'Kind of chat' })).not.toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'First message' }), 'Summarise the brief');
    await user.click(screen.getByTestId('new-chat-submit'));
    expect(await screen.findByText('Could not create conversation')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'First message' })).toHaveValue('Summarise the brief');
    expect(onStartChat).not.toHaveBeenCalled();
    expect(onOpenSub).not.toHaveBeenCalled();
});

it('shows the AI answering in a team chat and in a shared chat, live', async () => {
    renderTab();
    await screen.findByTestId('chat-row-t1');
    emit(stream, 'chat.ai.started', { payload: { chatId: 'c1' }, transient: true });
    emit(stream, 'run.started', { targetType: 'conversation', targetId: 't1' });
    expect(within(screen.getByTestId('chat-row-c1')).getByTestId('chat-row-answering')).toBeInTheDocument();
    expect(within(screen.getByTestId('chat-row-t1')).getByTestId('chat-row-answering')).toBeInTheDocument();
    emit(stream, 'run.finished', { targetType: 'conversation', targetId: 't1' });
    expect(within(screen.getByTestId('chat-row-t1')).queryByTestId('chat-row-answering')).not.toBeInTheDocument();
});

it('a live chat event refreshes the team chat list', async () => {
    renderTab();
    await screen.findByTestId('chat-row-c1');
    server.on('GET', `${BASE}/chats`, { chats: [teamChat({ id: 'c3', title: 'Brand new' })], role: 'editor' });
    emit(stream, 'chat.created', { targetType: 'project_chat', targetId: 'c3', payload: { chatId: 'c3' } });
    expect(await screen.findByTestId('chat-row-c3')).toHaveTextContent('Brand new');
});

it('archived team chats load when asked for', async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findByTestId('chat-row-c1');
    expect(server.calls.some(c => c.path === `${BASE}/chats` && c.query.archived === '1')).toBe(false);
    await user.click(screen.getByTestId('chats-archived-toggle'));
    expect(await screen.findByTestId('chat-row-c9')).toHaveTextContent('Old plans');
});

it('archived team chats that fail to load say so and can be retried, never "none"', async () => {
    const user = userEvent.setup();
    server.on('GET', `${BASE}/chats`, ({ query }) => (query.archived === '1'
        ? reply(503, { error: 'The project key is not available.', code: 'PROJECT_KEY_UNAVAILABLE' })
        : { chats: [teamChat({ id: 'c1', title: 'Kick-off' })], role: 'editor' }));
    renderTab();
    await screen.findByTestId('chat-row-c1');
    await user.click(screen.getByTestId('chats-archived-toggle'));
    expect(await screen.findByTestId('chats-error-archived')).toHaveTextContent('Could not load the archived team chats.');
    expect(screen.queryByText('No archived team chats.')).not.toBeInTheDocument();

    server.on('GET', `${BASE}/chats`, ({ query }) => (query.archived === '1'
        ? { chats: [teamChat({ id: 'c9', title: 'Old plans', archived: true })], role: 'editor' }
        : { chats: [teamChat({ id: 'c1', title: 'Kick-off' })], role: 'editor' }));
    await user.click(within(screen.getByTestId('chats-error-archived')).getByRole('button', { name: /Try again/ }));
    expect(await screen.findByTestId('chat-row-c9')).toHaveTextContent('Old plans');
    expect(screen.queryByTestId('chats-error-archived')).not.toBeInTheDocument();
});

it('a chat whose mode the organisation withdrew is listed by what it does now', async () => {
    server.on('GET', `${BASE}/chats`, { chats: [teamChat({ id: 'c1', title: 'Kick-off', aiMode: 'always', effectiveAiMode: 'mention' })], role: 'editor' });
    renderTab();
    const row = await screen.findByTestId('chat-row-c1');
    expect(row).toHaveTextContent('AI on mention');
    expect(row).not.toHaveTextContent('AI answers every message');
});
