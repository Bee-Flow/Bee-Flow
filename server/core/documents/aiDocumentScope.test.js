'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createDocumentScope, normaliseSidePanelDocument } = require('./aiDocumentScope');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const D = '44444444-4444-4444-8444-444444444444';
const E = '55555555-5555-4555-8555-555555555555';

test('nothing is in scope by default', () => {
    const s = createDocumentScope();
    assert.strictEqual(s.has(A), false);
    assert.deepStrictEqual(s.ids(), []);
});

test('the document open in the side panel is in scope, others are not', () => {
    const s = createDocumentScope({ sidePanelDocument: { id: A, name: 'Offerte' } });
    assert.ok(s.has(A));
    assert.ok(!s.has(B));
});

test('malformed sidePanelDocument contributes nothing', () => {
    for (const bad of [null, undefined, 'x', 5, [], {}, { id: 5 }, { id: '' }, { id: '   ' }, { id: 'x'.repeat(101) }, { id: { $ne: 1 } }]) {
        assert.deepStrictEqual(createDocumentScope({ sidePanelDocument: bad }).ids(), [], JSON.stringify(bad));
    }
});

test('normaliseSidePanelDocument keeps a single-line, capped name and drops a non-string one', () => {
    assert.deepStrictEqual(normaliseSidePanelDocument({ id: ' a ', name: 'A\nB' }), { id: 'a', name: 'A B' });
    assert.deepStrictEqual(normaliseSidePanelDocument({ id: 'a', name: 7 }), { id: 'a' });
    assert.strictEqual(normaliseSidePanelDocument({ id: 'a', name: 'n'.repeat(500) }).name.length, 200);
});

test('ids and links in the user own messages are explicit references', () => {
    const s = createDocumentScope({
        history: [
            { role: 'user', content: `kijk naar ${A}` },
            { role: 'user', content: [{ type: 'text', text: `https://bee.example/app/studio/documents/${B}?x=1` }] },
        ],
        message: `en ook /app/studio/documents/${C.toUpperCase()}`,
    });
    assert.ok(s.has(A) && s.has(B) && s.has(C));
    assert.ok(s.has(C.toUpperCase()), 'case-insensitive');
    assert.ok(!s.has(D));
});

test('an id mentioned only by the assistant (not as a created doc or link) is not in scope', () => {
    const s = createDocumentScope({ history: [{ role: 'assistant', content: `I also know of ${A}` }] });
    assert.ok(!s.has(A));
});

test('documents created in this conversation: create tool history counts, an assistant link does not', () => {
    const preview = JSON.stringify({ documentId: A, versionId: B, url: `/app/studio/documents/${A}`, name: 'X' }).slice(0, 200);
    const s = createDocumentScope({
        history: [
            { role: 'assistant', content: 'done', toolHistory: [
                { name: 'create_document', resultPreview: preview },
                { name: 'document_read', resultPreview: JSON.stringify({ documentId: D }) },
                { name: 'create_presentation', resultPreview: JSON.stringify({ ok: true, documentId: E }) },
            ] },
            { role: 'assistant', content: `Here: [Deck](/app/studio/documents/${C})` },
        ],
    });
    assert.ok(s.has(A), 'create_document result');
    assert.ok(s.has(E), 'create_presentation result');
    assert.ok(!s.has(C), 'a link the model wrote (prompt injection could plant one) grants nothing');
    assert.ok(!s.has(B), 'a versionId is not a document');
    assert.ok(!s.has(D), 'a read result does not grant scope');
});

test('add() grows the scope; junk ids are ignored', () => {
    const s = createDocumentScope();
    s.add(A); s.add(5); s.add(''); s.add('x'.repeat(101));
    assert.deepStrictEqual(s.ids(), [A]);
    assert.strictEqual(s.has(undefined), false);
    assert.strictEqual(s.has(5), false);
});

test('malformed history entries are skipped', () => {
    const s = createDocumentScope({ history: [null, 'x', { role: 'user' }, { role: 'assistant', toolHistory: 'nope' }, { role: 'user', content: { a: 1 } }], message: 5 });
    assert.deepStrictEqual(s.ids(), []);
});

test('createdInChat: only what the chat made, not what was merely opened or mentioned', () => {
    const s = createDocumentScope({
        sidePanelDocument: { id: C },
        message: `look at ${D}`,
        history: [{ role: 'assistant', content: 'done', toolHistory: [{ name: 'create_document', resultPreview: JSON.stringify({ documentId: A }) }] }],
    });
    assert.ok(s.createdInChat(A), 'create tool history');
    assert.ok(!s.createdInChat(C), 'opened in the side panel');
    assert.ok(!s.createdInChat(D), 'linked by the user');
    assert.ok(s.has(C) && s.has(D));
    s.markCreated(E);
    assert.ok(s.createdInChat(E.toUpperCase()), 'a create in this turn, case-insensitive');
    assert.ok(s.has(E), 'and it is in scope');
    s.add(B);
    assert.ok(!s.createdInChat(B), 'add() alone does not mark created');
    assert.strictEqual(s.createdInChat(5), false);
});
