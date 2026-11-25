// @typecheck
/**
 * What routes/cowork.js does with a task's set-up, on the real router, use case and stores (PGlite behind db.js; only
 * the session gates are opened): a new task keeps what its owner chose on the confirmation, one that waits for its
 * steps neither starts now nor runs by hand, and the run history says how each run ended in its owner's words.
 *
 * Run: cd server && node --require ./testUtils/registerFeatures.js --test routes/cowork.setup.pg.test.js
 */

'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');

const h = require('../testUtils/routeHarness');
const { coworkStoreOnPglite } = require('../stores/coworkStore.testkit');

const { pg, store } = coworkStoreOnPglite();
h.openGates();
const api = h.serve('/api/cowork', require('./cowork'), { user: { id: 'u-setup', organizationId: null } });
after(api.close);

const BASE = { title: 'Meeting overview', prompt: 'Summarise my meetings', nextRunAt: new Date().toISOString() };
const flush = () => new Promise((resolve) => setTimeout(resolve, 50));
const runsOf = async (/** @type {string} */ id) => (await pg.query('SELECT id FROM cowork_runs WHERE schedule_id = $1', [id])).rows.length;

test('a new task keeps what its owner chose, waits for its steps, and neither starts now nor runs by hand', async () => {
    const res = await api.call('POST', '/api/cowork', { body: { ...BASE, enabledApps: ['fireflies'], startNow: true, setup: { steps: true, sendsTo: ['me', 'sam@example.com', 'SAM@example.com'] } } });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual([res.body.setup.steps, res.body.setup.sendsTo], ['wanted', { me: true, others: ['sam@example.com'] }]);
    const id = res.body.id;
    await flush();
    const item = await store.getSchedule(id);
    assert.deepStrictEqual([item?.enabledApps, item?.setup?.steps, item?.isActive, item?.prompt], [['fireflies'], 'wanted', true, BASE.prompt], 'its sentence stays as written');
    assert.strictEqual(await runsOf(id), 0, 'nothing ran before its steps are approved');

    const now = await api.call('POST', `/api/cowork/${id}/run-now`);
    assert.deepStrictEqual([now.status, now.body.code], [409, 'cowork_waits_for_steps']);
    assert.strictEqual((await api.call('GET', `/api/cowork/${id}`)).body.setup.steps, 'wanted', 'the task says so itself');
});

test('the set-up of a new task is checked: recipients are "me" or an address, and nothing unknown', async () => {
    for (const setup of [{ sendsTo: ['sam'] }, { sendsTo: ['sam@example'] }, { sendsTo: 'me' }, { steps: 'yes' }, { askFirst: 1 }, { mode: 'ai' }, { sendsTo: Array.from({ length: 22 }, (_, i) => `p${i}@example.com`) }]) {
        assert.strictEqual((await api.call('POST', '/api/cowork', { body: { ...BASE, setup } })).status, 400, JSON.stringify(setup));
    }
});

test('a task that is the AI\'s keeps who it sends to; one without a set-up has none', async () => {
    const chosen = await api.call('POST', '/api/cowork', { body: { ...BASE, nextRunAt: new Date(Date.now() + 86_400_000).toISOString(), setup: { steps: false, sendsTo: ['sam@example.com'], askFirst: false } } });
    assert.deepStrictEqual(chosen.body.setup, { steps: null, cause: null, since: null, sendsTo: { me: false, others: ['sam@example.com'] }, askFirst: false, canUndo: false });
    const plain = await api.call('POST', '/api/cowork', { body: { ...BASE, nextRunAt: new Date(Date.now() + 86_400_000).toISOString() } });
    assert.strictEqual(plain.body.setup, null);
});

test('the run history says how each run ended in its owner\'s words; the raw error stays beside it', async () => {
    const item = await store.createSchedule({ userId: 'u-setup', title: 'Friday digest', prompt: 'Summarise.', nextRunAt: new Date(Date.now() + 86_400_000).toISOString() });
    const error = 'You no longer have permission to use "no_such_tool". Ask your organisation admin to re-enable this integration, or remove the step from the automation.';
    await pg.query(`INSERT INTO cowork_runs (id, schedule_id, user_id, status, trigger_kind, started_at, finished_at, error) VALUES ('run-ok', $1, 'u-setup', 'success', 'schedule', NOW() - INTERVAL '1 hour', NOW(), NULL), ('run-bad', $1, 'u-setup', 'error', 'schedule', NOW(), NOW(), $2)`, [item?.id, error]);
    const res = await api.call('GET', `/api/cowork/${item?.id}/runs`);
    assert.deepStrictEqual(res.body.runs.map((/** @type {any} */ r) => [r.id, r.plain]), [['run-bad', 'An app this task uses is no longer allowed for this task.'], ['run-ok', null]]);
    assert.strictEqual(res.body.runs[0].error, error);
});
