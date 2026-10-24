import { describe, it, expect } from 'vitest';

import { dispatchSSEEvent } from '../dispatch';

/**
 * The two events of the test chat (A4 part A) on the chat side.
 *
 *   `tool_confirm`  a call that the agent did NOT run because a human has to say yes.
 *                   This event existed for months without a client. It was only
 *                   persisted and read by nobody.
 *   `test_chat`     which config ran this turn: the draft or the published blob.
 *
 * What is tested here is not "does it arrive" but the two ways in which it goes
 * silently wrong: by keeping track on the WRONG KEY (then one action gets two cards,
 * or worse, two actions share one card), and by deriving the claim about the version
 * from the REQUEST instead of from the answer.
 */

const ID = 'assistant-1';

function harness(event, initial = {}) {
    let messages = [{ id: ID, role: 'assistant', content: '', ...initial }];
    const ctx = { setMessages: (fn) => { messages = fn(messages); } };
    const ids = { assistantMsgId: ID, activeIdRef: { current: ID }, contentRef: { current: '' }, flusher: {}, workRef: {} };
    return {
        send: (data) => dispatchSSEEvent(ctx, event, data, ids),
        get msg() { return messages[0]; },
    };
}

const card = (over = {}) => ({
    callId: 'call_1', toolName: 'gmail_compose', effect: 'sends',
    preview: { to: 'x@example.com' }, argsKey: 'a'.repeat(32), status: 'pending', ...over,
});

describe('tool_confirm', () => {
    it('legt de vastgehouden call op het bericht', () => {
        const h = harness('tool_confirm');
        h.send(card());
        expect(h.msg.pendingToolCalls).toHaveLength(1);
        expect(h.msg.pendingToolCalls[0]).toMatchObject({
            toolName: 'gmail_compose', effect: 'sends', status: 'pending',
        });
    });

    it('BIJT — dezelfde ACTIE in een nieuwe ronde is één kaart, geen tweede', () => {
        // `callId` is new every round. Whoever keeps track on that gets two cards for one
        // thing, and the second click then approves an action that the first already
        // handled.
        const h = harness('tool_confirm');
        h.send(card({ callId: 'call_1' }));
        h.send(card({ callId: 'call_2', status: 'approved' }));
        expect(h.msg.pendingToolCalls).toHaveLength(1);
        expect(h.msg.pendingToolCalls[0].status).toBe('approved');
        expect(h.msg.pendingToolCalls[0].callId).toBe('call_2');
    });

    it('BIJT — twee verschillende acties krijgen elk hun eigen kaart', () => {
        const h = harness('tool_confirm');
        h.send(card({ argsKey: 'a'.repeat(32) }));
        h.send(card({ argsKey: 'b'.repeat(32), preview: { to: 'other@example.com' } }));
        expect(h.msg.pendingToolCalls).toHaveLength(2);
        expect(h.msg.pendingToolCalls.map(c => c.preview.to))
            .toEqual(['x@example.com', 'other@example.com']);
    });

    it('een payload zonder sleutel wordt niet als kaart aangenomen', () => {
        // Without argsKey there is nothing to decide. A card with two buttons that point to
        // nothing is worse than no card.
        const h = harness('tool_confirm');
        for (const data of [null, {}, { toolName: 'gmail_compose' }, { argsKey: '' }]) h.send(data);
        expect(h.msg.pendingToolCalls).toBeUndefined();
    });

    it('raakt geen ander bericht aan', () => {
        let messages = [{ id: 'other', role: 'assistant' }, { id: ID, role: 'assistant' }];
        const ctx = { setMessages: (fn) => { messages = fn(messages); } };
        const ids = { assistantMsgId: ID, activeIdRef: { current: ID }, contentRef: { current: '' }, flusher: {}, workRef: {} };
        dispatchSSEEvent(ctx, 'tool_confirm', card(), ids);
        expect(messages[0].pendingToolCalls).toBeUndefined();
        expect(messages[1].pendingToolCalls).toHaveLength(1);
    });
});

describe('test_chat', () => {
    it('bewaart wat de server over de gedraaide config zei', () => {
        const h = harness('test_chat');
        h.send({ active: true, source: 'draft', runsDraft: true, publishedVersion: 3, unpublishedChanges: 5 });
        expect(h.msg.testChat).toEqual({
            active: true, source: 'draft', runsDraft: true, publishedVersion: 3, unpublishedChanges: 5,
        });
    });

    it('BIJT — een bron die de server niet kon vaststellen wordt niet opgepoetst', () => {
        // The client may not derive "your draft" from its own request.
        const h = harness('test_chat');
        h.send({ active: true, source: 'unknown', runsDraft: false });
        expect(h.msg.testChat.source).toBe('unknown');
        expect(h.msg.testChat.runsDraft).toBe(false);
    });

    it('een gewone beurt krijgt niets', () => {
        const h = harness('test_chat');
        expect(h.msg.testChat).toBeUndefined();
    });
});
