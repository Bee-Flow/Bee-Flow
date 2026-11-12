import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import scopedStorage from '../utils/scopedStorage';
import useChatEngine, { type UseChatEngineOptions } from './useChatEngine';

/**
 * Incognito in the chat engine: what goes on the wire for both chats, and
 * that no conversation id the server might still send reaches the page (the
 * created callbacks are what change the URL and reload the lists), nor
 * starts the memory watch or the recovery poll.
 */

const sse = (events: string[]) => new Response(new ReadableStream<Uint8Array>({
    start(c) { events.forEach(e => c.enqueue(new TextEncoder().encode(e))); c.close(); },
}));

// A server that did not get the memo: it still reports a conversation.
const LEAKY_STREAM = [
    'event: conversation_created\ndata: {"conversationId":"c-leak"}\n\n',
    'event: title\ndata: {"conversationId":"c-leak","title":"Leaked"}\n\n',
    'event: content\ndata: {"text":"Hi."}\n\n',
    'event: done\ndata: {"conversationId":"c-leak"}\n\n',
];

const SESSION = { sessionId: '0f8e7d6c-5b4a-4321-8fed-cba987654321' };

let fetchSpy: MockInstance<typeof fetch>;

beforeEach(() => {
    localStorage.clear();
    scopedStorage.setCurrentUser('u1');
    // The stored mode says "on": incognito must override it.
    scopedStorage.setItem('memoryMode', 'on');
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => sse(LEAKY_STREAM));
});
afterEach(() => {
    fetchSpy.mockRestore();
    scopedStorage.setCurrentUser(null);
});

const bodyOf = (call: number) => JSON.parse(String((fetchSpy.mock.calls[call][1] as RequestInit).body));

async function twoTurns(options: UseChatEngineOptions) {
    const { result } = renderHook(() => useChatEngine(options));
    await act(async () => { await result.current.sendMessage('First'); });
    await act(async () => { await result.current.sendMessage('Second'); });
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    return result;
}

describe('useChatEngine in incognito', () => {
    it('direct: incognito body, whole history every turn, and no created callback', async () => {
        const onConversationCreated = vi.fn();
        const onDirectConversationCreated = vi.fn();
        const result = await twoTurns({
            directMode: { enabled: true },
            incognito: SESSION,
            onConversationCreated,
            onDirectConversationCreated,
            getMemoryLock: () => null,
        });
        const second = bodyOf(1);
        expect(second).not.toHaveProperty('conversationId');
        expect(second).toMatchObject({ incognito: true, memoryReadEnabled: false, memoryWriteEnabled: false });
        expect(second.history).toEqual([{ role: 'user', content: 'First' }, { role: 'assistant', content: 'Hi.' }]);
        expect(onConversationCreated).not.toHaveBeenCalled();
        expect(onDirectConversationCreated).not.toHaveBeenCalled();
        // No "Remembered" watch: nothing was written.
        expect(result.current.messages.some(m => m.memoryWatch)).toBe(false);
    });

    it('agent: one session id across the turns, sent as testSessionId, never as a test chat', async () => {
        const onConversationCreated = vi.fn();
        await twoTurns({
            selectedAgent: { id: 'a1' },
            currentConversation: { id: null },
            incognito: SESSION,
            testChat: { enabled: true },
            onConversationCreated,
        });
        expect(bodyOf(0).testSessionId).toBe(SESSION.sessionId);
        expect(bodyOf(1).testSessionId).toBe(SESSION.sessionId);
        expect(bodyOf(1)).not.toHaveProperty('test');
        expect(bodyOf(1)).not.toHaveProperty('conversationId');
        expect(bodyOf(1).history).toHaveLength(2);
        expect(onConversationCreated).not.toHaveBeenCalled();
    });

    it('a normal chat on the same stream does report the conversation', async () => {
        const onConversationCreated = vi.fn();
        const { result } = renderHook(() => useChatEngine({ selectedAgent: { id: 'a1' }, onConversationCreated }));
        await act(async () => { await result.current.sendMessage('Hello'); });
        expect(onConversationCreated).toHaveBeenCalledWith('c-leak');
    });

    it('says plainly why the server refused an incognito turn', async () => {
        fetchSpy.mockImplementation(async () => ({
            ok: false,
            status: 400,
            headers: new Headers(),
            json: async () => ({ error: 'Files cannot be added to an incognito chat: they would be stored.', code: 'incognito_no_attachments' }),
        } as unknown as Response));
        const { result } = renderHook(() => useChatEngine({ directMode: { enabled: true }, incognito: SESSION }));
        await act(async () => { await result.current.sendMessage('Hello'); });
        const reply = result.current.messages.find(m => m.role === 'assistant');
        expect(reply).toMatchObject({ isError: true, content: 'An incognito chat cannot take attachments. Remove the file, or start a normal chat.' });
    });
});
