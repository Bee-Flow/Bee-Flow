import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import ProjectTeamChat from './ProjectTeamChat';
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

const CHAT = '/api/projects/p1/chats/c1';
let server: TestServer;

beforeEach(() => {
    fetchMock.mockReset();
    stream.onEvent = null;
    server = installServer(fetchMock)
        .on('GET', '/api/projects/p1/members', MEMBERS)
        .on('GET', CHAT, { chat: teamChat(), role: 'editor' })
        .on('GET', `${CHAT}/messages`, ({ query }) => (query.after ? { messages: [], hasMore: false } : {
            messages: [message(1), message(2, { authorKind: 'assistant', authorUserId: null, content: '**Hi** there' })],
            hasMore: false,
        }))
        .on('PATCH', CHAT, ({ body }) => ({ chat: teamChat(body) }))
        .on('POST', `${CHAT}/read`, { ok: true })
        .on('POST', '/api/projects/p1/presence', { ok: true })
        .on('POST', '/api/projects/p1/typing', { ok: true })
        .on('GET', '/agents', []);
});

function renderChat(role: 'owner' | 'editor' | 'viewer' = 'editor') {
    const onBack = vi.fn();
    const view = renderLive(
        <ProjectTeamChat projectId="p1" project={PROJECT} role={role} currentUser={{ id: 'u-me', name: 'Tom Me' }} chatId="c1" onBack={onBack} />,
    );
    return { ...view, onBack };
}

it('shows the messages with their authors, and the AI answer through the markdown renderer', async () => {
    renderChat();
    expect(await screen.findByText('Message 1')).toBeInTheDocument();
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByTestId('markdown')).toHaveTextContent('**Hi** there');
    expect(screen.getAllByText('AI assistant').length).toBeGreaterThan(0);
});

it('marks the chat read up to the newest message', async () => {
    renderChat();
    await waitFor(() => expect(server.called('POST', `${CHAT}/read`)[0]?.body).toEqual({ seq: 2 }));
});

it('shows a sent message at once, then the confirmed one', async () => {
    let release: (v: unknown) => void = () => {};
    server.on('POST', `${CHAT}/messages`, () => new Promise((resolve) => { release = resolve; }));
    const user = userEvent.setup();
    renderChat();
    await screen.findByText('Message 1');
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Hello team{Enter}');

    expect(screen.getByText('Hello team')).toBeInTheDocument();
    expect(screen.getByText('Sending…')).toBeInTheDocument();
    const sent = server.called('POST', `${CHAT}/messages`)[0].body;
    expect(sent).toMatchObject({ content: 'Hello team', mentions: [], askAi: false, replyTo: null });
    expect(typeof sent.clientMsgId).toBe('string');

    release({ message: message(3, { authorUserId: 'u-me', content: 'Hello team' }), ai: { status: 'skipped' } });
    expect(await screen.findByTestId('team-chat-message-m3')).toHaveTextContent('Hello team');
    expect(screen.queryByText('Sending…')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('');
});

it('keeps a refused message as not sent, and a retry resends it with the same id', async () => {
    // The client retries a 503 once by itself, so the first TWO attempts fail.
    let attempt = 0;
    server.on('POST', `${CHAT}/messages`, () => {
        attempt += 1;
        return attempt <= 2
            ? reply(503, { error: 'The project key is not available right now.', code: 'PROJECT_KEY_UNAVAILABLE' })
            : { message: message(3, { authorUserId: 'u-me', content: 'Try me' }), ai: { status: 'skipped' } };
    });
    const user = userEvent.setup();
    renderChat();
    await screen.findByText('Message 1');
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Try me{Enter}');

    // The refusal is said from its code in the reader's language, not in the
    // server's English (the sentence the server sent is only the fallback).
    expect(await screen.findByText(/Not sent\. The project’s encryption key is not available right now/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Try again/ }));

    expect(await screen.findByTestId('team-chat-message-m3')).toHaveTextContent('Try me');
    const posts = server.called('POST', `${CHAT}/messages`);
    expect(posts).toHaveLength(3);
    expect(new Set(posts.map(p => p.body.clientMsgId)).size).toBe(1);
    expect(screen.queryByText(/Not sent/)).not.toBeInTheDocument();
});

it('discarding a message that was not sent removes it', async () => {
    server.on('POST', `${CHAT}/messages`, reply(400, { error: 'Too long.' }));
    const user = userEvent.setup();
    renderChat();
    await screen.findByText('Message 1');
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Bye{Enter}');
    await screen.findByText(/Not sent/);
    await user.click(screen.getByRole('button', { name: /Discard/ }));
    expect(screen.queryByText('Bye')).not.toBeInTheDocument();
});

it('@ opens the member menu; picking a name inserts it and sends the mention', async () => {
    server.on('POST', `${CHAT}/messages`, { message: message(3, { authorUserId: 'u-me' }), ai: { status: 'skipped' } });
    const user = userEvent.setup();
    renderChat();
    await screen.findByText('Message 1');
    const box = screen.getByRole('textbox', { name: 'Message' });
    await user.type(box, 'Hi @ad');

    const menu = await screen.findByRole('listbox', { name: 'Mention someone' });
    expect(within(menu).getByRole('option', { name: /Ada Lovelace/ })).toBeInTheDocument();
    expect(within(menu).queryByRole('option', { name: /Tom Me/ })).not.toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(box).toHaveValue('Hi @Ada Lovelace ');

    await user.keyboard('look{Enter}');
    await waitFor(() => expect(server.called('POST', `${CHAT}/messages`)).toHaveLength(1));
    expect(server.called('POST', `${CHAT}/messages`)[0].body).toMatchObject({ content: 'Hi @Ada Lovelace look', mentions: ['u-ada'], askAi: false });
});

it('picking the AI from the menu asks it to answer, and shows it answering', async () => {
    server.on('POST', `${CHAT}/messages`, { message: message(3, { authorUserId: 'u-me' }), ai: { status: 'queued' } });
    const user = userEvent.setup();
    renderChat();
    await screen.findByText('Message 1');
    await user.type(screen.getByRole('textbox', { name: 'Message' }), '@A');
    const menu = await screen.findByRole('listbox', { name: 'Mention someone' });
    await user.click(within(menu).getByRole('option', { name: /AI assistant/ }));
    await user.keyboard('summarise please{Enter}');

    await waitFor(() => expect(server.called('POST', `${CHAT}/messages`)[0]?.body).toMatchObject({ content: '@ai summarise please', askAi: true }));
    expect(await screen.findByText('AI assistant is answering…')).toBeInTheDocument();
});

it('a viewer reads the chat but cannot post, rename or change the AI mode', async () => {
    renderChat('viewer');
    await screen.findByText('Message 1');
    expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument();
    expect(screen.getByText('You can read this chat. Only editors can post in it.')).toBeInTheDocument();
    expect(screen.getByTestId('team-chat-ai-mode-readonly')).toHaveTextContent('AI on mention');
    expect(screen.queryByRole('radiogroup', { name: 'When the AI answers' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Chat actions' })).not.toBeInTheDocument();
});

it('changing the AI mode patches the chat', async () => {
    const user = userEvent.setup();
    renderChat();
    await screen.findByText('Message 1');
    await user.click(screen.getByRole('radio', { name: 'Always' }));
    await waitFor(() => expect(server.called('PATCH', CHAT)[0]?.body).toEqual({ aiMode: 'always' }));
    expect(screen.getByRole('radio', { name: 'Always' })).toHaveAttribute('aria-checked', 'true');
});

it('puts the AI mode back when the server refuses the change', async () => {
    server.on('PATCH', CHAT, reply(403, { error: 'Only editors can change this chat.' }));
    const user = userEvent.setup();
    renderChat();
    await screen.findByText('Message 1');
    await user.click(screen.getByRole('radio', { name: 'Off' }));
    await waitFor(() => expect(screen.getByRole('radio', { name: 'On mention' })).toHaveAttribute('aria-checked', 'true'));
});

it('a live "message created" event pulls the new message after the newest one held', async () => {
    renderChat();
    await screen.findByText('Message 1');
    server.on('GET', `${CHAT}/messages`, ({ query }) => ({
        messages: query.after === '2' ? [message(3, { content: 'Fresh news' })] : [], hasMore: false,
    }));
    emit(stream, 'chat.message.created', { payload: { chatId: 'c1', messageId: 'm3', seq: 3, authorKind: 'user' } });
    expect(await screen.findByText('Fresh news')).toBeInTheDocument();
    expect(server.called('GET', `${CHAT}/messages`).some(c => c.query.after === '2')).toBe(true);
});

it('shows who is typing, the AI at work, and an AI that could not answer', async () => {
    renderChat();
    await screen.findByText('Message 1');
    emit(stream, 'presence.typing', { actorId: 'u-ada', conversationId: 'c1', transient: true });
    expect(await screen.findByText('Ada Lovelace is typing…')).toBeInTheDocument();

    emit(stream, 'chat.ai.started', { actorId: 'u-ada', payload: { chatId: 'c1' }, transient: true });
    expect(await screen.findByText('AI assistant is answering…')).toBeInTheDocument();

    emit(stream, 'chat.ai.finished', { payload: { chatId: 'c1', status: 'failed' }, transient: true });
    expect(await screen.findByText('The AI could not answer. Try asking again.')).toBeInTheDocument();
    expect(screen.queryByText('AI assistant is answering…')).not.toBeInTheDocument();
});

it('says plainly when privacy protection stopped the AI', async () => {
    renderChat();
    await screen.findByText('Message 1');
    emit(stream, 'chat.ai.finished', { payload: { chatId: 'c1', status: 'blocked' }, transient: true });
    expect(await screen.findByText('Privacy protection stopped the AI from answering this message.')).toBeInTheDocument();
});

it('tells the author when the AI is over its usage limit', async () => {
    server.on('POST', `${CHAT}/messages`, { message: message(3, { authorUserId: 'u-me' }), ai: { status: 'skipped', reason: 'limit' } });
    const user = userEvent.setup();
    renderChat();
    await screen.findByText('Message 1');
    await user.type(screen.getByRole('textbox', { name: 'Message' }), '@ai help{Enter}');
    expect(await screen.findByText('The AI did not answer: the AI usage limit has been reached.')).toBeInTheDocument();
});

it('a message that cannot be decrypted says so instead of showing anything', async () => {
    server.on('GET', `${CHAT}/messages`, { messages: [message(1, { content: '', unreadable: true })], hasMore: false });
    renderChat();
    expect(await screen.findByText('This message could not be decrypted.')).toBeInTheDocument();
});

it('ignores events about another chat', async () => {
    renderChat();
    await screen.findByText('Message 1');
    emit(stream, 'chat.ai.started', { payload: { chatId: 'other' }, transient: true });
    emit(stream, 'presence.typing', { actorId: 'u-ada', conversationId: 'other', transient: true });
    expect(screen.queryByTestId('team-chat-typing')).not.toBeInTheDocument();
});

it('says so when the open chat is deleted, and goes back on request', async () => {
    const user = userEvent.setup();
    const { onBack } = renderChat();
    await screen.findByText('Message 1');
    emit(stream, 'chat.deleted', { payload: { chatId: 'c1' } });
    expect(await screen.findByText('This chat was deleted, or you no longer have access to it.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back to chats' }));
    expect(onBack).toHaveBeenCalled();
});

it('a chat the caller may not open reads as gone, not as an empty chat', async () => {
    server.on('GET', CHAT, reply(404, { error: 'Not found' }));
    renderChat();
    expect(await screen.findByTestId('team-chat-unavailable')).toHaveTextContent('This chat was deleted, or you no longer have access to it.');
    expect(screen.queryByTestId('team-chat-empty')).not.toBeInTheDocument();
});

it('Reply, Edit and Delete are reachable from the keyboard: the bar hides by opacity, never by display', async () => {
    server.on('GET', `${CHAT}/messages`, ({ query }) => (query.after ? { messages: [], hasMore: false } : {
        messages: [message(1, { authorUserId: 'u-me', content: 'My own words' })], hasMore: false,
    }));
    const user = userEvent.setup();
    renderChat();
    const mine = await screen.findByTestId('team-chat-message-m1');
    const bar = within(mine).getByTestId('team-chat-message-actions');
    // jsdom applies no Tailwind, so the classes are what a browser would hide it with.
    expect(bar.className.split(/\s+/)).not.toContain('hidden');
    expect(bar).toHaveClass('md:opacity-0', 'md:group-focus-within/msg:opacity-100', 'md:group-hover/msg:opacity-100');
    // A tap on the message focuses it (a touch screen has no hover), without making it a tab stop.
    await user.click(within(mine).getByText('My own words'));
    expect(mine).toHaveFocus();
    expect(mine).toHaveAttribute('tabindex', '-1');

    const edit = within(mine).getByRole('button', { name: 'Edit' });
    for (let i = 0; i < 60 && document.activeElement !== edit; i++) await user.tab();
    expect(edit).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(within(mine).getByRole('textbox', { name: 'Edit message' })).toHaveValue('My own words');
});

it('a chat whose mode the organisation withdrew says it is limited, and why the AI stayed quiet', async () => {
    server.on('GET', CHAT, { chat: teamChat({ aiMode: 'always', effectiveAiMode: 'mention' }), role: 'editor' });
    server.on('POST', `${CHAT}/messages`, { message: message(3, { authorUserId: 'u-me' }), ai: { status: 'skipped', reason: 'ai_mode_not_allowed' } });
    const user = userEvent.setup();
    renderChat();
    await screen.findByText('Message 1');
    expect(screen.getByTestId('team-chat-mode-withdrawn')).toHaveTextContent('Limited');
    expect(screen.getByTestId('team-chat-mode-withdrawn')).toHaveTextContent('the AI only answers when someone mentions it');
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'hello{Enter}');
    expect(await screen.findByText('Your organisation no longer lets the AI answer every message here. Mention @ai to ask it.')).toBeInTheDocument();
});
