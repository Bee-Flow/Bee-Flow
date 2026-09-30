import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installServer, message, reply, teamChat, type TestServer } from '../../components/projects/workspace/chat/teamChatTestKit';
import { queryWrapper, testQueryClient } from '../../test/queryWrapper';
import {
    discardPendingMessage, foldIn, mergeMessages, refreshTeamChatMessage, teamChatKeys, useCreateProjectChat,
    useLoadOlderMessages, useSendTeamChatMessage, useTeamChatAgents, useTeamChatMessages, useUpdateProjectChat,
    type TeamChat, type TeamChatMessage, type TeamChatMessages,
} from './projectChats';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('../../utils/helpers', () => ({ API_BASE: '', authFetch: fetchMock }));

const CHAT = '/api/projects/p1/chats/c1';
const msg = (seq: number, over: Record<string, unknown> = {}) => message(seq, over) as unknown as TeamChatMessage;
let server: TestServer;

beforeEach(() => {
    fetchMock.mockReset();
    server = installServer(fetchMock);
});

describe('the message cache helpers', () => {
    it('merge by id and keep seq order', () => {
        const merged = mergeMessages([msg(1), msg(3)], [msg(2), msg(3, { content: 'edited' })]);
        expect(merged.map(m => m.seq)).toEqual([1, 2, 3]);
        expect(merged[2].content).toBe('edited');
    });

    it('confirm a pending message the server echoes back, and keep hasOlder unless told', () => {
        const held: TeamChatMessages = {
            messages: [msg(1)], hasOlder: true,
            pending: [{ clientMsgId: 'x', content: 'hi', mentions: [], replyTo: null, askAi: false, authorUserId: 'u', createdAt: '', status: 'sending' }],
        };
        const next = foldIn(held, [msg(2, { clientMsgId: 'x' })]);
        expect(next.pending).toEqual([]);
        expect(next.hasOlder).toBe(true);
        expect(foldIn(held, [], false).hasOlder).toBe(false);
    });
});

describe('reading messages', () => {
    it('loads the newest page first, then only what came after the newest message held', async () => {
        server.on('GET', `${CHAT}/messages`, ({ query }) => (query.after
            ? { messages: [msg(3)], hasMore: false }
            : { messages: [msg(1), msg(2)], hasMore: true }));
        const client = testQueryClient();
        const { result } = renderHook(() => useTeamChatMessages('p1', 'c1'), { wrapper: queryWrapper(client) });
        await waitFor(() => expect(result.current.data?.messages).toHaveLength(2));
        expect(result.current.data?.hasOlder).toBe(true);
        expect(server.calls[0].query).toEqual({ limit: '50' });

        await act(() => client.invalidateQueries({ queryKey: teamChatKeys.messages('p1', 'c1') }));
        await waitFor(() => expect(result.current.data?.messages.map(m => m.seq)).toEqual([1, 2, 3]));
        expect(server.calls[1].query).toEqual({ after: '2', limit: '200' });
        expect(result.current.data?.hasOlder).toBe(true);
    });

    it('pages back from the oldest message held', async () => {
        server.on('GET', `${CHAT}/messages`, ({ query }) => (query.before
            ? { messages: [msg(8), msg(9)], hasMore: false }
            : { messages: [msg(10), msg(11)], hasMore: true }));
        const client = testQueryClient();
        const { result } = renderHook(() => ({ list: useTeamChatMessages('p1', 'c1'), older: useLoadOlderMessages('p1', 'c1') }),
            { wrapper: queryWrapper(client) });
        await waitFor(() => expect(result.current.list.data?.messages).toHaveLength(2));
        await act(() => result.current.older.mutateAsync());
        expect(server.called('GET', `${CHAT}/messages`)[1].query).toEqual({ before: '10', limit: '50' });
        await waitFor(() => expect(result.current.list.data?.messages.map(m => m.seq)).toEqual([8, 9, 10, 11]));
        expect(result.current.list.data?.hasOlder).toBe(false);
    });

    it('re-reads exactly one edited message by its seq', async () => {
        server.on('GET', `${CHAT}/messages`, ({ query }) => (query.after === '4'
            ? { messages: [msg(5, { content: 'fixed typo', editedAt: '2026-09-29T10:00:00Z' })], hasMore: true }
            : { messages: [], hasMore: false }));
        const client = testQueryClient();
        client.setQueryData(teamChatKeys.messages('p1', 'c1'), foldIn(undefined, [msg(4), msg(5)], false));
        await refreshTeamChatMessage(client, 'p1', 'c1', 5);
        expect(server.calls[0].query).toEqual({ after: '4', limit: '1' });
        const data = client.getQueryData<TeamChatMessages>(teamChatKeys.messages('p1', 'c1'));
        expect(data?.messages.map(m => m.content)).toEqual(['Message 4', 'fixed typo']);
    });
});

describe('sending', () => {
    const vars = { clientMsgId: 'cm-1', content: 'Hello', mentions: ['u-ada'], replyTo: null, askAi: false };

    it('shows the message as pending at once and swaps in the stored one', async () => {
        let release: (v: unknown) => void = () => {};
        server.on('POST', `${CHAT}/messages`, () => new Promise((r) => { release = r; }));
        const client = testQueryClient();
        const key = teamChatKeys.messages('p1', 'c1');
        client.setQueryData(key, foldIn(undefined, [msg(1)], false));
        const { result } = renderHook(() => useSendTeamChatMessage('p1', 'c1', 'u-me'), { wrapper: queryWrapper(client) });

        act(() => { result.current.mutate(vars); });
        await waitFor(() => expect(client.getQueryData<TeamChatMessages>(key)?.pending).toHaveLength(1));
        expect(client.getQueryData<TeamChatMessages>(key)?.pending[0]).toMatchObject({ content: 'Hello', status: 'sending', authorUserId: 'u-me' });
        expect(server.calls[0].body).toEqual(vars);

        release({ message: msg(2, { content: 'Hello' }), ai: { status: 'queued' } });
        await waitFor(() => expect(result.current.data?.ai.status).toBe('queued'));
        const data = client.getQueryData<TeamChatMessages>(key);
        expect(data?.pending).toEqual([]);
        expect(data?.messages.map(m => m.id)).toEqual(['m1', 'm2']);
    });

    it('keeps a refused message as failed with the reason, and it can be thrown away', async () => {
        server.on('POST', `${CHAT}/messages`, reply(403, { error: 'You have view-only access to this project.' }));
        const client = testQueryClient();
        const key = teamChatKeys.messages('p1', 'c1');
        const { result } = renderHook(() => useSendTeamChatMessage('p1', 'c1', 'u-me'), { wrapper: queryWrapper(client) });
        await act(async () => { await result.current.mutateAsync(vars).catch(() => {}); });
        expect(client.getQueryData<TeamChatMessages>(key)?.pending[0]).toMatchObject({
            status: 'failed', error: 'You have view-only access to this project.',
        });
        discardPendingMessage(client, 'p1', 'c1', 'cm-1');
        expect(client.getQueryData<TeamChatMessages>(key)?.pending).toEqual([]);
    });

    it('a sync that lands while a message is on its way keeps the pending message', async () => {
        let release: (v: unknown) => void = () => {};
        server.on('POST', `${CHAT}/messages`, () => new Promise((r) => { release = r; }))
            .on('GET', `${CHAT}/messages`, { messages: [msg(1)], hasMore: false });
        const client = testQueryClient();
        const key = teamChatKeys.messages('p1', 'c1');
        const { result } = renderHook(() => ({ list: useTeamChatMessages('p1', 'c1'), send: useSendTeamChatMessage('p1', 'c1', 'u-me') }),
            { wrapper: queryWrapper(client) });
        await waitFor(() => expect(result.current.list.data?.messages).toHaveLength(1));
        act(() => { result.current.send.mutate(vars); });
        await act(() => client.invalidateQueries({ queryKey: key }));
        expect(client.getQueryData<TeamChatMessages>(key)?.pending).toHaveLength(1);
        release({ message: msg(2), ai: { status: 'skipped' } });
        await waitFor(() => expect(client.getQueryData<TeamChatMessages>(key)?.pending).toHaveLength(0));
    });
});

describe('chats', () => {
    it('a refused change is taken back', async () => {
        server.on('PATCH', CHAT, reply(403, { error: 'Only editors can change this chat.' }));
        const client = testQueryClient();
        const key = teamChatKeys.detail('p1', 'c1');
        client.setQueryData(key, teamChat() as unknown as TeamChat);
        const { result } = renderHook(() => useUpdateProjectChat('p1', 'c1'), { wrapper: queryWrapper(client) });
        await act(async () => { await result.current.mutateAsync({ aiMode: 'off' }).catch(() => {}); });
        expect(client.getQueryData<TeamChat>(key)?.aiMode).toBe('mention');
        await waitFor(() => expect(result.current.error?.message).toBe('Only editors can change this chat.'));
    });

    it('creating a chat seeds its header and first message', async () => {
        server.on('POST', '/api/projects/p1/chats', {
            chat: teamChat({ id: 'c7', title: 'Plan' }), message: msg(1, { content: 'Plan' }), ai: { status: 'skipped' },
        });
        const client = testQueryClient();
        const { result } = renderHook(() => useCreateProjectChat('p1'), { wrapper: queryWrapper(client) });
        await act(() => result.current.mutateAsync({ aiMode: 'mention', message: '  Plan  ', title: '' }));
        expect(server.calls[0].body).toEqual({ aiMode: 'mention', message: 'Plan' });
        expect(client.getQueryData<TeamChat>(teamChatKeys.detail('p1', 'c7'))?.title).toBe('Plan');
        expect(client.getQueryData<TeamChatMessages>(teamChatKeys.messages('p1', 'c7'))?.messages).toHaveLength(1);
    });
});

describe('the agents a team chat can use', () => {
    it('asks the route the server has (/chat-agents), not a made-up one', async () => {
        server.on('GET', '/api/projects/p1/chat-agents', () => ({ agents: [{ id: 'a1', name: 'Helper' }] }));
        const { result } = renderHook(() => useTeamChatAgents('p1', true), { wrapper: queryWrapper(testQueryClient()) });
        await waitFor(() => expect(result.current.data).toEqual([{ id: 'a1', name: 'Helper' }]));
    });
});
