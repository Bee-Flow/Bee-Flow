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
 * PGlite (./kbUsage.testkit.js), handed in through the `db` seam. The scans of
 * a module's kind are tested next to its part (core/kb/usage/<module>.test.js);
 * the two tests over every kind hold for the kinds of this installation.
 *
 * Run: node --test core/kb/kbUsage.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { hideTable, failReads } = require('../../testUtils/pgliteFaults');
const { usageForKb, usageSummary, scrubReferences } = require('./kbUsage');
const k = require('./kbUsage.testkit');

const { pg, db, queries, KB1, S1, S2, agent, kbIdsOf, everyKind, insertRow } = k;
k.useKbUsageDb(test);

/** The Used-by rows of everyKind(), in order, for the kinds of this installation. */
const EVERY_ROW = [
    ['agent', 'ag1', 'chat'], ['automation', 'au1', 'ai_step'], ['app', 'app1', 'answer_block'],
    ['webpage', 'w1', 'chat'], ['project', 'p1', 'contains'], ['notebook', 'n1', 'contains'],
    ['template', 't1', 'contains'], ['support', S1, 'chat'], ['support', S2, 'ingest_target'],
];

// About the composition: every kind of the core, and every kind of each module that is here.
test('finds every kind of consumer, with the Used-by row shape', async () => {
    await everyKind();
    const { rows, partial } = await usageForKb(KB1, { db });
    assert.deepStrictEqual(partial, []);
    assert.deepStrictEqual(rows.map((r) => [r.kind, r.id, r.role]), EVERY_ROW.filter(([kind]) => k.kinds().includes(kind)));
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

test('a core consumer table that does not exist is PARTIAL, never zero', async () => {
    const restore = await hideTable(pg, 'notebooks');
    try {
        const { rows, partial } = await usageForKb(KB1, { db });
        assert.deepStrictEqual(rows, []);
        assert.deepStrictEqual(partial, ['notebook']);
    } finally { await restore(); }
});

test('a core query that fails is PARTIAL too, and does not abandon the rest', async () => {
    await agent('ag1', [KB1]);
    await insertRow(pg, 'notebooks', { id: 'n1', user_id: 'u1', name: 'Notebook', knowledge_base_ids: [KB1] });
    const restore = await failReads(pg, 'projects', '57014', 'canceling statement due to statement timeout');
    try {
        const { rows, partial } = await usageForKb(KB1, { db });
        assert.deepStrictEqual(partial, ['project']);
        assert.deepStrictEqual(rows.map((r) => r.id), ['ag1', 'n1'], 'the other kinds were still asked');
    } finally { await restore(); }
});

test('a module\'s kind comes from its part, asked for by name, in its place in the order', async () => {
    const registry = require('../featureModules');
    const name = 'core/kb/usage/templates';
    registry.optionalFeatureModule(name);
    const previous = registry._featureModuleGetter(name);
    const scan = { table: 'projects', sql: `SELECT id, name AS title, owner_id, updated_at AS last_at FROM projects WHERE knowledge_base_ids @> $1::jsonb`, params: (id) => [JSON.stringify([id])], role: 'double' };
    registry.registerFeatureModules({ [name]: () => ({ SCANS: { template: scan } }) });
    try {
        await insertRow(pg, 'projects', { id: 'p1', name: 'Project', owner_id: 'u1', knowledge_base_ids: [KB1] });
        const { rows } = await usageForKb(KB1, { db });
        assert.deepStrictEqual(rows.map((r) => [r.kind, r.role]), [['project', 'contains'], ['template', 'double']]);
    } finally {
        if (previous) registry.registerFeatureModules({ [name]: previous });
        else registry._clearFeatureModulesForTests(name);
    }
});

test('no id is no work', async () => {
    assert.deepStrictEqual(await usageForKb(null, { db }), { rows: [], partial: [] });
    assert.deepStrictEqual(await usageForKb('', { db }), { rows: [], partial: [] });
    assert.strictEqual(queries.length, 0);
});

// ── usageSummary ───────────────────────────────────────────────────────

test('summary: counts per core kind, per knowledge base; a kind with no count is absent rather than zero', async () => {
    await agent('a', [KB1]);
    await agent('b', [KB1, 'kb3']);
    await agent('c', [KB1]);
    await insertRow(pg, 'notebooks', { id: 'n', user_id: 'u1', name: 'N', knowledge_base_ids: [KB1] });
    const out = await usageSummary([KB1, 'kb2'], { db });
    assert.deepStrictEqual(out[KB1].counts, { agent: 3, notebook: 1 });
    assert.deepStrictEqual(out.kb2.counts, {}, 'a base nothing uses counts nothing');
    assert.deepStrictEqual(Object.keys(out).sort(), [KB1, 'kb2'].sort(), 'every requested id gets an entry');
});

test('summary: a missing core table is partial here too', async () => {
    const restore = await hideTable(pg, 'notebooks');
    try {
        const out = await usageSummary([KB1], { db });
        assert.deepStrictEqual(out[KB1].partial, ['notebook']);
    } finally { await restore(); }
});

test('summary: nothing in, nothing asked', async () => {
    assert.deepStrictEqual(await usageSummary([], { db }), {});
    assert.strictEqual(queries.length, 0);
});

// ── scrubReferences ────────────────────────────────────────────────────

/** What scrubbing everyKind() changes, per kind (automations and apps are never rewritten). */
const EVERY_SCRUB = { agent: 1, automation: 0, app: 0, webpage: 1, project: 1, notebook: 1, template: 1, support: 2 };
/** The rows whose array no longer holds kb1, per kind. */
const ARRAYS = { webpage: ['webpages', 'w1'], notebook: ['notebooks', 'n1'], template: ['word_templates', 't1'], support: ['support_inboxes', S1, 'kb_ids'] };

// About the composition: every kind of the core, and every kind of each module that is here.
test('every array-shaped reference is removed, other ids stay', async () => {
    await everyKind();
    const here = k.kinds();
    const out = await scrubReferences(KB1, { db });
    assert.deepStrictEqual(out, Object.fromEntries(Object.entries(EVERY_SCRUB).filter(([kind]) => here.includes(kind))));
    assert.deepStrictEqual(JSON.parse((await pg.query(`SELECT config FROM agents WHERE id = 'ag1'`)).rows[0].config).knowledge_base_ids, []);
    assert.deepStrictEqual(JSON.parse((await pg.query(`SELECT config FROM agents WHERE id = 'ag-other'`)).rows[0].config).knowledge_base_ids, ['kb2']);
    assert.deepStrictEqual(await kbIdsOf('projects', 'p1'), ['kb2'], 'the other base stays attached');
    for (const [kind, [t, id, col]] of Object.entries(ARRAYS)) if (here.includes(kind)) assert.deepStrictEqual(await kbIdsOf(t, id, col), [], t);
    assert.deepStrictEqual((await usageForKb(KB1, { db })).rows.map((r) => r.kind), ['automation', 'app'].filter((kind) => here.includes(kind)),
        'what is left is what is not rewritten');
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
    await insertRow(pg, 'notebooks', { id: 'n1', user_id: 'u1', name: 'Notebook', knowledge_base_ids: [KB1] });
    const restore = await failReads(pg, 'notebooks', '55P03', 'lock not available');
    let out;
    try {
        await agent('ag1', [KB1]);
        out = await scrubReferences(KB1, { db });
    } finally { await restore(); }
    assert.deepStrictEqual([out.notebook, out.agent], [0, 1], 'the notebooks failed, the agents still ran');
});

test('a table that is not installed is skipped, not an error', async () => {
    await agent('ag1', [KB1]);
    const restore = await hideTable(pg, 'notebooks');
    try {
        const out = await scrubReferences(KB1, { db });
        assert.strictEqual(out.agent, 1);
        assert.strictEqual(out.notebook, 0);
    } finally { await restore(); }
});

test('scrub: no id is no work', async () => {
    await scrubReferences(null, { db });
    assert.strictEqual(queries.length, 0);
});
