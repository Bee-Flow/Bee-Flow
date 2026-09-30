/**
 * The daily task reminder, over the real tasks table (PGlite): who is told
 * when, once per tier, never for a finished task, and again after the due date moves.
 *
 * Run: cd server && node --test jobs/projectTaskDueNotifier.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { pgliteDb } = require('../testUtils/pgliteDb');
const taskStoreModule = require('../stores/projectTaskStore');
const { run, reminderFor } = require('./projectTaskDueNotifier');

const { pg, db } = pgliteDb();
const store = taskStoreModule.makeProjectTaskStore(db);
const NOW = Date.parse('2026-10-15T09:00:00Z');
let n = 0;
const make = (extra) => store.createTask({ id: `t-${++n}`, projectId: 'p1', title: 's', description: 's', createdBy: 'ann', ...extra });

before(async () => {
    await pg.exec('CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL)');
    await pg.exec(taskStoreModule.DDL);
    await pg.query(`INSERT INTO projects (id, name, owner_id) VALUES ('p1', 'Launch', 'ann')`);
});
after(async () => { await pg.close(); });

function harness() {
    const rung = [];
    const notifier = { due: async (a) => { rung.push([a.userId, a.taskId, a.tier]); return true; } };
    return { rung, go: () => run({ query: (sql, params) => pg.query(sql, params), now: () => NOW, notifier }) };
}

test('which reminder a due date earns, once per marker', () => {
    assert.deepStrictEqual(reminderFor('2026-10-16', '2026-10-15', '2026-10-16', null), { tier: 'due_1d', marker: 'due_1d' });
    assert.deepStrictEqual(reminderFor('2026-10-15', '2026-10-15', '2026-10-16', 'due_1d'), { tier: 'due_today', marker: 'due_today' });
    assert.deepStrictEqual(reminderFor('2026-10-10', '2026-10-15', '2026-10-16', null), { tier: 'overdue', marker: 'overdue:2026-10-15' });
    assert.strictEqual(reminderFor('2026-10-10', '2026-10-15', '2026-10-16', 'overdue:2026-10-15'), null, 'once a day');
    assert.strictEqual(reminderFor('2026-10-20', '2026-10-15', '2026-10-16', null), null, 'not yet');
});

test('the people of an open task are told once per tier, and a finished or unassigned task is left alone', async () => {
    const tomorrow = await make({ assigneeIds: ['ben', 'cy'], dueDate: '2026-10-16' });
    const late = await make({ assigneeIds: ['ben'], dueDate: '2026-10-01' });
    await make({ assigneeIds: ['ben'], dueDate: '2026-10-16', status: 'done' });
    await make({ dueDate: '2026-10-16' });
    await make({ assigneeIds: ['ben'], dueDate: '2026-12-01' });
    const h = harness();
    assert.strictEqual((await h.go()).sent, 3);
    assert.deepStrictEqual(h.rung.sort(), [['ben', tomorrow.id, 'due_1d'], ['ben', late.id, 'overdue'], ['cy', tomorrow.id, 'due_1d']].sort());
    const again = harness();
    assert.strictEqual((await again.go()).sent, 0, 'the same day, nothing new');
});

test('moving the due date starts the reminders over', async () => {
    const t = await make({ assigneeIds: ['dee'], dueDate: '2026-10-16' });
    await harness().go();
    assert.strictEqual((await store.getTask('p1', t.id)).notifiedDueTier, 'due_1d');
    await store.updateTask('p1', t.id, { dueDate: '2026-10-15' });
    const h = harness();
    await h.go();
    assert.deepStrictEqual(h.rung.filter((r) => r[1] === t.id), [['dee', t.id, 'due_today']]);
});
