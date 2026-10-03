/**
 * Notebook source routes: size and count caps are enforced BEFORE a row is
 * inserted, cancel only touches a source that is still processing, retry claims
 * only a source that is not being read and stores a friendly error, empty Drive files are marked as errors, and bulk delete is
 * one scoped store call.
 *
 * Run: cd server && node --test routes/notebooks.sources.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const h = require('../core/http/routeHarness');
const { makeSwaps } = require('../testUtils/swaps');

const notebookStore = require('../stores/notebookStore');
const notebookCascade = require('../core/kb/notebookCascade');
const ingestion = require('../agents/notebooks/sourceIngestion');

const { swap, restore } = makeSwaps();

const state = { sources: [], added: [], updates: [], cleaned: [], bulk: [], count: 0, ingested: [] };

function reset() {
    state.sources = [
        { id: 's-proc', notebookId: 'nb1', type: 'text', name: 'P', status: 'processing' },
        { id: 's-ready', notebookId: 'nb1', type: 'text', name: 'R', status: 'ready' },
    ];
    Object.assign(state, { added: [], updates: [], cleaned: [], bulk: [], count: 2, ingested: [] });
}

const { api } = h.routeUnderTest(test, '/api/notebooks', () => {
    swap(ingestion, 'ingestTextSource', async (...a) => { state.ingested.push(a); throw new Error('boom: ECONNREFUSED'); });
    swap(ingestion, 'ingestDriveSource', async (...a) => { state.ingested.push(a); });
    // Before the router loads: it destructures this function at require time.
    swap(notebookCascade, 'cleanupSourceArtifacts', async (nb, source) => { state.cleaned.push(source.id); });
    const router = require('./notebooks');
    swap(router.seams, 'collab', () => ({ isActive: async () => false }));
    swap(router.seams, 'feed', () => ({ sourcesAdded: async () => {} }));
    swap(router.seams, 'getProject', async () => null);
    swap(router.seams, 'projectRoleOf', async () => null);
    return router;
});

test.before(() => {
    reset();
    swap(notebookStore, 'getNotebook', async (id, userId) => (
        id === 'nb1' && userId === 'alice'
            ? { id: 'nb1', userId: 'alice', name: 'N', knowledgeBaseIds: ['kb1'], role: 'owner' } : null));
    swap(notebookStore, 'countSources', async () => state.count);
    swap(notebookStore, 'addSource', async (a) => {
        const source = { id: `new${state.added.length}`, notebookId: a.notebookId, name: a.name, type: a.type, status: 'processing' };
        state.added.push(source);
        return source;
    });
    swap(notebookStore, 'getSource', async (sid) => state.sources.find((x) => x.id === sid) || null);
    swap(notebookStore, 'getSourceContent', async () => 'stored text');
    swap(notebookStore, 'updateSource', async (id, updates, opts) => { state.updates.push({ id, updates, opts }); return true; });
    swap(notebookStore, 'claimSourceForRetry', async (sid) => {
        const source = state.sources.find((x) => x.id === sid);
        if (!source || source.status === 'processing') return false;
        source.status = 'processing';
        return true;
    });
    swap(notebookStore, 'deleteSources', async (ids, nbId) => {
        state.bulk.push({ ids, nbId });
        return ids.filter((i) => i === 's-proc' || i === 's-ready').map((id) => ({ id, storageKey: null }));
    });
});
test.after(restore);
test.beforeEach(reset);

const call = (method, path, body) => api.call(method, `/api/notebooks/nb1${path}`, { user: { id: 'alice', organizationId: 'org1', role: 'user' }, body });

test('pasted text over the cap is a 413 and no row is inserted', async () => {
    const res = await call('POST', '/sources/text', { text: 'x'.repeat(ingestion.MAX_SOURCE_TEXT_CHARS + 1) });
    assert.strictEqual(res.status, 413, res.text);
    assert.strictEqual(res.body.code, 'source_text_too_large');
    assert.strictEqual(state.added.length, 0);
});

test('a full notebook refuses new sources with 409 notebook_source_limit, before any insert', async () => {
    state.count = ingestion.MAX_SOURCES_PER_NOTEBOOK;
    for (const [path, body] of [
        ['/sources/text', { text: 'hello world, long enough' }],
        ['/sources/url', { url: 'https://example.test/a' }],
        ['/sources/drive', { files: [{ name: 'a', content: 'abc' }] }],
    ]) {
        const res = await call('POST', path, body);
        assert.strictEqual(res.status, 409, `${path}: ${res.text}`);
        assert.strictEqual(res.body.code, 'notebook_source_limit');
    }
    assert.strictEqual(state.added.length, 0);
});

test('a Drive import that would cross the cap is refused whole, not half-added', async () => {
    state.count = ingestion.MAX_SOURCES_PER_NOTEBOOK - 1;
    const res = await call('POST', '/sources/drive', { files: [{ name: 'a', content: 'abc' }, { name: 'b', content: 'abc' }] });
    assert.strictEqual(res.status, 409, res.text);
    assert.strictEqual(state.added.length, 0);
});

test('Drive: an oversized file is a 413 before any insert; an empty one becomes a friendly error', async () => {
    const big = await call('POST', '/sources/drive', { files: [
        { name: 'ok', content: 'abc' }, { name: 'big', content: 'x'.repeat(ingestion.MAX_SOURCE_TEXT_CHARS + 1) },
    ] });
    assert.strictEqual(big.status, 413, big.text);
    assert.strictEqual(state.added.length, 0);

    const res = await call('POST', '/sources/drive', { files: [{ name: 'ok', content: 'some content here' }, { name: 'empty' }] });
    assert.strictEqual(res.status, 200, res.text);
    assert.strictEqual(res.body.sources.length, 2);
    const failed = state.updates.find((u) => u.id === 'new1');
    assert.strictEqual(failed.updates.status, 'error');
    assert.strictEqual(failed.updates.stage, 'error');
    assert.ok(failed.updates.error);
    assert.strictEqual(res.body.sources[1].status, 'error');
    assert.strictEqual(state.ingested.length, 1, 'only the file with content is ingested');
});

test('cancel flips a processing source (conditionally) and leaves a finished one alone', async () => {
    const res = await call('POST', '/sources/s-proc/cancel');
    assert.strictEqual(res.status, 200, res.text);
    assert.deepStrictEqual(state.updates.map((u) => [u.id, u.updates.status, u.opts.onlyIfProcessing]), [['s-proc', 'error', true]]);

    state.updates = [];
    const ready = await call('POST', '/sources/s-ready/cancel');
    assert.strictEqual(ready.status, 200);
    assert.strictEqual(state.updates.length, 0, 'a ready source is not flipped to error');
});

test('a source that is still being read is not retried a second time', async () => {
    const res = await call('POST', '/sources/s-proc/retry');
    assert.strictEqual(res.status, 409, res.text);
    assert.strictEqual(res.body.code, 'source_busy');
    assert.deepStrictEqual(state.ingested, []);
});

test('retry failure is stored with a friendly message and stage error, only while still processing', async () => {
    const res = await call('POST', '/sources/s-ready/retry');
    assert.strictEqual(res.status, 200, res.text);
    for (let i = 0; i < 20 && !state.updates.some((u) => u.updates.status === 'error'); i++) await new Promise((r) => setTimeout(r, 10));
    const failed = state.updates.find((u) => u.updates.status === 'error');
    assert.ok(failed, 'the failure was recorded');
    assert.strictEqual(failed.updates.stage, 'error');
    assert.match(failed.updates.error, /Could not reach/);
    assert.doesNotMatch(failed.updates.error, /boom/);
    assert.strictEqual(failed.opts.onlyIfProcessing, true);
});

test('bulk delete is one scoped store call and cleans up each removed source', async () => {
    const res = await call('POST', '/sources/bulk-delete', { ids: ['s-proc', 's-ready', 'foreign'] });
    assert.strictEqual(res.status, 200, res.text);
    assert.deepStrictEqual(res.body, { success: true, deleted: 2 });
    assert.deepStrictEqual(state.bulk, [{ ids: ['s-proc', 's-ready', 'foreign'], nbId: 'nb1' }]);
    assert.deepStrictEqual(state.cleaned.sort(), ['s-proc', 's-ready']);
});
