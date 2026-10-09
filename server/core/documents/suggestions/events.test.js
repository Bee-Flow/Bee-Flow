'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { announceSuggestions } = require('./events');
const { engine, _setEngine } = require('./engine');

function bus() {
    const sent = [];
    return { sent, publishChannel: async (c, e) => { sent.push(['channel', c, e]); }, publishTransient: async (c, e) => { sent.push(['project', c, e]); } };
}

test('a page outside a project announces on its own channel only, ids and counts only', async () => {
    const b = bus();
    await announceSuggestions({ documentId: 'd1', batchId: 'b1', open: 2 }, { bus: b });
    assert.deepStrictEqual(b.sent, [['channel', 'doc:d1', { kind: 'doc.suggestions', transient: true, targetType: 'document', targetId: 'd1', payload: { documentId: 'd1', batchId: 'b1', open: 2 } }]]);
});

test('a project page also announces on the project bus with the same event', async () => {
    const b = bus();
    await announceSuggestions({ documentId: 'd1', projectId: 'p1', batchId: 'b1', open: 0 }, { bus: b });
    assert.deepStrictEqual(b.sent.map((s) => s.slice(0, 2)), [['channel', 'doc:d1'], ['project', 'p1']]);
    assert.strictEqual(b.sent[0][2], b.sent[1][2]);
});

test('a bus failure never fails the caller', async () => {
    await announceSuggestions({ documentId: 'd1', open: 1 }, { bus: { publishChannel: async () => { throw new Error('redis down'); } } });
});

test('the engine seam returns an injected engine and names what a stale bundle lacks', () => {
    const fake = { hunksFrom() {} };
    _setEngine(fake);
    assert.strictEqual(engine(), fake);
    _setEngine(null);
    try {
        const e = engine();
        assert.ok(['hunksFrom', 'anchorsForFragment', 'applyHunks', 'hunkWords', 'htmlToAst', 'astToHtml'].every((k) => typeof e[k] === 'function'));
    } catch (err) {
        assert.match(err.message, /editor bundle has no .*build:editor-collab/);
    }
});
