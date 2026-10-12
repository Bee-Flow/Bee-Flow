// How the message column behaves for a reader: where it scrolls, what counts
// as read, a thread whose first message is older than the loaded page, drafts
// that survive leaving, IME input, and the notices about the AI. jsdom has no
// layout, so the scroller's geometry is faked where a test needs it.
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { clearDrafts } from './drafts';
import { rememberFirstAnswer } from './firstAnswer';
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
let later: ReturnType<typeof message>[];

beforeEach(() => {
    fetchMock.mockReset();
    stream.onEvent = null;
    clearDrafts();
    later = [];
    server = installServer(fetchMock)
        .on('GET', '/api/projects/p1/members', MEMBERS)
        .on('GET', CHAT, { chat: teamChat(), role: 'editor' })
        .on('GET', `${CHAT}/messages`, ({ query }) => (query.after
            ? { messages: later.filter(m => m.seq > Number(query.after)), hasMore: false }
            : { messages: [message(1), message(2)], hasMore: false }))
        .on('POST', `${CHAT}/read`, { ok: true })
        .on('POST', '/api/projects/p1/presence', { ok: true })
        .on('POST', '/api/projects/p1/typing', { ok: true })
        .on('GET', '/agents', []);
});

function renderChat(extra: Partial<React.ComponentProps<typeof ProjectTeamChat>> = {}) {
    return renderLive(
        <ProjectTeamChat projectId="p1" project={PROJECT} role="editor" currentUser={{ id: 'u-me', name: 'Tom Me' }} chatId="c1" onBack={vi.fn()} {...extra} />,
    );
}

/** Fake the scroller's layout and tell the list the reader moved. */
function scrollerAt(el: HTMLElement, { scrollTop, scrollHeight = 1000, clientHeight = 400 }: { scrollTop: number; scrollHeight?: number; clientHeight?: number }) {
    Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true });
    el.scrollTop = scrollTop;
    act(() => { el.dispatchEvent(new Event('scroll')); });
}

/** A key the IME is handling: Safari reports isComposing=false here, but keyCode 229. */
function imeEnter(el: HTMLElement, init: KeyboardEventInit = {}) {
    act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true, ...init })); });
}

it('sending while scrolled up brings the new message into view', async () => {
    server.on('POST', `${CHAT}/messages`, () => new Promise(() => {}));
    const user = userEvent.setup();
    renderChat();
    await screen.findByText('Message 1');
    const list = screen.getByTestId('team-chat-messages');
    scrollerAt(list, { scrollTop: 100 });
    expect(list.scrollTop).toBe(100);

    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Reply from above{Enter}');
    expect(screen.getByText('Sending…')).toBeInTheDocument();
    expect(list.scrollTop).toBe(1000);
});

it('does not mark the chat read while scrolled up, and offers a pill that scrolls down and marks it', async () => {
    const user = userEvent.setup();
    renderChat();
    await screen.findByText('Message 1');
    await waitFor(() => expect(server.called('POST', `${CHAT}/read`)[0]?.body).toEqual({ seq: 2 }));
    const list = screen.getByTestId('team-chat-messages');
    scrollerAt(list, { scrollTop: 100 });

    later = [message(3), message(4, { authorKind: 'assistant', authorUserId: null })];
    emit(stream, 'chat.message.created', { payload: { chatId: 'c1' } });
    expect(await screen.findByTestId('team-chat-new-messages')).toHaveTextContent('2 new messages');
    expect(server.called('POST', `${CHAT}/read`)).toHaveLength(1);

    await user.click(screen.getByTestId('team-chat-new-messages'));
    expect(list.scrollTop).toBe(1000);
    await waitFor(() => expect(server.called('POST', `${CHAT}/read`).at(-1)?.body).toEqual({ seq: 4 }));
    expect(screen.queryByTestId('team-chat-new-messages')).not.toBeInTheDocument();
});

it('shows no pill for a message of your own', async () => {
    renderChat();
    await screen.findByText('Message 1');
    scrollerAt(screen.getByTestId('team-chat-messages'), { scrollTop: 100 });
    later = [message(3, { authorUserId: 'u-me' })];
    emit(stream, 'chat.message.created', { payload: { chatId: 'c1' } });
    await screen.findByText('Message 3');
    expect(screen.queryByTestId('team-chat-new-messages')).not.toBeInTheDocument();
});

it('marks where the unread messages start, above the first one', async () => {
    server.on('GET', CHAT, { chat: teamChat({ unread: 1 }), role: 'editor' })
        .on('GET', `${CHAT}/messages`, { messages: [message(1), message(2, { authorUserId: 'u-ben' })], hasMore: false });
    renderChat();
    await screen.findByText('Message 2');
    const divider = screen.getByTestId('team-chat-unread-divider');
    expect(divider).toHaveTextContent('New since your last visit');
    const above = divider.nextElementSibling as HTMLElement;
    expect(within(above).getByTestId('team-chat-message-m2')).toBeInTheDocument();
});

it('shows no unread divider when everything was read, or the unread ones are your own', async () => {
    const first = renderChat();
    await screen.findByText('Message 1');
    expect(screen.queryByTestId('team-chat-unread-divider')).not.toBeInTheDocument();
    first.unmount();

    server.on('GET', CHAT, { chat: teamChat({ unread: 2 }), role: 'editor' })
        .on('GET', `${CHAT}/messages`, { messages: [message(1, { authorUserId: 'u-me' }), message(2, { authorUserId: 'u-me' })], hasMore: false });
    renderChat();
    await screen.findByText('Message 1');
    expect(screen.queryByTestId('team-chat-unread-divider')).not.toBeInTheDocument();
});

it('shows skeleton messages while the first page loads', async () => {
    server.on('GET', `${CHAT}/messages`, () => new Promise(() => {}));
    renderChat();
    expect(await screen.findByTestId('team-chat-skeleton')).toBeInTheDocument();
    expect(screen.queryByTestId('team-chat-empty')).not.toBeInTheDocument();
});

// A thread whose first message is older than the newest page the chat loaded.
function threadServer(before: (query: Record<string, string>) => unknown) {
    const reply1 = message(60, { id: 'r1', threadId: 'm1', content: 'A reply' });
    server.on('GET', `${CHAT}/messages`, ({ query }) => (query.before ? before(query) : { messages: [reply1], hasMore: true }));
}

it('fetches a thread root that is older than the loaded page, with a loading state meanwhile', async () => {
    let release: (v: unknown) => void = () => {};
    threadServer(() => new Promise((resolve) => { release = resolve; }));
    renderChat({ initialThreadId: 'm1' });
    expect(await screen.findByTestId('team-chat-thread-root-missing')).toHaveTextContent('Loading the start of this thread');
    expect(await screen.findByText('A reply')).toBeInTheDocument();

    release({ messages: [message(1, { content: 'The very first message' })], hasMore: false });
    const root = await screen.findByTestId('team-chat-thread-root');
    expect(root).toHaveTextContent('The very first message');
    expect(screen.queryByTestId('team-chat-thread-root-missing')).not.toBeInTheDocument();
});

it('keeps paging back until the thread root turns up', async () => {
    threadServer(({ before }) => (Number(before) > 40
        ? { messages: [message(30)], hasMore: true }
        : { messages: [message(1, { content: 'Found it' })], hasMore: false }));
    renderChat({ initialThreadId: 'm1' });
    expect(await screen.findByTestId('team-chat-thread-root')).toHaveTextContent('Found it');
    expect(server.called('GET', `${CHAT}/messages`).filter(c => c.query.before)).toHaveLength(2);
});

it('says the thread start could not be loaded, instead of an empty panel, and retries', async () => {
    let ok = false;
    threadServer(() => (ok ? { messages: [message(1, { content: 'Back again' })], hasMore: false } : reply(500, { error: 'boom' })));
    const user = userEvent.setup();
    renderChat({ initialThreadId: 'm1' });
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded');
    ok = true;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('team-chat-thread-root')).toHaveTextContent('Back again');
});

it('does not send on the Enter that confirms an IME composition', async () => {
    const user = userEvent.setup();
    renderChat();
    await screen.findByText('Message 1');
    const box = screen.getByRole('textbox', { name: 'Message' });
    await user.type(box, 'こんにちは');
    imeEnter(box);
    expect(server.called('POST', `${CHAT}/messages`)).toHaveLength(0);
    expect(box).toHaveValue('こんにちは');
});

it('does not pick a mention on an IME Enter either', async () => {
    const user = userEvent.setup();
    renderChat();
    await screen.findByText('Message 1');
    const box = screen.getByRole('textbox', { name: 'Message' });
    await user.type(box, 'hi @Ad');
    expect(await screen.findByRole('listbox')).toBeInTheDocument();
    imeEnter(box, { keyCode: 13, isComposing: true });
    expect(box).toHaveValue('hi @Ad');
});

it('closes the mention menu when the caret leaves the @word, so Enter cannot corrupt the text', async () => {
    const user = userEvent.setup();
    renderChat();
    await screen.findByText('Message 1');
    const box = screen.getByRole('textbox', { name: 'Message' });
    await user.type(box, 'hi @Ad');
    expect(await screen.findByRole('listbox')).toBeInTheDocument();
    await user.keyboard('{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}');
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
});

it('keeps an unsent message when the chat is left and opened again, and forgets it once sent', async () => {
    server.on('POST', `${CHAT}/messages`, { message: message(3, { authorUserId: 'u-me' }), ai: { status: 'skipped' } });
    const user = userEvent.setup();
    const first = renderChat();
    await screen.findByText('Message 1');
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Half a thought');
    first.unmount();

    const second = renderChat();
    await screen.findByText('Message 1');
    const box = screen.getByRole('textbox', { name: 'Message' });
    expect(box).toHaveValue('Half a thought');
    await user.type(box, '{Enter}');
    await waitFor(() => expect(server.called('POST', `${CHAT}/messages`)).toHaveLength(1));
    second.unmount();

    renderChat();
    await screen.findByText('Message 1');
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('');
});

it('shows what the AI said about the first message that created the chat', async () => {
    rememberFirstAnswer('c1', { status: 'skipped', reason: 'limit' }, '@ai summarise');
    renderChat();
    expect(await screen.findByText(/AI usage limit has been reached/)).toBeInTheDocument();
});

it('shows the answering line for a first message the AI is still working on', async () => {
    rememberFirstAnswer('c1', { status: 'queued' }, 'hello');
    renderChat();
    expect(await screen.findByTestId('team-chat-typing')).toHaveTextContent('is answering');
});

it('drops the "ask again when it is done" notice once the AI has finished', async () => {
    server.on('POST', `${CHAT}/messages`, { message: message(3, { authorUserId: 'u-me' }), ai: { status: 'busy' } });
    const user = userEvent.setup();
    renderChat();
    await screen.findByText('Message 1');
    emit(stream, 'chat.ai.started', { payload: { chatId: 'c1' } });
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'again?{Enter}');
    expect(await screen.findByText(/Ask again when it is done/)).toBeInTheDocument();
    emit(stream, 'chat.ai.finished', { payload: { chatId: 'c1', status: 'ok' } });
    await waitFor(() => expect(screen.queryByText(/Ask again when it is done/)).not.toBeInTheDocument());
});

it('shows the notice for a thread post beside the thread box, not in the main column', async () => {
    const reply1 = message(60, { id: 'r1', threadId: 'm1', content: 'A reply' });
    server.on('GET', `${CHAT}/messages`, { messages: [message(1), reply1], hasMore: false });
    server.on('POST', `${CHAT}/messages`, { message: message(61, { authorUserId: 'u-me', threadId: 'm1' }), ai: { status: 'skipped', reason: 'limit' } });
    const user = userEvent.setup();
    renderChat({ initialThreadId: 'm1' });
    const panel = await screen.findByTestId('team-chat-thread-panel');
    await screen.findByText('A reply');
    await user.type(within(panel).getByRole('textbox', { name: 'Message' }), 'ask{Enter}');
    const notice = await within(panel).findByText(/AI usage limit has been reached/);
    expect(panel).toContainElement(notice);
    expect(screen.getAllByText(/AI usage limit has been reached/)).toHaveLength(1);
});
