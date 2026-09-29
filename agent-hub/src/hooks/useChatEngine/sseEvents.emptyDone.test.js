import { describe, it, expect } from 'vitest';

import { dispatchSSEEvent } from './sseEvents';

/**
 * A well-formed 'done' can still carry an empty reply (a provider failure
 * swallowed upstream, e.g. a reasoning model whose budget went entirely to
 * thinking). A blank bubble reads as "the conversation just stopped" — the
 * handler annotates it instead. Replies that produced work cards without
 * prose are legitimate and stay untouched.
 */

const ID = 'assistant-1';

function harness(initial = {}) {
    let messages = [{ id: ID, role: 'assistant', content: '', ...initial }];
    const ctx = { setMessages: (fn) => { messages = fn(messages); } };
    const ids = {
        assistantMsgId: ID,
        activeIdRef: { current: ID },
        contentRef: { current: '' },
        flusher: { flushNow: () => {} },
        workRef: { current: null },
    };
    return {
        send: (data = {}) => dispatchSSEEvent(ctx, 'done', data, ids),
        get msg() { return messages[0]; },
    };
}

describe('done with an empty reply', () => {
    it('annotates a blank bubble instead of leaving it empty', () => {
        const h = harness();
        h.send();
        expect(h.msg.isStreaming).toBe(false);
        expect(h.msg.content).toMatch(/empty response/i);
    });

    it('leaves a real answer untouched', () => {
        const h = harness({ content: 'Here is your answer.' });
        h.send();
        expect(h.msg.content).toBe('Here is your answer.');
    });

    it('leaves a cards-only reply untouched (work item present)', () => {
        const h = harness({ content: '', workItem: { tools: ['gmail_compose'] } });
        h.send();
        expect(h.msg.content).toBe('');
    });
});
