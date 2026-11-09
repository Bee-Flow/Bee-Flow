import { describe, expect, it } from 'vitest';

import { dispatchSSEEvent } from '../dispatch';
import type { ChatMessage, SseDispatchContext, SseDispatchIds, SseEventData } from '../../types';

/**
 * The server runs the calls of one round in parallel, so the same tool can be
 * running twice. Each call gets its own `tool_end`; the first one used to close
 * every running row of that name, with the first call's result on both.
 */
const ID = 'assistant-1';

function harness() {
    let messages: ChatMessage[] = [{ id: ID, role: 'assistant', content: '', isStreaming: true }];
    const setMessages = (fn: unknown) => {
        messages = (fn as (prev: ChatMessage[]) => ChatMessage[])(messages);
    };
    const ctx = { setMessages, onGammaPreviewRef: { current: undefined } } as unknown as SseDispatchContext;
    const ids = { assistantMsgId: ID, userMsgId: 'user-1', activeIdRef: { current: ID } } as unknown as SseDispatchIds;
    return {
        send: (event: string, data: SseEventData) => dispatchSSEEvent(ctx, event, data, ids),
        get history() { return messages[0].toolHistory || []; },
    };
}

describe('tool_end with the same tool running twice', () => {
    it('closes one row per event and keeps each result on its own row', () => {
        const h = harness();
        h.send('tool_start', { name: 'serper_search', args: { q: 'first' } });
        h.send('tool_start', { name: 'serper_search', args: { q: 'second' } });

        h.send('tool_end', { name: 'serper_search', result: 'result one' });
        expect(h.history.map(t => t.status)).toEqual(['done', 'running']);
        expect(h.history[0].resultPreview).toBe('result one');
        expect(h.history[1].resultPreview).toBeUndefined();

        h.send('tool_end', { name: 'serper_search', result: 'result two' });
        expect(h.history.map(t => t.status)).toEqual(['done', 'done']);
        expect(h.history.map(t => t.resultPreview)).toEqual(['result one', 'result two']);
    });
});
