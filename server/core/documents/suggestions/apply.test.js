'use strict';

/**
 * Accepting / rejecting suggestions with fakes: the engine treats an "AST" as a
 * list of block strings, a hunk is { before: [blocks], after: [blocks] } located
 * by its before-blocks; html is blocks joined with '|'.
 *
 * Run: cd server && node --test core/documents/suggestions/apply.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { makeSuggestionApplier } = require('./apply');

const fakeEngine = {
    htmlToAst: (html) => (html ? html.split('|') : []),
    astToHtml: (ast) => ast.join('|'),
    applyHunks(current, hunks) {
        let doc = [...current];
        const applied = [];
        const stale = [];
        hunks.forEach((h, i) => {
            const at = doc.findIndex((_, k) => h.before.every((b, j) => doc[k + j] === b));
            if (at < 0 || h.before.length === 0) { stale.push(i); return; }
            doc.splice(at, h.before.length, ...h.after);
            applied.push(i);
        });
        return { doc, applied, stale };
    },
};

function setup({ html = 'one|two|three', live = null } = {}) {
    const state = { html, versionId: 'v1', updates: [], feed: [], announced: [] };
    const rows = new Map();
    const store = {
        async get(id) { return rows.get(id) || null; },
        async setStatus(ids, status, opts = {}) {
            const out = [];
            for (const id of ids) {
                const r = rows.get(id);
                if (r && (opts.from || ['open']).includes(r.status)) { r.status = status; r.resolvedBy = opts.resolvedBy; r.appliedVersionId = opts.appliedVersionId; out.push(id); }
            }
            return out;
        },
        async countOpen() { return [...rows.values()].filter((r) => r.status === 'open').length; },
    };
    const add = (id, before, after, extra = {}) => rows.set(id, { id, batchId: 'b1', targetId: 'd1', status: 'open', anchor: {}, before, after, summary: id, ...extra });
    const documents = {
        async updateDocument(id, actor, updates) {
            state.updates.push({ id, actor, updates });
            if (state.conflict) throw Object.assign(new Error('changed'), { errorClass: 'document_conflict' });
            state.html = updates.bodyHtml; state.versionId = 'v2';
            return { id, bodyHtml: state.html, versionId: 'v2', projectId: null };
        },
    };
    const applier = makeSuggestionApplier({
        store, documents, engine: () => fakeEngine,
        liveCollabFor: async () => live,
        feed: { recordContentChange: async (...a) => { state.feed.push(a); } },
        wordStats: () => ({}),
        announce: async (e) => { state.announced.push(e); },
    });
    const doc = () => ({ id: 'd1', projectId: null, bodyHtml: state.html, versionId: state.versionId });
    return { state, rows, add, applier, doc, actor: { userId: 'bob' } };
}

test('stored page: accepted hunks are written once as an AI revision; the ones that no longer fit become stale', async () => {
    const t = setup();
    t.add('s1', ['one'], ['ONE']);
    t.add('s2', ['three'], ['THREE']);
    t.add('s3', ['gone'], ['x']);
    const out = await t.applier.accept({ doc: t.doc(), ids: ['s1', 's2', 's3'], actor: t.actor });
    assert.deepStrictEqual(out, { accepted: ['s1', 's2'], rejected: [], stale: ['s3'], versionId: 'v2' });
    assert.strictEqual(t.state.updates.length, 1, 'accept all is one write');
    const { actor, updates } = t.state.updates[0];
    assert.deepStrictEqual(actor, { userId: 'bob', isAdmin: false });
    assert.strictEqual(updates.bodyHtml, 'ONE|two|THREE');
    assert.strictEqual(updates.expectedVersionId, 'v1');
    assert.strictEqual(updates.source, 'ai');
    assert.strictEqual(t.rows.get('s1').appliedVersionId, 'v2');
    assert.strictEqual(t.rows.get('s3').status, 'stale');
    assert.strictEqual(t.state.feed.length, 1);
    assert.deepStrictEqual(t.state.announced, [{ documentId: 'd1', projectId: null, batchId: 'b1', open: 0 }]);
});

test('nothing applicable: nothing is written, the suggestions are marked stale', async () => {
    const t = setup();
    t.add('s1', ['gone'], ['x']);
    const out = await t.applier.accept({ doc: t.doc(), ids: ['s1'], actor: t.actor });
    assert.deepStrictEqual(out, { accepted: [], rejected: [], stale: ['s1'], versionId: null });
    assert.strictEqual(t.state.updates.length, 0);
});

test('already resolved suggestions and suggestions of another document are ignored', async () => {
    const t = setup();
    t.add('s1', ['one'], ['ONE'], { status: 'rejected' });
    t.add('s2', ['two'], ['TWO'], { targetId: 'other' });
    const out = await t.applier.accept({ doc: t.doc(), ids: ['s1', 's2', 'missing'], actor: t.actor });
    assert.deepStrictEqual(out, { accepted: [], rejected: [], stale: [], versionId: null });
    assert.strictEqual(t.state.updates.length, 0);
    assert.strictEqual(t.rows.get('s2').status, 'open');
});

test('a document that changed under the write is a 409, and the suggestions stay open', async () => {
    const t = setup();
    t.add('s1', ['one'], ['ONE']);
    t.state.conflict = true;
    await assert.rejects(t.applier.accept({ doc: t.doc(), ids: ['s1'], actor: t.actor }), (e) => e.status === 409 && e.code === 'document_changed');
    assert.strictEqual(t.rows.get('s1').status, 'open');
});

test('live page: read -> applyHunks -> applyServerEdit with expectSeq, AI origin, accepter as actor', async () => {
    const calls = [];
    const live = {
        read: async () => ({ html: 'one|two', seq: 7 }),
        applyServerEdit: async (kind, id, actor, edit) => { calls.push({ kind, id, actor, edit }); return { applied: true, seq: 8, versionId: 'lv1' }; },
    };
    const t = setup({ live });
    t.add('s1', ['two'], ['TWO']);
    const out = await t.applier.accept({ doc: t.doc(), ids: ['s1'], actor: t.actor });
    assert.deepStrictEqual(out, { accepted: ['s1'], rejected: [], stale: [], versionId: 'lv1' });
    assert.deepStrictEqual(calls, [{ kind: 'document', id: 'd1', actor: { origin: 'ai', actorId: 'bob' }, edit: { replaceWith: { ast: ['one', 'TWO'] }, expectSeq: 7 } }]);
    assert.strictEqual(t.state.updates.length, 0, 'the stored body is left to the live layer');
});

test('live page: somebody typing in between is retried on the new state (3 attempts), then a 409', async () => {
    let seq = 1;
    let tries = 0;
    const live = {
        read: async () => ({ html: seq === 1 ? 'one|two' : 'zero|one|two', seq }),
        applyServerEdit: async (_k, _i, _a, edit) => { tries += 1; if (tries === 1) { seq = 2; return { applied: false, stale: true }; } return { applied: true, seq: 3, versionId: 'lv2', ast: edit.replaceWith.ast }; },
    };
    const t = setup({ live });
    t.add('s1', ['two'], ['TWO']);
    const out = await t.applier.accept({ doc: t.doc(), ids: ['s1'], actor: t.actor });
    assert.deepStrictEqual(out.accepted, ['s1']);
    assert.strictEqual(tries, 2);

    const busy = setup({ live: { read: async () => ({ html: 'one|two', seq: 1 }), applyServerEdit: async () => ({ applied: false, stale: true }) } });
    busy.add('s1', ['two'], ['TWO']);
    await assert.rejects(busy.applier.accept({ doc: busy.doc(), ids: ['s1'], actor: busy.actor }), (e) => e.status === 409 && e.code === 'document_busy');
    assert.strictEqual(busy.rows.get('s1').status, 'open');
});

test('live page that stops being live mid-way falls back to the stored write', async () => {
    const live = { read: async () => ({ html: 'one|two', seq: 1 }), applyServerEdit: async () => ({ applied: false }) };
    const t = setup({ live });
    t.add('s1', ['one'], ['ONE']);
    const out = await t.applier.accept({ doc: t.doc(), ids: ['s1'], actor: t.actor });
    assert.deepStrictEqual(out.accepted, ['s1']);
    assert.strictEqual(t.state.updates.length, 1);
});

test('reject resolves open and stale suggestions without touching the document', async () => {
    const t = setup();
    t.add('s1', ['one'], ['ONE']);
    t.add('s2', ['two'], ['TWO'], { status: 'stale' });
    t.add('s3', ['three'], ['x'], { status: 'accepted' });
    const out = await t.applier.reject({ doc: t.doc(), ids: ['s1', 's2', 's3'], actor: t.actor });
    assert.deepStrictEqual(out, { accepted: [], rejected: ['s1', 's2'], stale: [], versionId: null });
    assert.strictEqual(t.rows.get('s3').status, 'accepted');
    assert.strictEqual(t.state.updates.length, 0);
    assert.strictEqual(t.state.announced.length, 1);
});
