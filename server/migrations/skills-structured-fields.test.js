/**
 * skills-structured-fields — idempotent, dry-run writes nothing, only NULL
 * facets are filled, the text columns are never touched.
 *
 * On a real Postgres: PGlite behind db.js's pool (testUtils/pglitePool.js),
 * over the text columns of a pre-structure `skills` table.
 *
 * Run: node --test migrations/skills-structured-fields.test.js
 */

const { test, beforeEach } = require('node:test');
const { usePglitePool } = require('../testUtils/pglitePool');
const { insertRow } = require('../testUtils/pgliteSeed');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

process.env.NODE_ENV = 'test';

const { pg, close } = usePglitePool();
test.after(close);

const mig = require('./skills-structured-fields');
const SRC = fs.readFileSync(path.join(__dirname, 'skills-structured-fields.js'), 'utf8');

const skill = (id, over = {}) => ({
    id, name: `Skill ${id}`,
    workflow: '1. Read\n2. Write', rules: 'Be brief. Never guess.', examples: 'Input: q\nOutput: a',
    ...over,
});
/** Seed skill rows, in creation order. */
async function seed(...rows) {
    let t = 0;
    for (const r of rows) await insertRow(pg, 'skills', { created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, t++)).toISOString(), ...r });
}
const rows = async () => (await pg.query('SELECT * FROM skills ORDER BY created_at')).rows;

/** The statements db.js sends while `fn` runs. */
async function recordStatements(fn, after = async () => {}) {
    const db = require('../db');
    const saved = db.pool.query;
    const sent = [];
    db.pool.query = async (sql, params) => {
        sent.push(String(sql).trim());
        const out = await saved(sql, params);
        if (/^SELECT id, name, workflow/.test(String(sql).trim())) await after();
        return out;
    };
    try { return { result: await fn(), sent }; } finally { db.pool.query = saved; }
}

beforeEach(async () => {
    await pg.exec(`DROP TABLE IF EXISTS skills;
        CREATE TABLE skills (id TEXT PRIMARY KEY, name TEXT, workflow TEXT, rules TEXT, examples TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`);
});

test('the columns are added idempotently (both replicas may run this), never renamed or retyped', async () => {
    await mig.up({ log: () => {} });
    await mig.up({ log: () => {} });
    const { rows: cols } = await pg.query(`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_name = 'skills' ORDER BY ordinal_position`);
    const by = Object.fromEntries(cols.map(c => [c.column_name, `${c.data_type} ${c.is_nullable} ${c.column_default}`]));
    assert.deepStrictEqual(by, {
        id: 'text NO null', name: 'text YES null', workflow: 'text YES null', rules: 'text YES null', examples: 'text YES null',
        created_at: 'timestamp with time zone YES now()',
        steps: 'jsonb YES null', rules_v2: 'jsonb YES null', examples_v2: 'jsonb YES null',
        version: 'integer NO 1',
        knowledge_base_ids: "jsonb NO '[]'::jsonb", allowed_automation_ids: "jsonb NO '[]'::jsonb",
        last_used_at: 'timestamp with time zone YES null', output_schema: 'jsonb YES null',
    });
    assert.doesNotMatch(SRC, /RENAME|DROP COLUMN|ALTER COLUMN .* TYPE/, 'never rename or retype in place');
});

test('a text-only skill gets all three facets parsed; the text columns are untouched', async () => {
    await seed(skill('s1'));
    const r = await mig.up({ log: () => {} });
    assert.deepStrictEqual({ scanned: r.scanned, updated: r.updated }, { scanned: 1, updated: 1 });
    const [row] = await rows();
    assert.deepStrictEqual(row.steps.map(s => s.text), ['Read', 'Write']);
    assert.deepStrictEqual(row.rules_v2.map(x => [x.text, x.polarity]), [['Be brief.', 'must'], ['Never guess.', 'never']]);
    assert.strictEqual(row.examples_v2[0].question, 'q');
    assert.deepStrictEqual([row.workflow, row.rules, row.examples], ['1. Read\n2. Write', 'Be brief. Never guess.', 'Input: q\nOutput: a'], 'original text kept');
});

test('a facet filled between the SELECT and the UPDATE keeps what the person wrote', async () => {
    await seed(skill('s1'));
    const mine = [{ id: 'mine', text: 'Written in Studio', refs: [] }];
    await recordStatements(() => mig.up({ log: () => {} }), async () => {
        await pg.query('UPDATE skills SET steps = $1::jsonb WHERE id = $2', [JSON.stringify(mine), 's1']);
    });
    const [row] = await rows();
    assert.deepStrictEqual(row.steps, mine);
    assert.strictEqual(row.rules_v2.length, 2, 'the other facets are still filled');
});

test('re-running is a no-op: the second run selects nothing and writes nothing', async () => {
    await seed(skill('s1'), skill('s2', { workflow: '', rules: '', examples: '' }));
    await mig.up({ log: () => {} });
    assert.deepStrictEqual((await rows())[1].steps, [], 'empty text parses to [] — visited once, never again');
    const { result: r, sent } = await recordStatements(() => mig.up({ log: () => {} }));
    assert.deepStrictEqual({ scanned: r.scanned, updated: r.updated }, { scanned: 0, updated: 0 });
    assert.ok(!sent.some(s => s.startsWith('UPDATE')), 'no UPDATE on the second run');
});

test('only the NULL facets of a partially-structured row are filled', async () => {
    await mig.up({ log: () => {} });
    await seed(skill('s1', { steps: [{ id: 'keep', text: 'Studio-made', refs: [] }] }));
    await mig.up({ log: () => {} });
    const [row] = await rows();
    assert.deepStrictEqual(row.steps, [{ id: 'keep', text: 'Studio-made', refs: [] }]);
    assert.strictEqual(row.rules_v2.length, 2);
    const plan = mig.planRow(skill('x', { steps: null, rules_v2: [], examples_v2: [] }));
    assert.deepStrictEqual(Object.keys(plan), ['steps']);
});

test('--dry-run writes nothing: no columns, no UPDATE, and it logs the plan per row', async () => {
    await mig.up({ log: () => {} });
    await seed(skill('s1'));
    const lines = [];
    const r = await mig.up({ dryRun: true, log: (m) => lines.push(m) });
    assert.strictEqual(r.dryRun, true);
    assert.strictEqual((await rows())[0].steps, null, 'dry run must not UPDATE');
    assert.ok(lines.some(l => /would parse skill s1 .*steps=2 rules_v2=2 examples_v2=1/.test(l)), lines.join('\n'));
    assert.match(SRC, /process\.argv\.includes\('--dry-run'\)/, 'the CLI honours --dry-run');
});

test('--dry-run on a database without the columns adds none and says what the real run would do', async () => {
    await seed(skill('s1'));
    const lines = [];
    const r = await mig.up({ dryRun: true, log: (m) => lines.push(m) });
    assert.deepStrictEqual(r, { scanned: 0, updated: 0, dryRun: true });
    const { rows: cols } = await pg.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'skills' AND column_name = 'steps'");
    assert.strictEqual(cols.length, 0, 'dry run must not add columns');
    assert.ok(lines.some(l => /structured columns do not exist yet/.test(l)), lines.join('\n'));
});

test('it exports up() and is registered from the skill store, never from startupTasks', () => {
    assert.strictEqual(typeof mig.up, 'function');
    assert.match(SRC, /require\.main === module/);
    // The skill store's initDB lives in stores/skill/schema.js (skillStore.js re-exports it).
    const store = fs.readFileSync(path.join(__dirname, '..', 'stores', 'skill', 'schema.js'), 'utf8');
    assert.match(store, /require\('\.\.\/\.\.\/migrations\/skills-structured-fields'\)/, 'an unregistered migration never runs');
});
