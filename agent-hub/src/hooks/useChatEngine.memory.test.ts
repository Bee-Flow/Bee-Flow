import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import scopedStorage from '../utils/scopedStorage';
import useChatEngine, { type UseChatEngineOptions } from './useChatEngine';

/**
 * What the chat engine does about memory: the two request flags (read and
 * write) for each composer state, the stored legacy value, the `memory_used`
 * event, and when a finished turn is worth watching for "Remembered".
 */

function streamResponse(events: string[], date?: string) {
    const chunks = events.map((c) => new TextEncoder().encode(c));
    let i = 0;
    return {
        ok: true,
        status: 200,
        headers: new Headers(date ? { Date: date } : {}),
        body: {
            getReader: () => ({
                read: () => Promise.resolve(i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }),
                cancel: () => Promise.resolve(),
            }),
        },
    } as unknown as Response;
}

const MEMORY_USED = 'event: memory_used\ndata: {"items":[{"id":"m1","type":"fact","preview":"Lives in Utrecht"}]}\n\n';
const CONTENT = 'event: content\ndata: {"text":"Hi."}\n\n';
const DONE = 'event: done\ndata: {"conversationId":"c1"}\n\n';

let fetchSpy: MockInstance<typeof fetch>;

beforeEach(() => {
    localStorage.clear();
    scopedStorage.setCurrentUser('u1');
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => streamResponse([MEMORY_USED, CONTENT, DONE]));
});
afterEach(() => {
    fetchSpy.mockRestore();
    scopedStorage.setCurrentUser(null);
});

async function send(options: UseChatEngineOptions) {
    const { result } = renderHook(() => useChatEngine(options));
    await act(async () => { await result.current.sendMessage('Hello'); });
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const body = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body));
    return { body, result };
}

describe('memory flags in the request', () => {
    it('defaults to reading and saving, on both the agent and the direct path', async () => {
        const agent = await send({ selectedAgent: { id: 'a1' } });
        expect(agent.body).toMatchObject({ memoryReadEnabled: true, memoryWriteEnabled: true });
        fetchSpy.mockClear();
        const direct = await send({ directMode: { enabled: true } });
        expect(direct.body).toMatchObject({ memoryReadEnabled: true, memoryWriteEnabled: true });
    });

    it('Read only reads and does not save', async () => {
        scopedStorage.setItem('memoryMode', 'read');
        const { body } = await send({ selectedAgent: { id: 'a1' } });
        expect(body).toMatchObject({ memoryReadEnabled: true, memoryWriteEnabled: false });
    });

    it('Off for this chat neither reads nor saves', async () => {
        scopedStorage.setItem('memoryMode', 'off');
        const { body } = await send({ directMode: { enabled: true } });
        expect(body).toMatchObject({ memoryReadEnabled: false, memoryWriteEnabled: false });
    });

    it('the old stored boolean false still means Read only', async () => {
        scopedStorage.setItem('memoryWriteEnabled', 'false');
        const { body } = await send({ selectedAgent: { id: 'a1' } });
        expect(body).toMatchObject({ memoryReadEnabled: true, memoryWriteEnabled: false });
    });
});

describe('memory_used and the Remembered watch', () => {
    it('puts the memories the answer used on the assistant message', async () => {
        const { result } = await send({ selectedAgent: { id: 'a1' } });
        const assistant = result.current.messages.find((m) => m.role === 'assistant');
        expect(assistant?.memoryUsed).toEqual([{ id: 'm1', type: 'fact', preview: 'Lives in Utrecht' }]);
    });

    it('watches a finished turn that could have saved memories, only for the main chat', async () => {
        const watched = await send({ selectedAgent: { id: 'a1' }, getMemoryLock: () => null });
        const msg = watched.result.current.messages.find((m) => m.role === 'assistant');
        expect(msg?.memoryWatch).toMatchObject({ conversationId: 'c1' });
        expect(Date.parse(String(msg?.memoryWatch?.since))).not.toBeNaN();

        fetchSpy.mockClear();
        const other = await send({ selectedAgent: { id: 'a1' } });
        expect(other.result.current.messages.find((m) => m.role === 'assistant')?.memoryWatch).toBeUndefined();
    });

    it('does not watch when saving was off for the turn', async () => {
        scopedStorage.setItem('memoryMode', 'read');
        const { result } = await send({ selectedAgent: { id: 'a1' }, getMemoryLock: () => null });
        expect(result.current.messages.find((m) => m.role === 'assistant')?.memoryWatch).toBeUndefined();
    });

    it('does not watch when memory is paused or off for the organisation', async () => {
        for (const lock of ['user_paused', 'org_off'] as const) {
            fetchSpy.mockClear();
            const { result } = await send({ selectedAgent: { id: 'a1' }, getMemoryLock: () => lock });
            expect(result.current.messages.find((m) => m.role === 'assistant')?.memoryWatch).toBeUndefined();
        }
    });

    it('uses the server Date header to correct clock skew, with three seconds of slack', async () => {
        const serverNow = new Date(Date.now() + 3_600_000); // the server clock runs an hour ahead
        fetchSpy.mockImplementation(async () => streamResponse([CONTENT, DONE], serverNow.toUTCString()));
        const { result } = await send({ selectedAgent: { id: 'a1' }, getMemoryLock: () => null });
        const since = Date.parse(String(result.current.messages.find((m) => m.role === 'assistant')?.memoryWatch?.since));
        const expected = Math.floor(serverNow.getTime() / 1000) * 1000 - 3000;
        expect(Math.abs(since - expected)).toBeLessThanOrEqual(1000);
    });

    it('without a Date header it keeps the client clock minus three seconds', async () => {
        const before = Date.now();
        const { result } = await send({ selectedAgent: { id: 'a1' }, getMemoryLock: () => null });
        const since = Date.parse(String(result.current.messages.find((m) => m.role === 'assistant')?.memoryWatch?.since));
        expect(since).toBeGreaterThanOrEqual(before - 3000 - 50);
        expect(since).toBeLessThanOrEqual(Date.now() - 3000 + 50);
    });

    it('a second turn closes the first turn\'s watch window', async () => {
        const options = { selectedAgent: { id: 'a1' }, getMemoryLock: () => null } as UseChatEngineOptions;
        const { result } = renderHook(() => useChatEngine(options));
        await act(async () => { await result.current.sendMessage('One'); });
        const first = () => result.current.messages.find((m) => m.role === 'assistant')?.memoryWatch;
        expect(first()?.until).toBeUndefined();
        await act(async () => { await result.current.sendMessage('Two'); });
        const watches = result.current.messages.filter((m) => m.role === 'assistant').map((m) => m.memoryWatch);
        expect(watches).toHaveLength(2);
        expect(Date.parse(String(watches[0]?.until))).not.toBeNaN();
        expect(watches[1]?.until).toBeUndefined();
    });
});
