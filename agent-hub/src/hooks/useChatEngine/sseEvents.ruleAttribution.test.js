import { describe, it, expect } from 'vitest';

import { dispatchSSEEvent } from './sseEvents';

/**
 * Het `rule_attribution`-event van een testchat.
 *
 * Eén regel telt hier: een leeg of onleesbaar payload mag een eerder oordeel
 * NIET wissen. Een lege chiprij waar net nog een chip stond leest als "er is
 * niets gevolgd", en dat is precies de bewering die de attributie-pass niet
 * mag doen — hij mag alleen zwijgen.
 */

const ID = 'assistant-1';

/** Een minimale dispatch-omgeving: alleen wat dit event aanraakt. */
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
