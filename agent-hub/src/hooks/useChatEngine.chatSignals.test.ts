import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import useChatEngine, { type UseChatEngineOptions } from './useChatEngine';

/**
 * What the chat engine SENDS for chat signals. The server counts a turn only
 * when it carries the marker of the notice the screen showed, so the marker
 * may ride along on exactly the endpoint the notice describes: the direct
 * stream and the agent stream, and only for a host that passes the getter.
 * The webpage builder, the meeting-notes sidebar and the templates page post
 * to the same engine and must send nothing.
 */

const VERSION = '2026-10-14T09:00:00.000Z';

function streamResponse() {
    const chunks = ['event: content\ndata: {"text":"Hi."}\n\n', 'event: done\ndata: {"conversationId":"c1"}\n\n']
        .map((c) => new TextEncoder().encode(c));
    let i = 0;
    return {
        ok: true,
        status: 200,
        body: {
            getReader: () => ({
                read: () => Promise.resolve(i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }),
                cancel: () => Promise.resolve(),
            }),
        },
    } as unknown as Response;
}

let fetchSpy: MockInstance<typeof fetch>;

beforeEach(() => {
    localStorage.clear();
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => streamResponse());
});
afterEach(() => { fetchSpy.mockRestore(); });

const getter = vi.fn((surface: 'direct' | 'agent') => ({ chatSignalsNotice: `${surface}@${VERSION}` }));

async function sendWith(options: UseChatEngineOptions) {
    getter.mockClear();
    const { result } = renderHook(() => useChatEngine(options));
    await act(async () => { await result.current.sendMessage('Hello'); });
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const [url, init] = fetchSpy.mock.calls[0];
    return { url: String(url), body: JSON.parse(String((init as RequestInit).body)) };
}

describe('useChatEngine: the chat-signals marker', () => {
    it('the direct stream carries the marker the getter gives for "direct"', async () => {
        const { url, body } = await sendWith({ directMode: { enabled: true }, getChatSignalsPayload: getter });
        expect(url.endsWith('/ai/chat/direct/stream')).toBe(true);
        expect(getter).toHaveBeenCalledWith('direct');
        expect(body.chatSignalsNotice).toBe(`direct@${VERSION}`);
        expect(body.message).toBe('Hello');
    });

    it('a custom endpoint (the webpage panel) is never asked and carries no marker', async () => {
        const { url, body } = await sendWith({
            directMode: { enabled: true, customEndpoint: '/ai/chat/webpage/stream' },
            getChatSignalsPayload: getter,
        });
        expect(url.endsWith('/ai/chat/webpage/stream')).toBe(true);
        expect(getter).not.toHaveBeenCalled();
        expect(body).not.toHaveProperty('chatSignalsNotice');
    });

    it('a host without the getter (meeting-notes sidebar, templates) sends no marker', async () => {
        const { url, body } = await sendWith({ directMode: { enabled: true } });
        expect(url.endsWith('/ai/chat/direct/stream')).toBe(true);
        expect(body).not.toHaveProperty('chatSignalsNotice');
        expect(body).not.toHaveProperty('chatSignalsOptOut');
    });

    it('the agent stream carries the agent marker', async () => {
        const { url, body } = await sendWith({ selectedAgent: { id: 'a1', name: 'Agent' }, getChatSignalsPayload: getter });
        expect(url.endsWith('/agents/a1/chat/stream')).toBe(true);
        expect(getter).toHaveBeenCalledWith('agent');
        expect(body.chatSignalsNotice).toBe(`agent@${VERSION}`);
    });

    it('a test chat is never counted, so it carries no marker', async () => {
        const { body } = await sendWith({
            selectedAgent: { id: 'a1', name: 'Agent' },
            testChat: { enabled: true },
            getChatSignalsPayload: getter,
        });
        expect(body.test).toBe(true);
        expect(getter).not.toHaveBeenCalled();
        expect(body).not.toHaveProperty('chatSignalsNotice');
    });

    it('a getter that answers null adds nothing', async () => {
        const { body } = await sendWith({ directMode: { enabled: true }, getChatSignalsPayload: () => null });
        expect(body).not.toHaveProperty('chatSignalsNotice');
    });
});
