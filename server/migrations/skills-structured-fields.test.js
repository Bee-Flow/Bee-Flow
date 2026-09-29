/**
 * skills-structured-fields — idempotent, dry-run writes nothing, only NULL
 * facets are filled, the text columns are never touched.
 *
 * DB-free: ../db is stubbed via require.cache with an in-memory `skills`
 * table so the SELECT/UPDATE pair is exercised for real.
 *
 * Run: node --test --test-force-exit migrations/skills-structured-fields.test.js
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

process.env.NODE_ENV = 'test';

let table = [];
const calls = [];
const dbPath = require.resolve('../db');
require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: {
        exec: async (sql) => { calls.push({ kind: 'exec', sql }); },
        getAll: async (sql, params = []) => {
            calls.push({ kind: 'getAll', sql, params });
            return table.filter(r => r.steps === null || r.rules_v2 === null || r.examples_v2 === null).map(r => ({ ...r }));
        },
        run: async (sql, params = []) => {
            calls.push({ kind: 'run', sql, params });
            const row = table.find(r => r.id === params[0]);
            if (!row) return { rowCount: 0 };
            if (row.steps === null) row.steps = JSON.parse(params[1]);
            if (row.rules_v2 === null) row.rules_v2 = JSON.parse(params[2]);
            if (row.examples_v2 === null) row.examples_v2 = JSON.parse(params[3]);
            return { rowCount: 1 };
        },
    },
};

const mig = require('./skills-structured-fields');
const SRC = fs.readFileSync(path.join(__dirname, 'skills-structured-fields.js'), 'utf8');

const skill = (id, over = {}) => ({
    id, name: `Skill ${id}`,
    workflow: '1. Read\n2. Write', rules: 'Be brief. Never guess.', examples: 'Input: q\nOutput: a',
    steps: null, rules_v2: null, examples_v2: null,
    ...over,
});

beforeEach(() => { table = []; calls.length = 0; });

test('the columns are added with ADD COLUMN IF NOT EXISTS (both replicas may run this)', () => {
    for (const col of ['steps JSONB', 'rules_v2 JSONB', 'examples_v2 JSONB', 'version INTEGER NOT NULL DEFAULT 1', "knowledge_base_ids JSONB NOT NULL DEFAULT '[]'::jsonb", "allowed_automation_ids JSONB NOT NULL DEFAULT '[]'::jsonb", 'last_used_at TIMESTAMPTZ', 'output_schema JSONB']) {
        assert.ok(mig.COLUMNS_SQL.includes(`ADD COLUMN IF NOT EXISTS ${col}`), `missing ${col}`);
    }
    assert.doesNotMatch(SRC, /RENAME|DROP COLUMN|ALTER COLUMN .* TYPE/, 'never rename or retype in place');
});

test('a text-only skill gets all three facets parsed; the text columns are untouched', async () => {
    table = [skill('s1')];
    const r = await mig.up({ log: () => {} });
    assert.deepStrictEqual({ scanned: r.scanned, updated: r.updated }, { scanned: 1, updated: 1 });
    const row = table[0];
    assert.deepStrictEqual(row.steps.map(s => s.text), ['Read', 'Write']);
    assert.deepStrictEqual(row.rules_v2.map(x => [x.text, x.polarity]), [['Be brief.', 'must'], ['Never guess.', 'never']]);
    assert.strictEqual(row.examples_v2[0].question, 'q');
    assert.strictEqual(row.workflow, '1. Read\n2. Write', 'original text kept');
    const upd = calls.find(c => c.kind === 'run');
    assert.doesNotMatch(upd.sql, /workflow\s*=|rules\s*=|examples\s*=/, 'the UPDATE never writes a text column');
    assert.match(upd.sql, /COALESCE\(steps, \$2::jsonb\)/, 'a facet filled meanwhile keeps what the person wrote');
});

test('re-running is a no-op: the second run selects nothing and writes nothing', async () => {
    table = [skill('s1'), skill('s2', { workflow: '', rules: '', examples: '' })];
    await mig.up({ log: () => {} });
    assert.deepStrictEqual(table[1].steps, [], 'empty text parses to [] — visited once, never again');
    calls.length = 0;
    const r = await mig.up({ log: () => {} });
    assert.deepStrictEqual({ scanned: r.scanned, updated: r.updated }, { scanned: 0, updated: 0 });
    assert.strictEqual(calls.filter(c => c.kind === 'run').length, 0);
});

test('only the NULL facets of a partially-structured row are filled', async () => {
    table = [skill('s1', { steps: [{ id: 'keep', text: 'Studio-made', refs: [] }] })];
    await mig.up({ log: () => {} });
    assert.deepStrictEqual(table[0].steps, [{ id: 'keep', text: 'Studio-made', refs: [] }]);
    assert.strictEqual(table[0].rules_v2.length, 2);
    const plan = mig.planRow(skill('x', { rules_v2: [], examples_v2: [] }));
    assert.deepStrictEqual(Object.keys(plan), ['steps']);
});

test('--dry-run writes nothing: no columns, no UPDATE, and it logs the plan per row', async () => {
    table = [skill('s1')];
    const lines = [];
    const r = await mig.up({ dryRun: true, log: (m) => lines.push(m) });
    assert.strictEqual(r.dryRun, true);
    assert.strictEqual(calls.filter(c => c.kind === 'exec').length, 0, 'dry run must not add columns');
    assert.strictEqual(calls.filter(c => c.kind === 'run').length, 0, 'dry run must not UPDATE');
    assert.strictEqual(table[0].steps, null);
    assert.ok(lines.some(l => /would parse skill s1 .*steps=2 rules_v2=2 examples_v2=1/.test(l)), lines.join('\n'));
    assert.match(SRC, /process\.argv\.includes\('--dry-run'\)/, 'the CLI honours --dry-run');
});

test('it exports up() and is registered from the skill store, never from startupTasks', () => {
    assert.strictEqual(typeof mig.up, 'function');
    assert.match(SRC, /require\.main === module/);
    const store = fs.readFileSync(path.join(__dirname, '..', 'stores', 'skillStore.js'), 'utf8');
    assert.match(store, /migrations\/skills-structured-fields/, 'an unregistered migration never runs');
});
