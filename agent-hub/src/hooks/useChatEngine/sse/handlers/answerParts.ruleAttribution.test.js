import { describe, it, expect } from 'vitest';

import { dispatchSSEEvent } from '../dispatch';

/**
 * The `rule_attribution` event of a test chat.
 *
 * One rule applies here: an empty or unreadable payload may NOT erase an earlier
 * judgement. An empty chip row where a chip stood just before reads as "no rule was
 * followed", and that is exactly the claim the attribution pass may not make. It may
 * only stay silent.
 */

const ID = 'assistant-1';

/** A minimal dispatch environment: only what this event touches. */
function harness(initial = {}) {
    let messages = [{ id: ID, role: 'assistant', content: 'Dat zeg ik niet.', ...initial }];
    const ctx = { setMessages: (fn) => { messages = fn(messages); } };
    const ids = { assistantMsgId: ID, activeIdRef: { current: ID }, contentRef: { current: '' }, flusher: {}, workRef: {} };
    return {
        send: (data) => dispatchSSEEvent(ctx, 'rule_attribution', data, ids),
        get msg() { return messages[0]; },
    };
}

describe('rule_attribution', () => {
    it('zet de regels die de pass aanwees op het bericht', () => {
        const h = harness();
        h.send({ rules: [{ rule: 'Nooit een prijs noemen' }] });
        expect(h.msg.ruleAttribution).toEqual({ rules: [{ rule: 'Nooit een prijs noemen' }] });
    });

    it('BIJT — een leeg of onleesbaar payload wist een eerder oordeel niet', () => {
        for (const data of [{ rules: [] }, {}, { rules: null }, { rules: 'geen' }, null]) {
            const h = harness({ ruleAttribution: { rules: [{ rule: 'Nooit een prijs noemen' }] } });
            h.send(data);
            expect(h.msg.ruleAttribution).toEqual({ rules: [{ rule: 'Nooit een prijs noemen' }] });
        }
    });

    it('laat een beurt zonder event ongemoeid', () => {
        const h = harness();
        h.send({ rules: [] });
        expect(h.msg.ruleAttribution).toBeUndefined();
    });

    it('raakt geen ander bericht aan', () => {
        let messages = [{ id: 'other', role: 'assistant' }, { id: ID, role: 'assistant' }];
        const ctx = { setMessages: (fn) => { messages = fn(messages); } };
        const ids = { assistantMsgId: ID, activeIdRef: { current: ID }, contentRef: { current: '' }, flusher: {}, workRef: {} };
        dispatchSSEEvent(ctx, 'rule_attribution', { rules: [{ rule: 'r' }] }, ids);
        expect(messages[0].ruleAttribution).toBeUndefined();
        expect(messages[1].ruleAttribution).toEqual({ rules: [{ rule: 'r' }] });
    });
});
