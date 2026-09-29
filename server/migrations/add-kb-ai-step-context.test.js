/**
 * The `ai_step` usage-context backfill, against a real Postgres.
 *
 * The property under test is not "the column gained a value" — it is that the
 * migration cannot break running work. A routine whose AI step names a base
 * its author never touched must still activate after this runs, which means
 * every agent-usable base has to come out of it carrying 'ai_step'.
 *
 * Run: cd server && node --test --test-force-exit migrations/add-kb-ai-step-context.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Module = require('node:module');

const { PGlite } = require('@electric-sql/pglite');
const pg = new PGlite();

async function q(sql, params) {
    const res = Array.isArray(params) && params.length
        ? await pg.query(sql, params)
        : (/;\s*\S/.test(String(sql).trim()) ? await pg.exec(sql) : await pg.query(sql));
    const r = Array.isArray(res) ? (res[res.length - 1] || {}) : (res || {});
    return { rows: r.rows || [], rowCount: (r.rows || []).length };
}

function mock(absId, exports) {
    const p = require.resolve(absId);
    const m = new Module(p);
    m.exports = exports;
    m.loaded = true;
    require.cache[p] = m;
}
mock(path.join(__dirname, '..', 'db.js'), { exec: q, pool: { query: q }, run: q });

const { up } = require('./add-kb-ai-step-context');

const CONTEXTS = (row) => row.usage_contexts;

before(async () => {
    await pg.exec(`
        CREATE TABLE knowledge_bases (
            id TEXT PRIMARY KEY,
            name TEXT,
            usage_contexts JSONB DEFAULT '["agent","direct_chat"]'::jsonb,
            source_kind TEXT DEFAULT 'manual',
            updated_at TIMESTAMPTZ DEFAULT now()
        );
        INSERT INTO knowledge_bases (id, name, usage_contexts) VALUES
            ('kb_agent',    'Handbook',      '["agent","direct_chat"]'::jsonb),
            ('kb_chat',     'Chat only',     '["direct_chat"]'::jsonb),
            ('kb_webpage',  'Auto webpage',  '["webpage"]'::jsonb),
            ('kb_already',  'Already there', '["agent","ai_step"]'::jsonb),
            ('kb_null',     'Pre-column',    NULL);
    `);
    await up();
});
after(async () => { await pg.close(); });

async function kb(id) {
    return (await q('SELECT usage_contexts FROM knowledge_bases WHERE id = $1', [id])).rows[0];
}

test('an agent-usable base gains ai_step, keeping what it had', async () => {
    // The one that matters: without this, every routine naming this base fails
    // its next activation.
    assert.deepStrictEqual(CONTEXTS(await kb('kb_agent')), ['agent', 'direct_chat', 'ai_step']);
});

test('a base that was never agent-usable is left alone', async () => {
    assert.deepStrictEqual(CONTEXTS(await kb('kb_chat')), ['direct_chat']);
    // Auto-created per-page bases are scoped to their page by design.
    assert.deepStrictEqual(CONTEXTS(await kb('kb_webpage')), ['webpage']);
});

test('a row that predates the column becomes usable everywhere it was', async () => {
    // NULL meant "no restriction was ever expressed", which the pickers read as
    // everything. Leaving it NULL while the check starts demanding a value
    // would silently remove it from every surface.
    assert.deepStrictEqual(CONTEXTS(await kb('kb_null')), ['agent', 'direct_chat', 'ai_step']);
});

test('running it twice changes nothing — no duplicate value', async () => {
    await up();
    assert.deepStrictEqual(CONTEXTS(await kb('kb_agent')), ['agent', 'direct_chat', 'ai_step']);
    assert.deepStrictEqual(CONTEXTS(await kb('kb_already')), ['agent', 'ai_step']);
    assert.deepStrictEqual(CONTEXTS(await kb('kb_chat')), ['direct_chat']);
});
