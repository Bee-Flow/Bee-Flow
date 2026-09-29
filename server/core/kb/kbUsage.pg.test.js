/**
 * The usage scans, against a REAL Postgres (@electric-sql/pglite, in-process).
 *
 * ── WHY THIS EXISTS ALONGSIDE kbUsage.test.js ───────────────────────
 * The sibling suite proves the POLICY: a missing table is partial and never
 * zero, one failing scan does not abandon the rest, the id goes into jsonpath
 * as a variable. It cannot prove the queries are right, because its fake
 * `query()` never parses the SQL — so a scan naming a column that does not
 * exist passes there and returns nothing in production.
 *
 * That is not a hypothetical. Written from the store headers alone, five of
 * the eight scans named a column the table has not got: `agents.user_id` and
 * `projects.user_id` (both are `owner_id`), `automations.name` (it is
 * `title`), `notebooks.title` (it is `name`), and
 * `support_inboxes.support_ai_kb_ids` — which is a configStore KEY, while the
 * column is `kb_ids`. Every one of them would have made the delete dialog say
 * "nothing depends on this" about a base three agents were using, and the
 * person would have believed it, because they asked.
 *
 * So this creates the tables as production has them, seeds one consumer of
 * each kind, and asserts the scan FINDS it. A column rename that breaks a
 * scan fails here loudly instead of going quiet.
 *
 * Run: cd server && node --test --test-force-exit core/kb/kbUsage.pg.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { PGlite } = require('@electric-sql/pglite');
const pg = new PGlite();

function adapt(res, sql) {
    const r = Array.isArray(res) ? (res[res.length - 1] || {}) : (res || {});
    const rows = r.rows || [];
    const fields = r.fields || [];
    const rowCount = fields.length > 0
        ? rows.length
        : (typeof r.affectedRows === 'number' ? r.affectedRows : 0);
    return { rows, fields, rowCount, command: String(sql).trim().split(/\s+/)[0].toUpperCase() };
}

async function q(sql, params) {
    if (Array.isArray(params) && params.length > 0) return adapt(await pg.query(sql, params), sql);
    if (/;\s*\S/.test(String(sql).trim())) return adapt(await pg.exec(sql), sql);
    return adapt(await pg.query(sql), sql);
}
const db = { query: q };

const { usageForKb, usageSummary, scrubReferences, KINDS } = require('./kbUsage');

const KB = 'kb-under-test';
const OTHER = 'some-other-kb';

/**
 * The consumer tables as their stores declare them — same column names, same
 * types, trimmed to what the scans read. `agents.config` is TEXT holding JSON
 * on this table and `knowledge_base_ids` is jsonb on the rest; both shapes
 * matter, so both are reproduced.
 */
const DDL = `
CREATE TABLE agents (
    id TEXT PRIMARY KEY, name TEXT, owner_id TEXT, config TEXT DEFAULT '{}',
    updated_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE automations (
    id TEXT PRIMARY KEY, title TEXT, user_id TEXT, definition_json JSONB NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE studio_apps (
    id TEXT PRIMARY KEY, name TEXT, user_id TEXT,
    definition JSONB NOT NULL DEFAULT '{}'::jsonb, published_definition JSONB,
    updated_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE webpages (
    id TEXT PRIMARY KEY, name TEXT, user_id TEXT,
    knowledge_base_ids JSONB DEFAULT '[]'::jsonb, updated_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE projects (
    id TEXT PRIMARY KEY, name TEXT, owner_id TEXT,
    knowledge_base_ids JSONB DEFAULT '[]'::jsonb, updated_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE notebooks (
    id TEXT PRIMARY KEY, name TEXT, user_id TEXT,
    knowledge_base_ids JSONB DEFAULT '[]'::jsonb, updated_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE word_templates (
    id TEXT PRIMARY KEY, name TEXT, user_id TEXT,
    knowledge_base_ids JSONB DEFAULT '[]'::jsonb, updated_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE support_inboxes (
    id TEXT PRIMARY KEY, display_name TEXT, created_by TEXT,
    kb_ids JSONB DEFAULT '[]'::jsonb,
    kb_ingest_enabled BOOLEAN DEFAULT false, kb_ingest_kb_id UUID,
    updated_at TIMESTAMPTZ DEFAULT now());
`;

const INGEST_KB = '00000000-0000-4000-8000-00000000beef';   // kb_ingest_kb_id is UUID

async function seed() {
    const arr = JSON.stringify([KB]);
    const other = JSON.stringify([OTHER]);
    await q(`INSERT INTO agents (id, name, owner_id, config) VALUES
        ('ag1','Support assistant','u1',$1),
        ('ag2','Unrelated agent','u2',$2)`, [
        JSON.stringify({ knowledge_base_ids: [KB] }),
        JSON.stringify({ knowledge_base_ids: [OTHER] }),
    ]);
    // The id at an unknown depth, which is the whole reason for jsonb_path_exists.
    await q(`INSERT INTO automations (id, title, user_id, definition_json) VALUES
        ('au1','Weekly digest','u1',$1),
        ('au2','Unrelated routine','u2',$2)`, [
        JSON.stringify({ steps: [{ type: 'ai_step', branches: [{ steps: [{ knowledgeBaseIds: [KB] }] }] }] }),
        JSON.stringify({ steps: [{ knowledgeBaseIds: [OTHER] }] }),
    ]);
    // Only in the PUBLISHED definition: the version people actually run.
    await q(`INSERT INTO studio_apps (id, name, user_id, definition, published_definition) VALUES
        ('sa1','Intake app','u1','{}'::jsonb,$1)`, [
        JSON.stringify({ screens: [{ blocks: [{ knowledgeBaseIds: [KB] }] }] }),
    ]);
    await q(`INSERT INTO webpages (id, name, user_id, knowledge_base_ids) VALUES ('wp1','Landing','u1',$1::jsonb)`, [arr]);
    await q(`INSERT INTO projects (id, name, owner_id, knowledge_base_ids) VALUES ('pr1','Migration','u1',$1::jsonb)`, [arr]);
    await q(`INSERT INTO notebooks (id, name, user_id, knowledge_base_ids) VALUES ('nb1','Research','u1',$1::jsonb)`, [arr]);
    await q(`INSERT INTO word_templates (id, name, user_id, knowledge_base_ids) VALUES ('wt1','Offer letter','u1',$1::jsonb)`, [arr]);
    await q(`INSERT INTO support_inboxes (id, display_name, created_by, kb_ids) VALUES ('sb1','Helpdesk','u1',$1::jsonb)`, [arr]);
    await q(`INSERT INTO webpages (id, name, user_id, knowledge_base_ids) VALUES ('wp2','Other','u2',$1::jsonb)`, [other]);
}

before(async () => {
    await pg.exec(DDL);
    await seed();
});
after(async () => { await pg.close(); });

test('every scan finds its consumer — no scan is quietly matching nothing', async () => {
    const { rows, partial } = await usageForKb(KB, { db });
    assert.deepStrictEqual(partial, [], 'all eight tables exist here');

    const found = new Set(rows.map(r => r.kind));
    for (const kind of KINDS) {
        assert.ok(found.has(kind), `the ${kind} scan found nothing — check its column names`);
    }
});

test('the rows carry the Used-by shape, filled in from the real columns', async () => {
    const { rows } = await usageForKb(KB, { db });
    const agent = rows.find(r => r.kind === 'agent');
    assert.deepStrictEqual(
        { kind: agent.kind, id: agent.id, title: agent.title, role: agent.role, ownerId: agent.ownerId },
        { kind: 'agent', id: 'ag1', title: 'Support assistant', role: 'chat', ownerId: 'u1' },
    );
    assert.ok(agent.lastAt, 'updated_at came through as lastAt');

    // The two that a `name AS title` / `title` mix-up would have blanked.
    assert.strictEqual(rows.find(r => r.kind === 'automation').title, 'Weekly digest');
    assert.strictEqual(rows.find(r => r.kind === 'notebook').title, 'Research');
    // The two whose owner column is owner_id, not user_id.
    assert.strictEqual(rows.find(r => r.kind === 'project').ownerId, 'u1');
    assert.strictEqual(agent.ownerId, 'u1');
});

test('a consumer of a DIFFERENT base is not reported', async () => {
    const { rows } = await usageForKb(KB, { db });
    const ids = rows.map(r => r.id);
    assert.ok(!ids.includes('ag2'));
    assert.ok(!ids.includes('au2'));
    assert.ok(!ids.includes('wp2'));
});

test('an app is found through its published definition alone', async () => {
    const { rows } = await usageForKb(KB, { db });
    const app = rows.find(r => r.kind === 'app');
    assert.strictEqual(app.id, 'sa1', 'the working definition is {} — only the published one names it');
});

test('an id carrying a quote is bound, not parsed as jsonpath', async () => {
    // The injection this shape exists to prevent: concatenated, the quote
    // would close the string literal inside the path.
    await assert.doesNotReject(() => usageForKb('kb" ? (@ == "x', { db }));
    const { rows } = await usageForKb('kb" ? (@ == "x', { db });
    assert.deepStrictEqual(rows, [], 'and it matches nothing, rather than everything');
});

test('an inbox that DISTILS tickets into a base depends on it too', async () => {
    // A scalar column, not an array — missed entirely by an @> scan. The
    // inbox keeps running and every distilled ticket lands nowhere.
    await q(`INSERT INTO support_inboxes (id, display_name, created_by, kb_ingest_enabled, kb_ingest_kb_id)
             VALUES ('sb2','Sales inbox','u3',true,$1::uuid)`, [INGEST_KB]);
    const { rows } = await usageForKb(INGEST_KB, { db });
    const row = rows.find(r => r.kind === 'support');
    assert.ok(row, 'the ingest target is usage');
    assert.strictEqual(row.id, 'sb2');
    assert.strictEqual(row.role, 'ingest_target', 'and it reads differently from an answer source');
});

test('the summary counts the same consumers the detail scan finds', async () => {
    const out = await usageSummary([KB, OTHER], { db });
    for (const kind of KINDS) {
        assert.ok(out[KB].counts[kind] >= 1, `summary missed ${kind}`);
    }
    assert.deepStrictEqual(out[KB].partial, []);
    assert.deepStrictEqual(out[OTHER].counts, { agent: 1, automation: 1, webpage: 1 });
});

test('scrub removes the id from every array, and leaves the others intact', async () => {
    const before = await usageForKb(KB, { db });
    assert.ok(before.rows.length >= KINDS.length);

    const out = await scrubReferences(KB, { db });
    assert.strictEqual(out.agent, 1);
    assert.strictEqual(out.project, 1);
    assert.strictEqual(out.support, 1);

    const after_ = await usageForKb(KB, { db });
    const kinds = new Set(after_.rows.map(r => r.kind));
    assert.ok(!kinds.has('agent'), 'the agent no longer names it');
    assert.ok(!kinds.has('webpage'));
    assert.ok(!kinds.has('project'));
    assert.ok(!kinds.has('notebook'));
    assert.ok(!kinds.has('template'));

    // Deliberately untouched — rewriting arbitrary definition JSON in place
    // risks corrupting a routine somebody spent an afternoon building.
    assert.ok(kinds.has('automation'));
    assert.ok(kinds.has('app'));

    // And the other base's consumers were not collateral.
    const other = await usageForKb(OTHER, { db });
    assert.ok(other.rows.some(r => r.id === 'ag2'));
    assert.ok(other.rows.some(r => r.id === 'wp2'));

    // The agent keeps its config; only the id left.
    const cfg = (await q(`SELECT config FROM agents WHERE id = 'ag1'`)).rows[0].config;
    assert.deepStrictEqual(JSON.parse(cfg).knowledge_base_ids, []);
});

test('scrubbing an ingest target switches the ingest off with it', async () => {
    // A null target with the flag still on is the silent version of the same
    // breakage: the routine runs and writes nowhere.
    await scrubReferences(INGEST_KB, { db });
    const row = (await q(`SELECT kb_ingest_enabled, kb_ingest_kb_id FROM support_inboxes WHERE id = 'sb2'`)).rows[0];
    assert.strictEqual(row.kb_ingest_kb_id, null);
    assert.strictEqual(row.kb_ingest_enabled, false);
});
