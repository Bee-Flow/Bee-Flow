// The AI that joins by itself, as a member of a team chat sees it: the Auto
// mode (and a mode the organisation does not allow), the one-time notice when
// a chat switches to Auto with the way to one's own setting, the "Joined
// because …" line under an automatic answer with a quiet "Not helpful", and
// the "Paused" chip once feedback made the AI hold back.

import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import ProjectTeamChat from './ProjectTeamChat';
import { installServer, MEMBERS, message, PROJECT, renderLive, reply, teamChat, type StreamHolder, type TestServer } from './teamChatTestKit';

const { fetchMock, stream } = vi.hoisted(() => ({ fetchMock: vi.fn(), stream: { onEvent: null } as StreamHolder }));
vi.mock('../../../../utils/helpers', () => ({ API_BASE: '', authFetch: fetchMock }));
vi.mock('../../../../hooks/useProjectStream', () => ({
    default: (opts: { onEvent: StreamHolder['onEvent'] }) => { stream.onEvent = opts.onEvent; },
}));
vi.mock('../../../renderers/MarkdownRenderer', () => ({
    default: ({ content }: { content: string }) => <div data-testid="markdown">{content}</div>,
}));

const CHAT = '/api/projects/p1/chats/c1';
let server: TestServer;

const AUTO_ANSWER = message(3, {
    authorKind: 'assistant', authorUserId: null, content: 'Annual plans are refundable within 30 days.',
    aiTrigger: 'auto_quiet', aiReason: 'open_question_answerable', myFeedback: null,
});
const NOTICE = message(2, { authorKind: 'system', authorUserId: 'u-ada', content: '', notice: 'ai_auto_on' });

beforeEach(() => {
    fetchMock.mockReset();
    stream.onEvent = null;
    server = installServer(fetchMock)
        .on('GET', '/api/projects/p1/members', MEMBERS)
        .on('GET', CHAT, { chat: teamChat({ aiMode: 'auto' }), role: 'editor' })
        .on('GET', '/api/projects/p1/chats', { chats: [teamChat({ aiMode: 'auto' })], role: 'editor', aiPolicy: { autoAllowed: true, alwaysAllowed: false } })
        .on('GET', `${CHAT}/messages`, ({ query }) => (query.after ? { messages: [], hasMore: false } : {
            messages: [message(1, { content: 'Does anyone know the refund policy?' }), NOTICE, AUTO_ANSWER],
            hasMore: false,
        }))
        .on('PATCH', CHAT, ({ body }) => ({ chat: teamChat(body) }))
        .on('POST', `${CHAT}/read`, { ok: true })
        .on('POST', '/api/projects/p1/presence', { ok: true })
        .on('POST', '/api/projects/p1/typing', { ok: true })
        .on('GET', '/agents', []);
});

function renderChat(role: 'owner' | 'editor' | 'viewer' = 'editor', onNavigate?: (page: string) => void) {
    return renderLive(
        <ProjectTeamChat projectId="p1" project={PROJECT} role={role} currentUser={{ id: 'u-me', name: 'Tom Me' }} chatId="c1"
            onBack={vi.fn()} onNavigate={onNavigate} />,
    );
}

it('offers Auto, and a mode the organisation does not allow cannot be picked', async () => {
    renderChat();
    await screen.findByText('Does anyone know the refund policy?');
    expect(screen.getByRole('radio', { name: 'Auto' })).toHaveAttribute('aria-checked', 'true');
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Always' })).toBeDisabled());
    expect(screen.getByRole('radio', { name: 'On mention' })).toBeEnabled();
});

it('switching to Auto patches the chat', async () => {
    server.on('GET', CHAT, { chat: teamChat({ aiMode: 'mention' }), role: 'editor' });
    const user = userEvent.setup();
    renderChat();
    await screen.findByText('Does anyone know the refund policy?');
    await user.click(screen.getByRole('radio', { name: 'Auto' }));
    await waitFor(() => expect(server.called('PATCH', CHAT)[0]?.body).toEqual({ aiMode: 'auto' }));
});

it('the switch notice says who turned it on, and links to one\'s own AI settings', async () => {
    const onNavigate = vi.fn();
    const user = userEvent.setup();
    renderChat('editor', onNavigate);
    const notice = await screen.findByTestId('team-chat-notice-m2');
    expect(notice).toHaveTextContent('Ada Lovelace let the AI join this chat by itself. It answers when it can help, and says why.');
    await user.click(screen.getByRole('button', { name: 'Your AI settings' }));
    expect(onNavigate).toHaveBeenCalledWith('settings/preferences');
});

it('without navigation the notice says where the setting is', async () => {
    renderChat();
    expect(await screen.findByTestId('team-chat-notice-m2')).toHaveTextContent('in Settings, Preferences');
});

it('an automatic answer says why it joined, and "Not helpful" is sent quietly', async () => {
    server.on('POST', `${CHAT}/messages/m3/feedback`, { ok: true, helpful: false, autoPausedUntil: null });
    const user = userEvent.setup();
    renderChat();
    const note = await screen.findByTestId('team-chat-auto-note-m3');
    expect(note).toHaveTextContent('Joined because a question came up that it could answer');
    await user.click(screen.getByRole('button', { name: 'Not helpful' }));
    await waitFor(() => expect(server.called('POST', `${CHAT}/messages/m3/feedback`)[0]?.body).toEqual({ helpful: false }));
    expect(await screen.findByText('Thanks. The AI will hold back more here.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Not helpful' })).not.toBeInTheDocument();
});

it('feedback that could not be sent says so, and the button stays', async () => {
    server.on('POST', `${CHAT}/messages/m3/feedback`, reply(403, { error: 'Insufficient permissions' }));
    const user = userEvent.setup();
    renderChat();
    await screen.findByTestId('team-chat-auto-note-m3');
    await user.click(screen.getByRole('button', { name: 'Not helpful' }));
    expect(await screen.findByText('Could not send your feedback. Try again.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Not helpful' })).toBeEnabled();
});

it('a viewer sees why the AI joined but gives no feedback; an asked-for answer has no such line', async () => {
    server.on('GET', `${CHAT}/messages`, ({ query }) => (query.after ? { messages: [], hasMore: false } : {
        messages: [AUTO_ANSWER, message(4, { authorKind: 'assistant', authorUserId: null, content: 'Asked for', aiTrigger: 'mention' })],
        hasMore: false,
    }));
    renderChat('viewer');
    expect(await screen.findByTestId('team-chat-auto-note-m3')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Not helpful' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('team-chat-auto-note-m4')).not.toBeInTheDocument();
});

it('feedback already given shows the thanks, not the button', async () => {
    server.on('GET', `${CHAT}/messages`, ({ query }) => (query.after ? { messages: [], hasMore: false } : {
        messages: [{ ...AUTO_ANSWER, myFeedback: 'not_helpful' }], hasMore: false,
    }));
    renderChat();
    expect(await screen.findByText('Thanks. The AI will hold back more here.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Not helpful' })).not.toBeInTheDocument();
});

it('a chat paused by feedback says so in the header', async () => {
    const until = new Date(Date.now() + 6 * 3600_000).toISOString();
    server.on('GET', CHAT, { chat: teamChat({ aiMode: 'auto', autoPausedUntil: until }), role: 'editor' });
    renderChat();
    const chip = await screen.findByTestId('team-chat-auto-paused');
    expect(chip).toHaveTextContent('Paused');
    expect(chip).toHaveTextContent(/stopped joining by itself here/);
});

it('a pause that is over, or a chat not in Auto, shows no chip', async () => {
    server.on('GET', CHAT, { chat: teamChat({ aiMode: 'auto', autoPausedUntil: new Date(Date.now() - 1000).toISOString() }), role: 'editor' });
    renderChat();
    await screen.findByText('Does anyone know the refund policy?');
    expect(screen.queryByTestId('team-chat-auto-paused')).not.toBeInTheDocument();
});

it('a post in Auto that the AI may answer later shows no notice to the author', async () => {
    server.on('POST', `${CHAT}/messages`, { message: message(5, { authorUserId: 'u-me', content: 'Who owns the SLA report?' }), ai: { status: 'skipped', reason: 'auto' } });
    const user = userEvent.setup();
    renderChat();
    await screen.findByText('Does anyone know the refund policy?');
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Who owns the SLA report?{Enter}');
    expect(await screen.findByTestId('team-chat-message-m5')).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: /AI/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/is answering/)).not.toBeInTheDocument();
    expect(screen.queryByText(/did not answer|not available/)).not.toBeInTheDocument();
});
