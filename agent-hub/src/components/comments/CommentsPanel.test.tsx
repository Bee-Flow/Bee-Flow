import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { CommentAnchor } from '../../api/queries/comments';
import { emit, installServer, MEMBERS, renderLive, reply, testClient, type StreamHolder, type TestServer } from '../projects/workspace/chat/teamChatTestKit';
import CommentsPanel, { type CommentsPanelProps } from './CommentsPanel';

const { fetchMock, stream } = vi.hoisted(() => ({ fetchMock: vi.fn(), stream: { onEvent: null } as StreamHolder }));
vi.mock('../../utils/helpers', () => ({ API_BASE: '', authFetch: fetchMock }));
vi.mock('../../hooks/useProjectStream', () => ({
    default: (opts: { onEvent: StreamHolder['onEvent'] }) => { stream.onEvent = opts.onEvent; },
}));

const BASE = '/api/projects/p1/comments';
const anchor = (quote: string, blockIndex: number): CommentAnchor => ({ quote, prefix: '', suffix: '', blockIndex });

function comment(id: string, seq: number, over: Record<string, unknown> = {}) {
    return {
        id, seq, authorKind: 'user', authorUserId: 'u-ada', agentId: null, content: `Comment ${id}`, mentions: [], mentionsAi: false,
        replyTo: null, aiTrigger: null, createdAt: '2026-09-29T10:00:00.000Z', editedAt: null, deleted: false, ...over,
    };
}

function thread(id: string, over: Record<string, unknown> = {}) {
    return {
        id, targetType: 'notebook', targetId: 'nb1', anchor: anchor(`passage ${id}`, 1), status: 'open', aiMode: 'mention',
        createdBy: 'u-ada', resolvedBy: null, resolvedAt: null, commentCount: 1, createdAt: `2026-09-2${id.length}T10:00:00.000Z`,
        updatedAt: '2026-09-29T10:00:00.000Z', comments: [comment(`${id}-c1`, 1)], ...over,
    };
}

let server: TestServer;
let threads: Array<ReturnType<typeof thread>>;
let role: string;

beforeEach(() => {
    fetchMock.mockReset();
    stream.onEvent = null;
    role = 'editor';
    threads = [
        thread('t3', { anchor: anchor('a removed passage', 5), createdAt: '2026-09-20T10:00:00.000Z', comments: [comment('t3-c1', 1, { content: 'Gone?' })] }),
        thread('t1', { anchor: anchor('the budget is 40k', 2), createdAt: '2026-09-21T10:00:00.000Z', comments: [comment('t1-c1', 1, { content: 'Is this right?' })] }),
        thread('t2', { status: 'resolved', resolvedAt: '2026-09-22T10:00:00.000Z', comments: [comment('t2-c1', 1, { authorUserId: 'u-me', content: 'Done' })] }),
    ];
    server = installServer(fetchMock)
        .on('GET', '/api/projects/p1/members', MEMBERS)
        .on('POST', '/api/projects/p1/presence', { ok: true })
        .on('GET', BASE, () => ({ threads, role }));
});

function renderPanel(over: Partial<CommentsPanelProps> = {}) {
    const props: CommentsPanelProps = {
        projectId: 'p1', targetType: 'notebook', targetId: 'nb1', role: 'editor', currentUser: { id: 'u-me', name: 'Tom Me' },
        getSelectionAnchor: vi.fn(() => null), highlightAnchors: vi.fn(), scrollToAnchor: vi.fn(() => true), ...over,
    };
    return { ...renderLive(<CommentsPanel {...props} />), props };
}

const threadCard = (id: string) => screen.getByTestId(`comment-thread-${id}`);

it('lists open threads in reading order, highlights their passages, and marks a passage that is gone', async () => {
    const { props } = renderPanel({ getDocumentText: () => 'We agreed the budget\nis 40k for Q3.' });
    expect(await screen.findByText('Is this right?')).toBeInTheDocument();
    const cards = screen.getAllByRole('article');
    expect(cards.map(c => c.getAttribute('data-testid'))).toEqual(['comment-thread-t1', 'comment-thread-t3']);
    expect(within(threadCard('t3')).getByTestId('comment-anchor-outdated')).toHaveTextContent('This passage was changed or removed.');
    expect(screen.queryByText('Done')).not.toBeInTheDocument();
    await waitFor(() => expect(props.highlightAnchors).toHaveBeenLastCalledWith([{ id: 't1', anchor: anchor('the budget is 40k', 2) }], null));
    expect(screen.getByRole('radio', { name: /Resolved/ })).toHaveTextContent('1');
    expect(server.called('GET', BASE)[0].query).toEqual({ targetType: 'notebook', targetId: 'nb1', status: 'all' });
});

it('adds a comment on the selected passage and shows the new thread', async () => {
    const selection = anchor('the budget is 40k', 2);
    server.on('POST', BASE, ({ body }) => reply(201, {
        thread: thread('t9', { anchor: body.anchor, createdAt: '2026-09-29T11:00:00.000Z', comments: [comment('t9-c1', 1, { authorUserId: 'u-me', content: body.content })] }),
        ai: { status: 'skipped', reason: 'not_mentioned' },
    }));
    const user = userEvent.setup();
    renderPanel({ getSelectionAnchor: () => selection });
    await screen.findByText('Is this right?');
    await user.click(screen.getByTestId('comments-add'));
    const form = screen.getByTestId('comment-new-form');
    expect(within(form).getByTestId('comment-anchor')).toHaveTextContent('the budget is 40k');
    await user.type(within(form).getByRole('textbox', { name: 'New comment' }), 'Should this be 45k?');
    await user.click(within(form).getByRole('button', { name: 'Comment' }));

    expect(await screen.findByText('Should this be 45k?')).toBeInTheDocument();
    const sent = server.called('POST', BASE)[0].body;
    expect(sent).toMatchObject({ targetType: 'notebook', targetId: 'nb1', anchor: selection, content: 'Should this be 45k?', mentions: [], askAi: false });
    expect(typeof sent.clientThreadId).toBe('string');
    expect(screen.queryByTestId('comment-new-form')).not.toBeInTheDocument();
});

it('without a selection the comment is on the whole item', async () => {
    server.on('POST', BASE, ({ body }) => reply(201, { thread: thread('t8', { anchor: body.anchor }), ai: { status: 'skipped' } }));
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText('Is this right?');
    await user.click(screen.getByTestId('comments-add'));
    expect(screen.getByTestId('comment-anchor-whole')).toHaveTextContent('On the whole notebook');
    await user.type(screen.getByRole('textbox', { name: 'New comment' }), 'Overall fine{Control>}{Enter}{/Control}');
    await waitFor(() => expect(server.called('POST', BASE)).toHaveLength(1));
    expect(server.called('POST', BASE)[0].body.anchor).toBeNull();
});

it('a refused comment keeps the text and says why', async () => {
    server.on('POST', BASE, reply(503, { error: 'Unavailable', code: 'PROJECT_KEY_UNAVAILABLE' }));
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText('Is this right?');
    await user.click(screen.getByTestId('comments-add'));
    const box = screen.getByRole('textbox', { name: 'New comment' });
    await user.type(box, 'Keep me');
    await user.click(screen.getByRole('button', { name: 'Comment' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('encryption key is not available');
    expect(box).toHaveValue('Keep me');
});

it('replies with an @mention from the menu, and the reply appears in the thread', async () => {
    server.on('POST', `${BASE}/t1/replies`, ({ body }) => reply(201, {
        comment: comment('t1-c2', 2, { authorUserId: 'u-me', content: body.content, mentions: body.mentions }),
        ai: { status: 'skipped' }, thread: { id: 't1', status: 'open' },
    }));
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText('Is this right?');
    await user.click(within(threadCard('t1')).getByTestId('comment-reply-open'));
    const box = within(threadCard('t1')).getByRole('textbox', { name: 'Reply' });
    await user.type(box, 'Agreed @Ad');
    await user.click(await screen.findByRole('option', { name: 'Ada Lovelace' }));
    await user.type(box, 'please check');
    await user.click(within(threadCard('t1')).getByRole('button', { name: 'Reply' }));

    await waitFor(() => expect(server.called('POST', `${BASE}/t1/replies`)).toHaveLength(1));
    expect(server.called('POST', `${BASE}/t1/replies`)[0].body).toMatchObject({
        content: 'Agreed @Ada Lovelace please check', mentions: ['u-ada'], askAi: false,
    });
    expect(await within(threadCard('t1')).findByText('@Ada Lovelace')).toBeInTheDocument();
});

it('Ask AI sends the request, and the thread shows the AI answering until it finishes', async () => {
    server.on('POST', `${BASE}/t1/replies`, ({ body }) => reply(201, {
        comment: comment('t1-c2', 2, { authorUserId: 'u-me', content: body.content }), ai: { status: 'queued' }, thread: { id: 't1', status: 'open' },
    }));
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText('Is this right?');
    await user.click(within(threadCard('t1')).getByTestId('comment-reply-open'));
    await user.type(within(threadCard('t1')).getByRole('textbox', { name: 'Reply' }), 'What does it cover?');
    await user.click(within(threadCard('t1')).getByRole('button', { name: 'Ask AI' }));
    await waitFor(() => expect(server.called('POST', `${BASE}/t1/replies`)[0]?.body.askAi).toBe(true));

    const payload = { threadId: 't1', targetType: 'notebook', targetId: 'nb1' };
    emit(stream, 'comment.ai.started', { transient: true, payload: { ...payload, status: 'running' } });
    expect(within(threadCard('t1')).getByTestId('comment-ai-running')).toHaveTextContent('AI is answering…');
    threads = threads.map(t => (t.id === 't1' ? { ...t, comments: [...t.comments, comment('t1-ai', 3, { authorKind: 'assistant', authorUserId: null, content: 'It covers travel.' })] } : t));
    emit(stream, 'comment.ai.finished', { transient: true, payload: { ...payload, status: 'answered' } });
    expect(await within(threadCard('t1')).findByText('It covers travel.')).toBeInTheDocument();
    expect(within(threadCard('t1')).queryByTestId('comment-ai-running')).not.toBeInTheDocument();
    expect(within(threadCard('t1')).getByText('AI assistant')).toBeInTheDocument();
});

it('resolve moves a thread to Resolved; a refused resolve puts it back and says why', async () => {
    server.on('POST', `${BASE}/t1/resolve`, () => reply(200, { thread: { ...threads[1], status: 'resolved', resolvedAt: '2026-09-29T12:00:00.000Z' } }));
    server.on('POST', `${BASE}/t3/resolve`, reply(404, { error: 'Gone', code: 'thread_not_found' }));
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText('Is this right?');
    await user.click(within(threadCard('t1')).getByTestId('comment-thread-toggle'));
    await waitFor(() => expect(screen.queryByTestId('comment-thread-t1')).not.toBeInTheDocument());
    await user.click(screen.getByRole('radio', { name: /Resolved/ }));
    expect(within(threadCard('t1')).getByTestId('comment-thread-toggle')).toHaveTextContent('Reopen');
    await user.click(screen.getByRole('radio', { name: /Open/ }));

    await user.click(within(threadCard('t3')).getByTestId('comment-thread-toggle'));
    expect(await within(threadCard('t3')).findByRole('alert')).toHaveTextContent('This thread was deleted.');
});

it('a click on a passage scrolls to it; one that cannot be found is marked as changed', async () => {
    const scrollToAnchor = vi.fn((a: CommentAnchor) => a.quote !== 'a removed passage');
    const user = userEvent.setup();
    const { props } = renderPanel({ scrollToAnchor });
    await screen.findByText('Is this right?');
    await user.click(within(threadCard('t1')).getByRole('button', { name: /Show this passage/ }));
    expect(scrollToAnchor).toHaveBeenCalledWith(anchor('the budget is 40k', 2));
    await waitFor(() => expect(props.highlightAnchors).toHaveBeenLastCalledWith(expect.any(Array), 't1'));
    await user.click(within(threadCard('t3')).getByRole('button', { name: /Show this passage/ }));
    expect(await within(threadCard('t3')).findByTestId('comment-anchor-outdated')).toBeInTheDocument();
});

it('the author edits their own comment; nobody edits someone else\'s', async () => {
    threads[1].comments.push(comment('t1-mine', 2, { authorUserId: 'u-me', content: 'My first take' }));
    server.on('PATCH', `${BASE}/t1/replies/t1-mine`, ({ body }) => ({ comment: comment('t1-mine', 2, { authorUserId: 'u-me', content: body.content, editedAt: '2026-09-29T12:00:00.000Z' }) }));
    const user = userEvent.setup();
    renderPanel();
    const mine = await screen.findByTestId('comment-t1-mine');
    expect(within(screen.getByTestId('comment-t1-c1')).queryByRole('button', { name: /Edit/ })).not.toBeInTheDocument();
    await user.click(within(mine).getByRole('button', { name: /Edit/ }));
    const box = within(mine).getByRole('textbox', { name: 'Edit comment' });
    await user.clear(box);
    await user.type(box, 'My second take');
    await user.click(within(mine).getByRole('button', { name: 'Save' }));
    expect(await within(screen.getByTestId('comment-t1-mine')).findByText('My second take')).toBeInTheDocument();
    expect(within(screen.getByTestId('comment-t1-mine')).getByText('(edited)')).toBeInTheDocument();
    expect(server.called('PATCH', `${BASE}/t1/replies/t1-mine`)[0].body).toEqual({ content: 'My second take', mentions: [] });
});

it('a viewer reads the threads without any way to write', async () => {
    role = 'viewer';
    renderPanel({ role: 'viewer' });
    await screen.findByText('Is this right?');
    expect(screen.getByTestId('comments-read-only')).toBeInTheDocument();
    expect(screen.queryByTestId('comments-add')).not.toBeInTheDocument();
    expect(screen.queryByTestId('comment-reply-open')).not.toBeInTheDocument();
    expect(screen.queryByTestId('comment-thread-toggle')).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
});

it('a failed load says so and can be retried; an empty list explains what comments are for', async () => {
    server.on('GET', BASE, reply(500, { error: 'boom' }));
    const user = userEvent.setup();
    renderPanel();
    expect(await screen.findByTestId('comments-error', {}, { timeout: 4000 })).toHaveTextContent('boom');
    threads = [];
    server.on('GET', BASE, () => ({ threads, role }));
    await user.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByTestId('comments-empty-open')).toHaveTextContent('Select a passage in the notebook');
    await user.click(screen.getByRole('radio', { name: /Resolved/ }));
    expect(screen.getByTestId('comments-empty-resolved')).toHaveTextContent('No resolved threads');
});

it('a live comment event about this item refetches; one about another item does not', async () => {
    renderPanel();
    await screen.findByText('Is this right?');
    const before = server.called('GET', BASE).length;
    emit(stream, 'comment.created', { payload: { threadId: 'x', targetType: 'notebook', targetId: 'other' } });
    emit(stream, 'chat.message.created', { payload: { chatId: 'c1' } });
    expect(server.called('GET', BASE)).toHaveLength(before);
    threads = [...threads, thread('t4', { anchor: anchor('new one', 9), createdAt: '2026-09-29T09:00:00.000Z', comments: [comment('t4-c1', 1, { content: 'Fresh' })] })];
    emit(stream, 'comment.thread.created', { payload: { threadId: 't4', targetType: 'notebook', targetId: 'nb1' } });
    expect(await screen.findByText('Fresh')).toBeInTheDocument();
});

it('clears the highlights when the panel closes', async () => {
    const { props, unmount } = renderPanel();
    await screen.findByText('Is this right?');
    unmount();
    expect(props.highlightAnchors).toHaveBeenLastCalledWith([], null);
});

it('an answer the AI gave on its own can be marked "not helpful", and a paused thread says so', async () => {
    threads[1].aiMode = 'auto';
    threads[1].comments.push(comment('t1-auto', 2, { authorKind: 'assistant', authorUserId: null, content: 'From the Q3 plan.', aiTrigger: 'auto_unanswered', feedback: null }));
    threads[1].comments.push(comment('t1-asked', 3, { authorKind: 'assistant', authorUserId: null, content: 'Asked answer', aiTrigger: 'mention' }));
    const pausedUntil = new Date(Date.now() + 24 * 3600_000).toISOString();
    server.on('POST', `${BASE}/t1/replies/t1-auto/feedback`, ({ body }) => ({ ok: true, helpful: body.helpful, autoPausedUntil: pausedUntil }));
    const user = userEvent.setup();
    renderPanel();
    const auto = await screen.findByTestId('comment-t1-auto');
    expect(within(auto).getByTestId('comment-ai-joined')).toHaveTextContent('a question here had no answer yet');
    expect(within(screen.getByTestId('comment-t1-asked')).queryByTestId('comment-not-helpful')).not.toBeInTheDocument();

    await user.click(within(auto).getByRole('button', { name: /Not helpful/ }));
    expect(server.called('POST', `${BASE}/t1/replies/t1-auto/feedback`)[0].body).toEqual({ helpful: false });
    expect(await within(screen.getByTestId('comment-t1-auto')).findByText('Thanks, noted.')).toBeInTheDocument();
    expect(within(screen.getByTestId('comment-t1-auto')).getByRole('button', { name: /Not helpful/ })).toHaveAttribute('aria-pressed', 'true');
    expect(within(threadCard('t1')).getByTestId('comment-ai-paused')).toHaveTextContent('will not join this thread on its own');
});

it('a viewer cannot give feedback on an automatic answer', async () => {
    role = 'viewer';
    threads[1].comments.push(comment('t1-auto', 2, { authorKind: 'assistant', authorUserId: null, content: 'From the Q3 plan.', aiTrigger: 'auto_quiet', feedback: null }));
    renderPanel({ role: 'viewer' });
    await screen.findByText('From the Q3 plan.');
    expect(screen.queryByTestId('comment-not-helpful')).not.toBeInTheDocument();
});

it('fixing a typo keeps the people the comment mentions; taking a name out of the text drops them', async () => {
    threads[1].comments.push(comment('t1-mine', 2, { authorUserId: 'u-me', content: '@Ada Lovelace can you chek this figure?', mentions: ['u-ada'] }));
    server.on('PATCH', `${BASE}/t1/replies/t1-mine`, ({ body }) => ({ comment: comment('t1-mine', 2, { authorUserId: 'u-me', content: body.content, mentions: body.mentions }) }));
    const user = userEvent.setup();
    renderPanel();
    const mine = await screen.findByTestId('comment-t1-mine');
    await user.click(within(mine).getByRole('button', { name: /Edit/ }));
    const box = within(mine).getByRole('textbox', { name: 'Edit comment' });
    await user.clear(box);
    await user.type(box, '@Ada Lovelace can you check this figure?');
    await user.click(within(mine).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(server.called('PATCH', `${BASE}/t1/replies/t1-mine`)).toHaveLength(1));
    expect(server.called('PATCH', `${BASE}/t1/replies/t1-mine`)[0].body).toEqual({ content: '@Ada Lovelace can you check this figure?', mentions: ['u-ada'] });

    await user.click(within(await screen.findByTestId('comment-t1-mine')).getByRole('button', { name: /Edit/ }));
    const again = within(screen.getByTestId('comment-t1-mine')).getByRole('textbox', { name: 'Edit comment' });
    await user.clear(again);
    await user.type(again, 'Can someone check this figure?');
    await user.click(within(screen.getByTestId('comment-t1-mine')).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(server.called('PATCH', `${BASE}/t1/replies/t1-mine`)).toHaveLength(2));
    expect(server.called('PATCH', `${BASE}/t1/replies/t1-mine`)[1].body.mentions).toEqual([]);
});

it('"AI decides" is offered only where the organisation allows it, and a refusal says so', async () => {
    server.on('GET', BASE, () => ({ threads, role, aiPolicy: { autoAllowed: false } }));
    threads[0].aiMode = 'auto';
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText('Is this right?');
    const optionIn = (card: HTMLElement) => within(card).getByRole('option', { name: /AI decides/ }) as HTMLOptionElement;
    expect(optionIn(threadCard('t1')).disabled).toBe(true);
    expect(optionIn(threadCard('t1'))).toHaveTextContent('not allowed by your organisation');
    // A thread that has it already keeps it.
    expect(optionIn(threadCard('t3')).disabled).toBe(false);
    await user.click(screen.getByTestId('comments-add'));
    expect(optionIn(screen.getByTestId('comment-new-form')).disabled).toBe(true);

    // An older server sends no policy: the server's refusal is then said as it is.
    server.on('GET', BASE, () => ({ threads, role }));
    server.on('PATCH', `${BASE}/t1`, reply(403, { error: 'Your organisation does not let the AI join comment threads by itself.', code: 'ai_mode_not_allowed' }));
    emit(stream, 'comment.thread.updated', { payload: { threadId: 't1', targetType: 'notebook', targetId: 'nb1' } });
    await waitFor(() => expect(optionIn(threadCard('t1')).disabled).toBe(false));
    await user.selectOptions(within(threadCard('t1')).getByRole('combobox'), 'auto');
    const alert = await within(threadCard('t1')).findByRole('alert');
    expect(alert).toHaveTextContent('Your organisation does not let the AI join comment threads by itself. Choose another AI mode.');
    expect(alert).not.toHaveTextContent('Only the project');
});

it('a long thread shows its first and latest comments, and the earlier ones page by page until the first is reached', async () => {
    const whole = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => comment(`t1-c${n}`, n, { content: `Comment number ${n}` }));
    threads[1] = { ...threads[1], commentCount: 9, omittedComments: 6, comments: [whole[0], whole[7], whole[8]] } as typeof threads[number];
    // The thread's own read serves pages (of 5 here): the latest, then those before it.
    server.on('GET', `${BASE}/t1`, ({ query }) => (query.before === '5'
        ? { thread: { ...threads[1], omittedComments: undefined, comments: whole.slice(0, 4) }, role: 'editor' }
        : { thread: { ...threads[1], omittedComments: 4, comments: whole.slice(4) }, role: 'editor' }));
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText('Comment number 1');
    expect(within(threadCard('t1')).queryByText('Comment number 2')).not.toBeInTheDocument();
    await user.click(within(threadCard('t1')).getByRole('button', { name: 'Show 6 earlier comments' }));
    expect(await within(threadCard('t1')).findByText('Comment number 5')).toBeInTheDocument();
    // Seq 2..4 are still missing: it used to drop the button here and read as complete.
    await user.click(within(threadCard('t1')).getByRole('button', { name: 'Show 3 earlier comments' }));
    expect(await within(threadCard('t1')).findByText('Comment number 2')).toBeInTheDocument();
    expect(within(threadCard('t1')).getAllByText(/^Comment number \d$/).map(el => el.textContent))
        .toEqual(whole.map(c => c.content));
    expect(within(threadCard('t1')).queryByTestId('comment-earlier')).not.toBeInTheDocument();
    expect(server.called('GET', `${BASE}/t1`).map(c => c.query)).toEqual([{}, { before: '5' }]);
});

// ── What the AI did about the reader's ask ───────────────────────────────────

/** Reply in t1 with Ask AI; the server answers the reply with `ai`. */
async function askAiInT1(ai: Record<string, unknown>, text = 'What does it cover?') {
    server.on('POST', `${BASE}/t1/replies`, ({ body }) => reply(201, {
        comment: comment('t1-c2', 2, { authorUserId: 'u-me', content: body.content }), ai, thread: { id: 't1', status: 'open' },
    }));
    const user = userEvent.setup();
    await screen.findByText('Is this right?');
    await user.click(within(threadCard('t1')).getByTestId('comment-reply-open'));
    await user.type(within(threadCard('t1')).getByRole('textbox', { name: 'Reply' }), text);
    await user.click(within(threadCard('t1')).getByRole('button', { name: 'Ask AI' }));
    await waitFor(() => expect(server.called('POST', `${BASE}/t1/replies`)).toHaveLength(1));
    return user;
}

it.each([
    [{ status: 'skipped', reason: 'limit' }, 'the AI usage limit has been reached'],
    [{ status: 'skipped', reason: 'unavailable' }, 'The AI is not available right now'],
    [{ status: 'skipped', reason: 'no_model' }, 'The AI is not available right now'],
    [{ status: 'busy' }, 'The AI is still answering in this thread'],
])('an Ask AI the AI will not answer (%o) says why under the thread', async (ai, expected) => {
    renderPanel();
    await askAiInT1(ai);
    const note = await within(threadCard('t1')).findByTestId('comment-ai-note');
    expect(note).toHaveTextContent(expected);
    expect(note).toHaveAttribute('role', 'status');
    expect(within(threadCard('t1')).queryByTestId('comment-ai-running')).not.toBeInTheDocument();
});

it('a reply that did not ask the AI says nothing about it, and clears an earlier note', async () => {
    renderPanel();
    const user = await askAiInT1({ status: 'skipped', reason: 'limit' });
    expect(await within(threadCard('t1')).findByTestId('comment-ai-note')).toBeInTheDocument();
    server.on('POST', `${BASE}/t1/replies`, ({ body }) => reply(201, {
        comment: comment('t1-c3', 3, { authorUserId: 'u-me', content: body.content }), ai: { status: 'skipped', reason: 'not_mentioned' }, thread: { id: 't1', status: 'open' },
    }));
    await user.click(within(threadCard('t1')).getByTestId('comment-reply-open'));
    await user.type(within(threadCard('t1')).getByRole('textbox', { name: 'Reply' }), 'Never mind');
    await user.click(within(threadCard('t1')).getByRole('button', { name: 'Reply' }));
    await waitFor(() => expect(within(threadCard('t1')).queryByTestId('comment-ai-note')).not.toBeInTheDocument());
});

it('a queued answer shows "AI is answering…" at once, and an answer that was blocked or failed says so', async () => {
    renderPanel();
    await askAiInT1({ status: 'queued' });
    // Before any live event: the reader's own post is enough.
    expect(await within(threadCard('t1')).findByTestId('comment-ai-running')).toHaveTextContent('AI is answering…');
    const payload = { threadId: 't1', targetType: 'notebook', targetId: 'nb1' };
    emit(stream, 'comment.ai.started', { transient: true, payload: { ...payload, status: 'running' } });
    emit(stream, 'comment.ai.finished', { transient: true, payload: { ...payload, status: 'blocked' } });
    expect(await within(threadCard('t1')).findByTestId('comment-ai-note')).toHaveTextContent('Privacy protection stopped the AI');
    expect(within(threadCard('t1')).queryByTestId('comment-ai-running')).not.toBeInTheDocument();
    emit(stream, 'comment.ai.started', { transient: true, payload: { ...payload, status: 'running' } });
    expect(within(threadCard('t1')).queryByTestId('comment-ai-note')).not.toBeInTheDocument();
    emit(stream, 'comment.ai.finished', { transient: true, payload: { ...payload, status: 'failed' } });
    expect(await within(threadCard('t1')).findByTestId('comment-ai-note')).toHaveTextContent('The AI could not answer. Try asking again.');
});

it('a new comment that asks the AI while it is busy says so on the new thread', async () => {
    server.on('POST', BASE, ({ body }) => reply(201, {
        thread: thread('t9', { anchor: body.anchor, comments: [comment('t9-c1', 1, { authorUserId: 'u-me', content: body.content })] }),
        ai: { status: 'busy' },
    }));
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText('Is this right?');
    await user.click(screen.getByTestId('comments-add'));
    await user.type(screen.getByRole('textbox', { name: 'New comment' }), 'Summarise this');
    await user.click(within(screen.getByTestId('comment-new-form')).getByRole('button', { name: 'Ask AI' }));
    expect(await within(await screen.findByTestId('comment-thread-t9')).findByTestId('comment-ai-note')).toHaveTextContent('still answering');
});

it('outside the workspace (no live feed) a queued answer shows at once and ends when the answer arrives', async () => {
    const client = testClient();
    render(
        <QueryClientProvider client={client}>
            <CommentsPanel projectId="p1" targetType="notebook" targetId="nb1" role="editor" currentUser={{ id: 'u-me', name: 'Tom Me' }} />
        </QueryClientProvider>,
    );
    await askAiInT1({ status: 'queued' });
    expect(await within(threadCard('t1')).findByTestId('comment-ai-running')).toBeInTheDocument();
    // The next poll brings the list with the AI's answer after the reply.
    threads = threads.map(t => (t.id === 't1' ? {
        ...t, comments: [...t.comments, comment('t1-c2', 2, { authorUserId: 'u-me' }), comment('t1-ai', 3, { authorKind: 'assistant', authorUserId: null, content: 'It covers travel.' })],
    } : t));
    await client.invalidateQueries();
    expect(await within(threadCard('t1')).findByText('It covers travel.')).toBeInTheDocument();
    expect(within(threadCard('t1')).queryByTestId('comment-ai-running')).not.toBeInTheDocument();
});
