/**
 * The visibility backfill, against a real Postgres.
 *
 * K5 starts enforcing knowledge-base visibility at retrieval. Agents that
 * worked yesterday because nobody asked will stop answering the moment the
 * filter turns on — so this migration brings the data into line with what the
 * organisation has evidently already decided, before that happens.
 *
 * The case that matters most is the one that LOOKS handled and is not: a
 * personal base (organization_id IS NULL) attached to an org agent. Calling
 * setPublished on it flips a flag and changes nothing, because canUserAccessKB
 * rejects a non-owner before is_published is ever read — a migration that
 * reports success and leaves every colleague's answer empty.
 *
 * Run: cd server && node --test --test-force-exit migrations/publish-kbs-linked-to-org-agents.test.js
 */

'use strict';

const { test, before, after, beforeEach } = require('node:test');
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
const db = { query: q };

function mock(absId, exports) {
    const p = require.resolve(absId);
    const m = new Module(p);
    m.exports = exports;
    m.loaded = true;
    require.cache[p] = m;
}
mock(path.join(__dirname, '..', 'db.js'), { pool: db, exec: q, run: q });

// The store, reduced to the two calls the migration makes. Faithful on the one
// point under test: setPublished writes is_published and shared_groups and
// NOTHING else — in particular it does not set an organisation, which is the
// whole reason branch (b) exists.
const snapshots = [];
mock(path.join(__dirname, '..', 'stores', 'knowledgeBases.js'), {
    snapshotKBVersion: async (kbId, by, reason) => { snapshots.push({ kbId, reason }); return 1; },
    setPublished: async (id, isPublished, sharedGroups) => {
        await q(
            `UPDATE knowledge_bases SET is_published = $2, shared_groups = $3 WHERE id = $1`,
            [id, isPublished, JSON.stringify(sharedGroups || [])],
        );
    },
});

const { up, plan } = require('./publish-kbs-linked-to-org-agents');

const DDL = `
CREATE TABLE knowledge_bases (
    id TEXT PRIMARY KEY, name TEXT, tenant_id TEXT, organization_id TEXT,
    is_published BOOLEAN DEFAULT false, shared_groups TEXT DEFAULT '[]',
    source_kind TEXT DEFAULT 'manual', updated_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE agents (
    id TEXT PRIMARY KEY, name TEXT, owner_id TEXT, organization_id TEXT,
    shared_groups TEXT DEFAULT '[]', config TEXT DEFAULT '{}');
`;

function kbRow(id, over = {}) {
    const r = { id, name: id, tenant_id: 'u_owner', organization_id: 'org1', is_published: false, shared_groups: '[]', source_kind: 'manual', ...over };
    return q(
        `INSERT INTO knowledge_bases (id, name, tenant_id, organization_id, is_published, shared_groups, source_kind)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [r.id, r.name, r.tenant_id, r.organization_id, r.is_published, r.shared_groups, r.source_kind],
    );
}
function agentRow(id, kbIds, over = {}) {
    const r = { id, name: id, owner_id: 'u_owner', organization_id: 'org1', shared_groups: '[]', ...over };
    return q(
        `INSERT INTO agents (id, name, owner_id, organization_id, shared_groups, config) VALUES ($1,$2,$3,$4,$5,$6)`,
        [r.id, r.name, r.owner_id, r.organization_id, r.shared_groups, JSON.stringify({ knowledge_base_ids: kbIds })],
    );
}

before(async () => { await pg.exec(DDL); });
after(async () => { await pg.close(); });
beforeEach(async () => {
    await q('DELETE FROM knowledge_bases');
    await q('DELETE FROM agents');
    snapshots.length = 0;
});

async function kb(id) {
    return (await q('SELECT * FROM knowledge_bases WHERE id = $1', [id])).rows[0];
}

test('(a) an unpublished base in the agents own org is published in place', async () => {
    await kbRow('kb1');
    await agentRow('ag1', ['kb1']);
    const r = await up({ db });
    assert.strictEqual(r.published, 1);
    assert.strictEqual(r.adopted, 0);
    const row = await kb('kb1');
    assert.strictEqual(row.is_published, true);
    assert.strictEqual(row.organization_id, 'org1', 'the org it already had');
    assert.deepStrictEqual(snapshots, [{ kbId: 'kb1', reason: 'visibility_backfill' }]);
});

test('(b) a PERSONAL base on an org agent is adopted into the org, then published', async () => {
    // The sharp one. setPublished alone would flip a flag and change nothing:
    // canUserAccessKB rejects a non-owner before is_published is read.
    await kbRow('kb1', { organization_id: null });
    await agentRow('ag1', ['kb1']);
    const r = await up({ db });
    assert.strictEqual(r.adopted, 1);
    assert.strictEqual(r.published, 0);
    const row = await kb('kb1');
    assert.strictEqual(row.organization_id, 'org1', 'the organisation lands FIRST, or publishing is a no-op');
    assert.strictEqual(row.is_published, true);
    assert.deepStrictEqual(snapshots, [{ kbId: 'kb1', reason: 'visibility_backfill_adopt' }]);
});

test('the group union is the audience the base already had, not the whole org', async () => {
    await kbRow('kb1');
    await agentRow('ag1', ['kb1'], { shared_groups: '["g_sales"]' });
    await agentRow('ag2', ['kb1'], { shared_groups: '["g_support"]' });
    await up({ db });
    assert.deepStrictEqual(JSON.parse((await kb('kb1')).shared_groups).sort(), ['g_sales', 'g_support']);
});

test('one org-wide agent collapses the union to no restriction', async () => {
    // An agent with no groups is open to the whole organisation, so the base
    // it reads already answered the whole organisation.
    await kbRow('kb1');
    await agentRow('ag1', ['kb1'], { shared_groups: '["g_sales"]' });
    await agentRow('ag2', ['kb1'], { shared_groups: '[]' });
    await up({ db });
    assert.deepStrictEqual(JSON.parse((await kb('kb1')).shared_groups), []);
});

test('a base in a DIFFERENT organisation from the agent is left alone', async () => {
    // That is the cross-org leak the link-time check refuses. Publishing it
    // here would make it permanent.
    await kbRow('kb1', { organization_id: 'org2' });
    await agentRow('ag1', ['kb1']);
    const r = await up({ db });
    assert.strictEqual(r.published + r.adopted, 0);
    assert.strictEqual((await kb('kb1')).is_published, false);
});

test("a personal base on someone ELSE'S agent is not adopted", async () => {
    // Branch (b) is legal only because the agent's owner owns the base. A base
    // belonging to a third party is not the agent owner's to give away.
    await kbRow('kb1', { organization_id: null, tenant_id: 'u_someone_else' });
    await agentRow('ag1', ['kb1'], { owner_id: 'u_owner' });
    const r = await up({ db });
    assert.strictEqual(r.adopted, 0);
    assert.strictEqual((await kb('kb1')).organization_id, null);
});

test('a personal agent reading its owners personal base needs no change', async () => {
    await kbRow('kb1', { organization_id: null });
    await agentRow('ag1', ['kb1'], { organization_id: null });
    const r = await up({ db });
    assert.strictEqual(r.published + r.adopted, 0, 'an agent with no org is not scanned at all');
});

test('a system base is never touched', async () => {
    await kbRow('kb1', { source_kind: 'system_managed', organization_id: null });
    await agentRow('ag1', ['kb1']);
    const r = await up({ db });
    assert.strictEqual(r.published + r.adopted, 0);
});

test('an already-published base is skipped, and a second run writes nothing', async () => {
    await kbRow('kb1');
    await agentRow('ag1', ['kb1']);
    await up({ db });
    snapshots.length = 0;

    const second = await up({ db });
    assert.strictEqual(second.published, 0);
    assert.strictEqual(second.adopted, 0);
    assert.deepStrictEqual(snapshots, [], 'idempotent — nothing re-snapshotted');
});

test('a knowledge base id that resolves to nothing is skipped, not fatal', async () => {
    await agentRow('ag1', ['kb_gone']);
    await assert.doesNotReject(() => up({ db }));
});

test('--dry-run separates the two branches per agent and writes NOTHING', async () => {
    await kbRow('kb_a');
    await kbRow('kb_b', { organization_id: null });
    await agentRow('ag1', ['kb_a', 'kb_b'], { name: 'Support bot' });

    const lines = [];
    const r = await up({ db, dryRun: true, log: (m) => lines.push(m) });
    assert.strictEqual(r.published, 0);
    assert.strictEqual(r.adopted, 0);
    assert.deepStrictEqual(snapshots, []);
    assert.strictEqual((await kb('kb_a')).is_published, false, 'a dry run writes nothing');
    assert.strictEqual((await kb('kb_b')).organization_id, null);

    assert.deepStrictEqual(r.plan.publish.map(e => e.kbId), ['kb_a']);
    assert.deepStrictEqual(r.plan.adopt.map(e => e.kbId), ['kb_b']);
    // The consequence of branch (b) is stated where somebody reading the run
    // will see it, not only in the source.
    const text = lines.join('\n');
    assert.match(text, /stop being personal/);
    assert.match(text, /Support bot/, 'and it says which agent pointed at what');
});

test('the plan names the agents behind each base', async () => {
    await kbRow('kb1');
    await agentRow('ag1', ['kb1'], { name: 'A' });
    await agentRow('ag2', ['kb1'], { name: 'B' });
    const { publish } = await plan({ db });
    assert.deepStrictEqual(publish[0].agents.map(a => a.id).sort(), ['ag1', 'ag2']);
});
