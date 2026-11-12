// @typecheck strict
const test = require('node:test');
const assert = require('node:assert');
const { preloadStubs } = require('../testUtils/stubRequire');

const CHUNK = {
    id: '11111111-2222-3333-4444-555555555555', chunk_id: 0, document_id: 'doc-1', knowledge_base_id: 'kb1', source_id: 'src-1',
    title: 'Handbook', source_uri: 'handbook.pdf', content: 'Leave requests go through the HR portal within five days.', score: 0.9,
};

test('kb_search results carry the chunk id kb_fetch resolves, and the source uri', async () => {
    const mods = {
        '../stores/agentStore': { getForRuntime: async () => ({ config: { knowledge_base_ids: ['kb1'] } }) },
        '../core/agentRuntime/testAs': { visibleKbIdsFor: async (/** @type {string[]} */ ids) => ids },
        '../core/kb/resolveProvider': { resolveKbProvider: async () => 'local' },
        '../core/kb/localKBIngest': { searchLocally: async () => Object.assign([{ ...CHUNK }], { _orphanFiltered: true }) },
    };
    preloadStubs(require, mods);
    const tool = require('./kbSearchTools');
    const ctx = { userId: 'u1', agentId: 'a1', conversationId: 'conv-kbsearch-test' };
    const res = await tool.executeKbSearchTool('kb_search', { query: 'how do leave requests work' }, ctx);
    assert.strictEqual(res.results.length, 1);
    assert.strictEqual(res.results[0].chunk_id, CHUNK.id, 'the row id, not the per-document ordinal');
    assert.strictEqual(res._sources[0].chunkId, CHUNK.id);
    assert.strictEqual(res._sources[0].documentId, 'doc-1');

    const fetched = await tool.executeKbSearchTool('kb_fetch', { chunk_ids: [res.results[0].chunk_id] }, ctx);
    assert.ok(fetched.chunks, `kb_fetch resolved nothing: ${JSON.stringify(fetched)}`);
    assert.strictEqual(fetched.chunks[0].content, CHUNK.content);

    const kbQueryCache = require('../core/agentRuntime/kbQueryCache');
    assert.strictEqual(kbQueryCache.getChunk(kbQueryCache.scopeFor(ctx.conversationId, ctx.userId), CHUNK.id).source_uri, 'handbook.pdf');
});

test('Z-N3: kb_fetch never reads a chunk id outside this conversation\'s search results', async () => {
    /** @type {unknown[][]} */
    const queries = [];
    preloadStubs(require, {
        '../db': { getAll: async (/** @type {unknown[]} */ ...a) => { queries.push(a); return [{ chunk_id: '42', title: 'Other tenant', content: 'secret' }]; } },
    });
    const tool = require('./kbSearchTools');
    const res = await tool.executeKbSearchTool('kb_fetch', { chunk_ids: ['42'] }, { userId: 'u2', agentId: 'a2', conversationId: 'conv-other' });
    assert.ok(res.error, 'an unknown id is an error, not content');
    assert.strictEqual(JSON.stringify(res).includes('secret'), false);
    assert.deepStrictEqual(queries, [], 'no database read for an id the conversation never saw');
});

test('Z-N3: kb_fetch is only claimed when preview mode offers it', () => {
    const tool = require('./kbSearchTools');
    const prev = process.env.KB_PREVIEW_MODE;
    try {
        delete process.env.KB_PREVIEW_MODE;
        assert.strictEqual(tool.isKbSearchTool('kb_fetch'), false);
        assert.strictEqual(tool.isKbSearchTool('kb_search'), true);
        process.env.KB_PREVIEW_MODE = 'true';
        assert.strictEqual(tool.isKbSearchTool('kb_fetch'), true);
    } finally {
        if (prev === undefined) delete process.env.KB_PREVIEW_MODE; else process.env.KB_PREVIEW_MODE = prev;
    }
});

test('kb_search logs the length of a question, never its text', async () => {
    preloadStubs(require, {
        '../stores/agentStore': { getForRuntime: async () => ({ config: { knowledge_base_ids: ['kb1'] } }) },
        '../core/agentRuntime/testAs': { visibleKbIdsFor: async (/** @type {string[]} */ ids) => ids },
        '../core/kb/resolveProvider': { resolveKbProvider: async () => 'local' },
        '../core/kb/localKBIngest': { searchLocally: async () => Object.assign([{ ...CHUNK }], { _orphanFiltered: true }) },
    });
    const log = require('../telemetry/log');
    const tool = require('./kbSearchTools');
    /** @type {string[]} */
    const lines = [];
    const saved = { info: log.info, warn: log.warn };
    log.info = (/** @type {unknown[]} */ ...a) => { lines.push(a.map(String).join(' ')); };
    log.warn = (/** @type {unknown[]} */ ...a) => { lines.push(a.map(String).join(' ')); };
    try {
        const question = 'salary of Jan de Vries in the payroll export';
        const ctx = { userId: 'u3', agentId: 'a3', conversationId: 'conv-log-test' };
        await tool.executeKbSearchTool('kb_search', { query: question }, ctx);
        await tool.executeKbSearchTool('kb_search', { query: question }, ctx); // the cache hit
        await tool.executeKbSearchTool('kb_search', { query: 'hello there' }, ctx); // small talk
        const kbLines = lines.filter((l) => l.startsWith('[KBSearch]'));
        assert.ok(kbLines.some((l) => l.includes(`query ${question.length} chars`)), kbLines.join('\n'));
        assert.ok(kbLines.some((l) => l.includes('Cache HIT')), kbLines.join('\n'));
        assert.ok(kbLines.some((l) => l.includes('small-talk')), kbLines.join('\n'));
        for (const l of lines) {
            assert.strictEqual(l.includes('Jan de Vries'), false, l);
            assert.strictEqual(l.includes('hello there'), false, l);
        }
    } finally {
        log.info = saved.info;
        log.warn = saved.warn;
    }
});
