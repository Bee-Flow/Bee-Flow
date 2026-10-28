/**
 * The order of a chat on screen never comes from a clock.
 *
 * The user's message is stamped with the browser's clock, the saved rows with
 * the server's; the two can be seconds or minutes apart, and two saved rows
 * can carry the same timestamp. The list is the order the turn was opened in
 * (live) or the order the server stores (`seq`, see
 * server/stores/agent/conversationMessages.js READ_ORDER) and nothing else:
 * these pin that, so a later "sort by timestamp" cannot slip in.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SetStateAction } from 'react';
import { openTurn } from './turnStart';
import { recoverPersistedReply, RECOVERY_DELAYS_MS, type TurnEndDeps } from './turnEnd';
import type { ChatMessage } from './types';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function list(initial: ChatMessage[]) {
    const state = { messages: initial };
    const setMessages = (u: SetStateAction<ChatMessage[]>) => { state.messages = typeof u === 'function' ? u(state.messages) : u; };
    return { state, setMessages };
}

const saved: ChatMessage[] = [
    { id: 's1', role: 'user', content: 'first question', timestamp: '2026-10-28T10:00:00.000Z' },
    { id: 's2', role: 'assistant', content: 'first answer', timestamp: '2026-10-28T10:00:04.000Z' },
];

describe('a new turn on a browser whose clock is off', () => {
    it.each([
        ['ten minutes behind the server', '2026-10-28T09:50:00.000Z'],
        ['an hour ahead of the server', '2026-10-28T11:00:00.000Z'],
        ['on the very same millisecond as the last answer', '2026-10-28T10:00:04.000Z'],
    ])('puts the question and its placeholder below the last answer when %s', (_label, now) => {
        vi.useFakeTimers({ now: new Date(now) });
        const { state, setMessages } = list(saved);
        openTurn({
            text: 'second question', attachments: [], isHidden: false, isDirectMode: true,
            conversationId: 'c1', serverSkewMs: 0, setMessages,
        });
        expect(state.messages.map(m => m.content)).toEqual(['first question', 'first answer', 'second question', '']);
        expect(state.messages[3]).toMatchObject({ role: 'assistant', isStreaming: true });
    });
});

describe('the saved conversation swapped in after a dropped stream', () => {
    it('keeps the server order even when its timestamps are equal or run backwards', async () => {
        vi.useFakeTimers();
        const interrupted: ChatMessage = { id: 'a-live', role: 'assistant', content: 'half', isInterrupted: true };
        const { state, setMessages } = list([...saved, { id: 'u-live', role: 'user', content: 'second question', timestamp: '2026-10-28T09:50:00.000Z' }, interrupted]);
        // As stored: seq order. The question carries the browser's (slow) clock,
        // the answer the server's, and two rows share one timestamp.
        const reloaded: ChatMessage[] = [
            ...saved,
            { id: 's3', role: 'user', content: 'second question', timestamp: '2026-10-28T10:00:04.000Z' },
            { id: 's4', role: 'assistant', content: 'second answer', timestamp: '2026-10-28T10:00:04.000Z' },
            { id: 's5', role: 'user', content: 'third question', timestamp: '2026-10-28T09:59:00.000Z' },
            { id: 's6', role: 'assistant', content: 'third answer', timestamp: '2026-10-28T09:59:30.000Z' },
        ];
        const deps: Pick<TurnEndDeps, 'setMessages' | 'messages'> = { setMessages, messages: () => state.messages };
        const done = recoverPersistedReply('a-live', async () => reloaded, deps);
        await vi.advanceTimersByTimeAsync(RECOVERY_DELAYS_MS[0]);
        await done;
        expect(state.messages.map(m => m.id)).toEqual(['s1', 's2', 's3', 's4', 's5', 's6']);
    });
});
