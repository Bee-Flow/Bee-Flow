/**
 * "What breaks if I delete this?"
 *
 * The answer feeds a delete confirmation, so the failure that matters is the
 * one where NOT KNOWING is reported as NOTHING. A missing consumer table, a
 * query that errored — either would otherwise make the dialog say "nothing
 * depends on this" about a knowledge base three agents are using, and the
 * person would believe it, because they asked.
 *
 * The scans and the scrub run on a real Postgres: the boot ladder's schema on
 * PGlite (testUtils/pgliteTemplate.js), handed in through the `db` seam.
 *
 * Run: node --test core/kb/kbUsage.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { ladderPglite } = require('../../testUtils/pgliteTemplate');
const { pgliteQuery } = require('../../testUtils/pglitePool');
const { insertRow } = require('../../testUtils/pgliteSeed');
const { hideTable, failReads } = require('../../testUtils/pgliteFaults');
const { usageForKb, usageSummary, scrubReferences } = require('./kbUsage');

// A knowledge base id is a uuid (support_inboxes.kb_ingest_kb_id holds one).
const KB1 = '6f1c2a4e-0b7d-4c1e-9a3f-2d5e8b9c0a11';
const S1 = '0e9a7b51-3c2d-4e6f-8a1b-5c4d3e2f1a01';
const S2 = '0e9a7b51-3c2d-4e6f-8a1b-5c4d3e2f1a02';

const pg = ladderPglite();
const queries = [];
const run = pgliteQuery(pg);
/** The `db` seam: real statements, recorded so "no work" is a fact. */
const db = { query: (sql, params) => { if (!/to_regclass/.test(sql)) queries.push(sql); return run(sql, params); } };
test.after(() => pg.close());
test.beforeEach(async () => {
    await pg.exec('TRUNCATE agents, automations, studio_apps, webpages, projects, notebooks, word_templates, support_inboxes CASCADE');
    queries.length = 0;
});

const agent = (id, kbIds, over = {}) => insertRow(pg, 'agents', { id, name: id, owner_id: 'u1', config: JSON.stringify({ knowledge_base_ids: kbIds }), ...over });
const kbIdsOf = async (table, id, col = 'knowledge_base_ids') => (await pg.query(`SELECT ${col} AS v FROM ${table} WHERE id = $1`, [id])).rows[0].v;

/** One consumer of kb1 of every kind, plus one that uses another base. */
async function everyKind() {
    await agent('ag1', [KB1], { name: 'Support assistant', updated_at: '2026-09-01T00:00:00Z' });
    await agent('ag-other', ['kb2']);
    await insertRow(pg, 'automations', { id: 'au1', user_id: 'u1', title: 'Flow', definition_json: { steps: [{ type: 'ai_step', config: { knowledgeBaseIds: [KB1] } }] } });
    await insertRow(pg, 'studio_apps', { id: 'app1', user_id: 'u1', name: 'App', definition: {}, published_definition: { screens: [{ blocks: [{ knowledgeBaseIds: [KB1] }] }] } });
    await insertRow(pg, 'webpages', { id: 'w1', user_id: 'u1', name: 'Page', knowledge_base_ids: [KB1] });
    await insertRow(pg, 'projects', { id: 'p1', name: 'Project', owner_id: 'u1', knowledge_base_ids: [KB1, 'kb2'] });
    await insertRow(pg, 'notebooks', { id: 'n1', user_id: 'u1', name: 'Notebook', knowledge_base_ids: [KB1] });
    await insertRow(pg, 'word_templates', { id: 't1', user_id: 'u1', name: 'Template', storage_key: 'k', knowledge_base_ids: [KB1] });
    await insertRow(pg, 'support_inboxes', { id: S1, display_name: 'Inbox', created_by: 'u1', organization_id: 'org1', provider: 'gmail', kb_ids: [KB1] });
    await insertRow(pg, 'support_inboxes', { id: S2, display_name: 'Ingest', created_by: 'u1', organization_id: 'org1', provider: 'gmail', kb_ids: [], kb_ingest_kb_id: KB1, kb_ingest_enabled: true });
}

test('finds every kind of consumer, with the Used-by row shape', async () => {
    await everyKind();
    const { rows, partial } = await usageForKb(KB1, { db });
    assert.deepStrictEqual(partial, []);
    assert.deepStrictEqual(rows.map((r) => [r.kind, r.id, r.role]), [
        ['agent', 'ag1', 'chat'], ['automation', 'au1', 'ai_step'], ['app', 'app1', 'answer_block'],
        ['webpage', 'w1', 'chat'], ['project', 'p1', 'contains'], ['notebook', 'n1', 'contains'],
        ['template', 't1', 'contains'], ['support', S1, 'chat'], ['support', S2, 'ingest_target'],
    ]);
    const ag = rows[0];
    assert.strictEqual(ag.title, 'Support assistant');
    assert.strictEqual(ag.ownerId, 'u1');
    assert.strictEqual(new Date(ag.lastAt).toISOString(), '2026-09-01T00:00:00.000Z');
});

test('an agent whose config is empty text does not make the agent scan unanswerable', async () => {
    await agent('ag1', [KB1]);
    await insertRow(pg, 'agents', { id: 'ag-blank', name: 'Blank', owner_id: 'u1', config: '' });
    const { rows, partial } = await usageForKb(KB1, { db });
    assert.deepStrictEqual(partial, []);
    assert.deepStrictEqual(rows.map((r) => r.id), ['ag1']);
});

test('a consumer table that does not exist is PARTIAL, never zero', async () => {
    // "The apps table is not on this install" is not the same statement as
    // "no app uses this", and only one of them is safe to delete on.
    const restore = await hideTable(pg, 'studio_apps');
    try {
        const { rows, partial } = await usageForKb(KB1, { db });
        assert.deepStrictEqual(rows, []);
        assert.deepStrictEqual(partial, ['app']);
    } finally { await restore(); }
});

test('a query that fails is PARTIAL too, and does not abandon the rest', async () => {
    await everyKind();
    const restore = await failReads(pg, 'automations', '57014', 'canceling statement due to statement timeout');
    try {
        const { rows, partial } = await usageForKb(KB1, { db });
        assert.deepStrictEqual(partial, ['automation']);
        assert.strictEqual(rows.length, 8, 'the other seven kinds were still asked');
    } finally { await restore(); }
});

test('the id reaches jsonpath as a VARIABLE: a quote in it is a character, not path syntax', async () => {
    // A kb id is a route parameter. Concatenated, a value carrying a quote
    // would close the string literal inside the jsonpath and be parsed as
    // path syntax.
    const odd = 'kb" || @ != "x';
    await insertRow(pg, 'automations', { id: 'au-odd', user_id: 'u1', title: 'Odd', definition_json: { a: { knowledgeBaseIds: [odd] } } });
    await insertRow(pg, 'automations', { id: 'au-plain', user_id: 'u1', title: 'Plain', definition_json: { a: { knowledgeBaseIds: [KB1] } } });
    const hit = await usageForKb(odd, { db });
    assert.deepStrictEqual(hit.partial, []);
    assert.deepStrictEqual(hit.rows.filter((r) => r.kind === 'automation').map((r) => r.id), ['au-odd']);
    assert.deepStrictEqual((await usageForKb('kb"1', { db })).rows, [], 'a stray quote matches nothing and breaks nothing');
});

test('an app is found through its PUBLISHED definition, not only its draft', async () => {
    // An app that uses the base only in the version people actually run still
    // breaks when it goes.
    await insertRow(pg, 'studio_apps', { id: 'draft', user_id: 'u1', name: 'D', definition: { x: { knowledgeBaseIds: [KB1] } }, published_definition: null });
    await insertRow(pg, 'studio_apps', { id: 'published', user_id: 'u1', name: 'P', definition: {}, published_definition: { x: { knowledgeBaseIds: [KB1] } } });
    await insertRow(pg, 'studio_apps', { id: 'neither', user_id: 'u1', name: 'N', definition: { x: { knowledgeBaseIds: ['kb2'] } } });
    const { rows } = await usageForKb(KB1, { db });
    assert.deepStrictEqual(rows.map((r) => r.id).sort(), ['draft', 'published']);
});

test('no id is no work', async () => {
    assert.deepStrictEqual(await usageForKb(null, { db }), { rows: [], partial: [] });
    assert.deepStrictEqual(await usageForKb('', { db }), { rows: [], partial: [] });
    assert.strictEqual(queries.length, 0);
});

// ── usageSummary ───────────────────────────────────────────────────────

test('summary: counts per kind, per knowledge base; a kind with no count is absent rather than zero', async () => {
    await agent('a', [KB1]);
    await agent('b', [KB1, 'kb3']);
    await agent('c', [KB1]);
    await insertRow(pg, 'webpages', { id: 'w', user_id: 'u1', name: 'W', knowledge_base_ids: [KB1] });
    const out = await usageSummary([KB1, 'kb2'], { db });
    assert.deepStrictEqual(out[KB1].counts, { agent: 3, webpage: 1 });
    // The overview renders a pill per entry; a zero would draw "0 agents".
    assert.deepStrictEqual(out.kb2.counts, {}, 'a base nothing uses counts nothing');
    assert.deepStrictEqual(Object.keys(out).sort(), [KB1, 'kb2'].sort(), 'every requested id gets an entry');
});

test('summary: a missing table is partial here too', async () => {
    const restore = await hideTable(pg, 'studio_apps');
    try {
        const out = await usageSummary([KB1], { db });
        assert.deepStrictEqual(out[KB1].partial, ['app']);
    } finally { await restore(); }
});

test('summary: nothing in, nothing asked', async () => {
    assert.deepStrictEqual(await usageSummary([], { db }), {});
    assert.strictEqual(queries.length, 0);
});

// ── scrubReferences ────────────────────────────────────────────────────

test('every array-shaped reference is removed, other ids stay', async () => {
    await everyKind();
    const out = await scrubReferences(KB1, { db });
    assert.deepStrictEqual(out, { agent: 1, automation: 0, app: 0, webpage: 1, project: 1, notebook: 1, template: 1, support: 2 });
    assert.deepStrictEqual(JSON.parse((await pg.query(`SELECT config FROM agents WHERE id = 'ag1'`)).rows[0].config).knowledge_base_ids, []);
    assert.deepStrictEqual(JSON.parse((await pg.query(`SELECT config FROM agents WHERE id = 'ag-other'`)).rows[0].config).knowledge_base_ids, ['kb2']);
    assert.deepStrictEqual(await kbIdsOf('projects', 'p1'), ['kb2'], 'the other base stays attached');
    for (const [t, id] of [['webpages', 'w1'], ['notebooks', 'n1'], ['word_templates', 't1']]) assert.deepStrictEqual(await kbIdsOf(t, id), [], t);
    assert.deepStrictEqual(await kbIdsOf('support_inboxes', S1, 'kb_ids'), []);
    // The ingest target is a scalar: cleared, and the ingest switched off with it.
    const ingest = (await pg.query(`SELECT kb_ingest_kb_id, kb_ingest_enabled FROM support_inboxes WHERE id = $1`, [S2])).rows[0];
    assert.deepStrictEqual(ingest, { kb_ingest_kb_id: null, kb_ingest_enabled: false });
    assert.deepStrictEqual((await usageForKb(KB1, { db })).rows.map((r) => r.kind), ['automation', 'app'], 'what is left is what is not rewritten');
});

test('an agent whose config is empty text does not stop the other agents from being scrubbed', async () => {
    await agent('ag1', [KB1]);
    await insertRow(pg, 'agents', { id: 'ag-blank', name: 'Blank', owner_id: 'u1', config: '' });
    const out = await scrubReferences(KB1, { db });
    assert.strictEqual(out.agent, 1);
    assert.deepStrictEqual(JSON.parse((await pg.query(`SELECT config FROM agents WHERE id = 'ag1'`)).rows[0].config).knowledge_base_ids, []);
    assert.strictEqual((await pg.query(`SELECT config FROM agents WHERE id = 'ag-blank'`)).rows[0].config, '', 'the blank row is left as it was');
});

test('one consumer failing does not abandon the others', async () => {
    // The base is going either way, and a half-scrubbed install is the
    // worst of the three outcomes.
    await everyKind();
    const restore = await failReads(pg, 'projects', '55P03', 'lock not available');
    try {
        const out = await scrubReferences(KB1, { db });
        assert.strictEqual(out.project, 0);
        assert.strictEqual(out.webpage, 1, 'the rest still ran');
    } finally { await restore(); }
    assert.deepStrictEqual(await kbIdsOf('webpages', 'w1'), []);
});

test('a table that is not installed is skipped, not an error', async () => {
    await agent('ag1', [KB1]);
    const restore = await hideTable(pg, 'webpages');
    try {
        const out = await scrubReferences(KB1, { db });
        assert.strictEqual(out.agent, 1);
        assert.strictEqual(out.webpage, 0);
    } finally { await restore(); }
});

test('automations and apps are deliberately NOT rewritten', async () => {
    // The id sits at an unknown depth inside a definition that also encodes
    // the shape of a canvas; rewriting arbitrary JSON in place risks
    // corrupting an automation somebody spent an afternoon building.
    await everyKind();
    const before = (await pg.query(`SELECT definition_json FROM automations`)).rows;
    const beforeApp = (await pg.query(`SELECT published_definition FROM studio_apps`)).rows;
    await scrubReferences(KB1, { db });
    assert.deepStrictEqual((await pg.query(`SELECT definition_json FROM automations`)).rows, before);
    assert.deepStrictEqual((await pg.query(`SELECT published_definition FROM studio_apps`)).rows, beforeApp);
});

test('scrub: no id is no work', async () => {
    await scrubReferences(null, { db });
    assert.strictEqual(queries.length, 0);
});
