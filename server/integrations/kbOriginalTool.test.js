'use strict';
/**
 * kb_get_original: the agent hands over the uploaded file of a document, only from bases the person may read.
 * The card links to the knowledge-base download route; no copy of the file is made.
 * Run: node --test integrations/kbOriginalTool.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { executeKbGetOriginal, cardKind, KB_GET_ORIGINAL_TOOL } = require('./kbOriginalTool');
const { executeKbSearchTool, isKbSearchTool, KB_SEARCH_TOOLS } = require('./kbSearchTools');

const DOC = '33333333-3333-4333-8333-333333333333';
const KB_VISIBLE = 'kb-visible';
const KB_HIDDEN = 'kb-hidden';

function world({ docKb = KB_VISIBLE, visible = [KB_VISIBLE], hasOriginal = true } = {}) {
    const seen = { visibleFor: null };
    const row = {
        id: DOC, knowledge_base_id: docKb, tenant_id: 'owner1', title: 'Contract', has_original: hasOriginal,
        original_mime: hasOriginal ? 'application/pdf' : null, original_size: hasOriginal ? 1234 : null,
        metadata: hasOriginal ? { originalFilename: 'Contract.pdf' } : {},
    };
    return {
        seen,
        deps: {
            kbStore: { getDocument: async (id) => (id === DOC ? row : null) },
            agentStore: { getForRuntime: async () => ({ config: { knowledge_base_ids: [KB_VISIBLE, KB_HIDDEN] } }) },
            visibleKbIdsFor: async (ids, opts) => { seen.visibleFor = { ids, opts }; return ids.filter((id) => visible.includes(id)); },
        },
    };
}
const CTX = { userId: 'u9', agentId: 'agent1' };

test('a visible document: a file card that links to the access-checked KB route, no copy', async () => {
    const w = world();
    const res = await executeKbGetOriginal({ documentId: DOC }, CTX, w.deps);
    assert.equal(res.success, true);
    assert.deepEqual(w.seen.visibleFor.opts, { userId: 'u9', testAs: null, context: 'kb_search', agentId: 'agent1' });
    assert.deepEqual({ ...res.file }, {
        kind: 'pdf', name: 'Contract.pdf', url: `/api/kb/${KB_VISIBLE}/documents/${DOC}/original`, mimeType: 'application/pdf', size: 1234, source: 'kb_get_original',
    });
});

test('a document of a base the person may not read is refused like a missing one', async () => {
    const w = world({ docKb: KB_HIDDEN });
    const hidden = await executeKbGetOriginal({ documentId: DOC }, CTX, w.deps);
    const missing = await executeKbGetOriginal({ documentId: '99999999-9999-4999-8999-999999999999' }, CTX, w.deps);
    assert.ok(hidden.error);
    assert.deepEqual(hidden, missing, 'no difference between "hidden" and "does not exist"');
});

test('a base that is not the agent\'s at all is refused', async () => {
    const w = world({ docKb: 'kb-of-somebody-else', visible: ['kb-of-somebody-else'] });
    const res = await executeKbGetOriginal({ documentId: DOC }, CTX, w.deps);
    assert.ok(res.error);
});

test('a failure while narrowing leaves no base, never all of them', async () => {
    const w = world();
    const res = await executeKbGetOriginal({ documentId: DOC }, CTX, { ...w.deps, visibleKbIdsFor: async () => { throw new Error('boom'); } });
    assert.ok(res.error);
});

test('a document without a stored original says so', async () => {
    const w = world({ hasOriginal: false });
    const res = await executeKbGetOriginal({ documentId: DOC }, CTX, w.deps);
    assert.match(res.error, /no stored original/);
});

test('a bad documentId and no user are errors, not throws', async () => {
    const w = world();
    assert.ok((await executeKbGetOriginal({ documentId: 'nope' }, CTX, w.deps)).error);
    assert.ok((await executeKbGetOriginal({ documentId: DOC }, { agentId: 'a' }, w.deps)).error);
});

test('the card kind: office kinds, pdf, else file', () => {
    assert.equal(cardKind('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'a.docx'), 'word');
    assert.equal(cardKind('application/octet-stream', 'sheet.xlsx'), 'spreadsheet');
    assert.equal(cardKind('', 'deck.pptx'), 'presentation');
    assert.equal(cardKind('application/pdf', 'x'), 'pdf');
    assert.equal(cardKind('image/png', 'x.png'), 'file');
});


test('the tool is registered with kb_search and routed to the same family', async () => {
    assert.ok(KB_SEARCH_TOOLS.some((t) => t.function.name === 'kb_get_original'));
    assert.equal(KB_GET_ORIGINAL_TOOL.function.name, 'kb_get_original');
    assert.equal(isKbSearchTool('kb_get_original'), true);
    const res = await executeKbSearchTool('kb_get_original', { documentId: 'not-an-id' }, CTX);
    assert.match(res.error, /documentId/);
});
