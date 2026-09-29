import { describe, it, expect } from 'vitest';

import { dispatchSSEEvent } from './sseEvents';

/**
 * De twee events van de testchat (A4 deel A) op de chatkant.
 *
 *   `tool_confirm`  een call die de agent NIET heeft gedraaid omdat er een
 *                   mens ja moet zeggen. Dit event bestond al maanden zonder
 *                   client — het werd alleen gepersisteerd en door niemand
 *                   gelezen.
 *   `test_chat`     welke config deze beurt draaide: het concept of de
 *                   gepubliceerde blob.
 *
 * Wat hier getest wordt is niet "komt het aan" maar de twee manieren waarop
 * het stil fout gaat: op de VERKEERDE SLEUTEL bijhouden (dan krijgt één actie
 * twee kaarten, of erger: twee acties één kaart), en de bewering over de
 * versie uit het VERZOEK afleiden in plaats van uit het antwoord.
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
        // `callId` is elke ronde nieuw. Wie daarop bijhoudt krijgt twee kaarten
        // voor één ding, en de tweede klik keurt dan een actie goed die de
        // eerste al afhandelde.
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
        // Zonder argsKey valt er niets over te beslissen: een kaart met twee
        // knoppen die naar niets verwijzen is erger dan geen kaart.
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
        // De client mag "je concept" niet uit zijn eigen verzoek afleiden.
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
