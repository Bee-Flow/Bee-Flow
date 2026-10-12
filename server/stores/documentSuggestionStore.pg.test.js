/**
 * document_suggestions against a real Postgres (PGlite), sealed with the real
 * documentCrypto over stand-in key sources.
 *
 * Run: cd server && node --test stores/documentSuggestionStore.pg.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { pgliteDb } = require('../testUtils/pgliteDb');
const { makeDocumentSuggestionStore, DDL } = require('./documentSuggestionStore');
const documentCrypto = require('./lib/documentCrypto');

const { pg, db } = pgliteDb();
const store = makeDocumentSuggestionStore(db);

const ORG_KEY = crypto.randomBytes(32);
const originalSources = { ...documentCrypto.keySources };
const resource = { userId: 'ann', organizationId: 'org1', projectId: 'p1', visibility: 'private', sharingAudience: 'organisation' };

before(async () => {
    await pg.exec(DDL);
    await pg.exec(DDL); // boot runs it on every start
    documentCrypto.keySources.policy = async () => ({ enabled: true, tier: 'managed' });
    documentCrypto.keySources.orgKey = async () => ORG_KEY;
});
after(async () => {
    Object.assign(documentCrypto.keySources, originalSources);
    await pg.close();
});

const hunk = (text) => ({
    anchor: { quote: text, prefix: '', suffix: '', blockIndex: 0 },
    before: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
    after: [{ type: 'paragraph', content: [{ type: 'text', text: `${text}!` }] }],
    summary: `Rewrote "${text}"`,
});
const batch = (targetId, texts, extra = {}) => store.createBatch({
    targetId, projectId: 'p1', organizationId: 'org1', authorKind: 'ai', authorUserId: 'ann', baseToken: 'v1',
    hunks: texts.map(hunk), resource, ...extra,
});

test('a batch round-trips and nothing readable is stored', async () => {
    const out = await batch('d1', ['alpha secret', 'beta secret']);
    assert.strictEqual(out.suggestions.length, 2);
    assert.strictEqual(out.suggestions[0].batchId, out.batchId);
    assert.strictEqual(out.suggestions[0].summary, 'Rewrote "alpha secret"');
    const raw = (await pg.query('SELECT * FROM document_suggestions WHERE batch_id = $1', [out.batchId])).rows;
    assert.strictEqual(raw.length, 2);
    for (const r of raw) {
        for (const f of ['anchor', 'before', 'after', 'summary']) assert.ok(!String(r[f]).includes('secret'), `${f} is sealed`);
        assert.ok(String(r.anchor).includes('documentContext'));
    }
    const listed = await store.list('document', 'd1');
    assert.deepStrictEqual(listed.map((s) => s.summary), ['Rewrote "alpha secret"', 'Rewrote "beta secret"']);
    assert.deepStrictEqual(listed[0].before, hunk('alpha secret').before);
    assert.strictEqual((await store.get(listed[1].id)).anchor.quote, 'beta secret');
    assert.strictEqual(await store.get('nope'), null);
});

test('AAD: a sealed column swapped between two rows does not open', async () => {
    const a = (await batch('d2', ['first text'])).suggestions[0];
    const b = (await batch('d2', ['second text'])).suggestions[0];
    const rowA = (await pg.query('SELECT before FROM document_suggestions WHERE id = $1', [a.id])).rows[0];
    await pg.query('UPDATE document_suggestions SET before = $2 WHERE id = $1', [b.id, rowA.before]);
    await assert.rejects(store.get(b.id), (e) => e.status === 423);
    assert.strictEqual((await store.get(a.id)).anchor.quote, 'first text', 'the untouched row still opens');
});

test('AAD: a value moved into another field, or onto another document, does not open', async () => {
    const s = (await batch('d3', ['one'])).suggestions[0];
    await pg.query('UPDATE document_suggestions SET summary = after WHERE id = $1', [s.id]);
    await assert.rejects(store.get(s.id), (e) => e.status === 423);

    const t = (await batch('d4', ['two'])).suggestions[0];
    await pg.query('UPDATE document_suggestions SET target_id = $2 WHERE id = $1', [t.id, 'd5']);
    await assert.rejects(store.get(t.id), (e) => e.status === 423, 'the document id is bound too');
});

test('no key, no write: nothing is stored when the key cannot be produced', async () => {
    const prior = documentCrypto.keySources.orgKey;
    documentCrypto.keySources.orgKey = async () => { throw new Error('escrow down'); };
    try {
        await assert.rejects(batch('d6', ['x']), (e) => e.status === 423);
        assert.strictEqual((await store.list('document', 'd6')).length, 0);
    } finally {
        documentCrypto.keySources.orgKey = prior;
    }
});

test('setStatus resolves open suggestions once (compare-and-set) and filters list by status', async () => {
    const { suggestions } = await batch('d7', ['a', 'b', 'c']);
    const [a, b, c] = suggestions.map((s) => s.id);
    assert.strictEqual(await store.countOpen('document', 'd7'), 3);
    assert.deepStrictEqual(await store.setStatus([a], 'accepted', { resolvedBy: 'bob', appliedVersionId: 'v9' }), [a]);
    assert.deepStrictEqual(await store.setStatus([a, b], 'rejected', { resolvedBy: 'bob' }), [b], 'a is already resolved');
    assert.deepStrictEqual(await store.setStatus([c], 'stale', { resolvedBy: 'bob' }), [c]);
    const accepted = await store.get(a);
    assert.strictEqual(accepted.status, 'accepted');
    assert.strictEqual(accepted.appliedVersionId, 'v9');
    assert.strictEqual(accepted.resolvedBy, 'bob');
    assert.strictEqual(await store.countOpen('document', 'd7'), 0);
    assert.strictEqual((await store.list('document', 'd7', { status: 'open' })).length, 0);
    assert.strictEqual((await store.list('document', 'd7', { status: ['accepted', 'stale'] })).length, 2);
    await assert.rejects(store.setStatus([a], 'open'), /Unknown status/);
    assert.strictEqual((await store.listBatch('document', 'd7', suggestions[0].batchId)).length, 3);
});

test('supersedeOpen only touches open AI suggestions of that target', async () => {
    const ai = (await batch('d8', ['x'])).suggestions[0];
    const human = (await batch('d8', ['y'], { authorKind: 'user' })).suggestions[0];
    const other = (await batch('d9', ['z'])).suggestions[0];
    assert.deepStrictEqual(await store.supersedeOpen('document', 'd8'), [ai.id]);
    assert.strictEqual((await store.get(human.id)).status, 'open');
    assert.strictEqual((await store.get(other.id)).status, 'open');
});

test('purgeResolved removes old resolved rows only; deleteForTarget removes everything of a document', async () => {
    const { suggestions } = await batch('d10', ['old', 'older', 'open one']);
    const [old, , openOne] = suggestions.map((s) => s.id);
    await store.setStatus(suggestions.slice(0, 2).map((s) => s.id), 'rejected', { resolvedBy: 'ann' });
    await pg.query("UPDATE document_suggestions SET resolved_at = NOW() - INTERVAL '40 days' WHERE id = $1", [old]);
    assert.strictEqual(await store.purgeResolved(30), 1);
    assert.strictEqual(await store.get(old), null);
    assert.ok(await store.get(openOne));
    assert.strictEqual(await store.deleteForTarget('document', 'd10'), 2);
    assert.strictEqual((await store.list('document', 'd10')).length, 0);
    await assert.rejects(store.purgeResolved(-1), /non-negative/);
});

test('input is validated', async () => {
    await assert.rejects(store.createBatch({ targetId: 'd', authorKind: 'ai', hunks: [], resource }), /at least one hunk/);
    await assert.rejects(store.createBatch({ targetId: 'd', authorKind: 'robot', hunks: [hunk('a')], resource }), /authorKind/);
    await assert.rejects(store.createBatch({ targetType: 'notebook', targetId: 'd', authorKind: 'ai', hunks: [hunk('a')], resource }), /target type/);
});
