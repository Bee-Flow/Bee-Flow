/**
 * The agent-routines → cowork move: the same four statements as the prompt-task
 * move (pinned in prompt-tasks-to-cowork-2026-08.test.js), aimed at the rows
 * that one left behind.
 *
 * Run: node --test server/migrations/agent-tasks-to-cowork-2026-10.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ops = [];
const norm = (sql) => String(sql).replace(/\s+/g, ' ').trim();
const fakeDb = {
    async exec() {},
    async run(sql) { ops.push(norm(sql)); return { rowCount: 0, rows: [] }; },
    async getOne(sql, params = []) { return norm(sql).includes('to_regclass') ? { oid: params[0] } : null; },
    async getAll() { return []; },
    pool: { query: async () => ({ rows: [], rowCount: 0 }) },
};
const dbPath = path.join(__dirname, '..', 'db.js');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };
for (const store of ['coworkStore', 'aiTaskStore']) {
    const p = path.join(__dirname, '..', 'stores', `${store}.js`);
    require.cache[p] = { id: p, filename: p, loaded: true, exports: {} };
}

const { up, AGENT_TASK } = require('./agent-tasks-to-cowork-2026-10');
const { PLAIN_TASK } = require('./prompt-tasks-to-cowork-2026-08');

test('moves exactly the agent-linked rows: every statement is scoped to them, never to the plain ones', async () => {
    await up();
    const scoped = ops.filter((q) => q.includes('FROM ai_tasks t') || q.startsWith('UPDATE ai_tasks t'));
    assert.strictEqual(scoped.length, 4, 'copy, seed history, pause, stamp');
    for (const q of scoped) {
        assert.ok(q.includes(norm(AGENT_TASK)), q);
    }
    assert.strictEqual(AGENT_TASK, `NOT ${PLAIN_TASK}`);
});

test('ids are carried and the stamp keeps a deleted cowork twin from coming back', () => {
    const copy = ops.find((q) => q.startsWith('INSERT INTO cowork_schedules'));
    assert.match(copy, /SELECT t\.id,/);
    assert.match(copy, /t\.migrated_to_cowork_at IS NULL/);
});
