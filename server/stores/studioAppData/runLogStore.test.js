'use strict';

/**
 * The run log's store against a real Postgres (PGlite), with the DDL lifted out of ./schema.js:
 * a run with a failing step keeps the error, the step and the duration per step, summed tokens
 * and cost; the step cap truncates while counters count; another actor's run key is refused; an
 * idle browser run reads as ended and can be reopened; background rows are never idle-closed;
 * the per-app ceiling prunes; the list pages and filters and never reads an e-mail address.
 *
 * Run: cd server && node --test stores/studioAppData/runLogStore.test.js
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { studioRunTableDdl } = require('../../testUtils/studioRunTables');
const { pgliteDb } = require('../../testUtils/pgliteDb');
const { makeRunLogStore } = require('./runLogStore.mts');
const { makeActionRunStore } = require('./actionRuns.mts');
const { newRunId } = require('./runPolicy.mts');

const { pg, db } = pgliteDb();
const store = makeRunLogStore(db);
const runs = makeActionRunStore(db);


before(async () => {
    await pg.exec('CREATE TABLE studio_apps (id TEXT PRIMARY KEY, user_id TEXT NOT NULL)');
    await pg.exec('CREATE TABLE users (id TEXT PRIMARY KEY, "displayName" TEXT, username TEXT, email TEXT)');
    await pg.exec(studioRunTableDdl('studio_app_action_runs'));
    await pg.exec(studioRunTableDdl('studio_app_action_run_steps'));
    await pg.query("INSERT INTO studio_apps (id, user_id) VALUES ('app_a', 'owner'), ('app_b', 'owner')");
    await pg.query(`INSERT INTO users (id, "displayName", username, email) VALUES
        ('owner', 'Olga Owner', 'olga', 'olga@example.com'), ('viewer1', NULL, 'v1@example.com', 'v1@example.com')`);
});
after(async () => { await pg.close(); });
beforeEach(async () => { await pg.query('DELETE FROM studio_app_action_runs'); });

const IDLE = { idleMs: 60_000, staleMs: 900_000 };
const meta = (over = {}) => ({
    id: newRunId(), appId: 'app_a', ownerUserId: 'owner', actionId: 'act_1', origin: 'mcp', viewerUserId: 'owner',
    draft: true, definitionVersion: 4, ...over,
});
const step = (over = {}) => ({
    actionId: 'act_1', stepIndex: 0, path: 'steps[0]', iteration: null, kind: 'create_record', status: 'ok', error: null,
    errorCode: null, attempts: null, handled: false, mocked: false, startedAt: Date.now() - 12, durationMs: 12, ai: null, ...over,
});

test('spec: a run with a failing step keeps the reason, the failing step and the duration of every step', async () => {
    const m = meta();
    assert.equal(await store.insertRun(m), true);
    await store.appendSteps(m.id, [
        step({ kind: 'ai_generate', durationMs: 340, ai: { calls: 1, promptTokens: 120, completionTokens: 30, model: 'claude-x', tier: 'smart', cost: 0.0012, currency: 'USD' } }),
        step({ stepIndex: 1, path: 'steps[1]', status: 'error', error: 'Field "status" is required', errorCode: 'validation', durationMs: 7 }),
    ], { maxSteps: 500 });
    assert.equal(await store.finishLogged(m.id, { status: 'error', error: 'steps[1]: Field "status" is required', durationMs: 360 }), true);

    const run = await store.getLoggedRun('app_a', m.id, IDLE);
    assert.equal(run.status, 'error');
    assert.equal(run.error, 'Field "status" is required', 'the first failing step is the run error');
    assert.deepEqual(run.errorStep, { path: 'steps[1]', kind: 'create_record', stepIndex: 1, actionId: 'act_1' });
    assert.equal(run.durationMs, 360);
    assert.equal(run.stepCount, 2);
    assert.equal(run.failedSteps, 1);
    assert.equal(run.aiCalls, 1);
    assert.equal(run.promptTokens, 120);
    assert.deepEqual(run.costByCurrency, { USD: 0.0012 });

    const steps = await store.getSteps(m.id);
    assert.deepEqual(steps.map((s) => [s.path, s.status, s.durationMs]), [['steps[0]', 'ok', 340], ['steps[1]', 'error', 7]]);
    assert.equal(steps[1].error, 'Field "status" is required');
    assert.equal(steps[1].errorCode, 'validation');
    assert.deepEqual(steps[0].ai, { calls: 1, promptTokens: 120, completionTokens: 30, model: 'claude-x', tier: 'smart', cost: 0.0012, currency: 'USD' });
    assert.equal(steps[1].ai, null);
    assert.equal(await store.finishLogged(m.id, { status: 'success', durationMs: 1 }), false, 'never resurrects');
});

test('the step cap keeps the first rows, counts the rest and marks the run truncated', async () => {
    const m = meta();
    await store.insertRun(m);
    await store.appendSteps(m.id, [step(), step({ path: 'steps[1]' }), step({ path: 'steps[2]', status: 'error', handled: true })], { maxSteps: 2 });
    const run = await store.getLoggedRun('app_a', m.id, IDLE);
    assert.equal(run.stepCount, 3);
    assert.equal(run.truncated, true);
    assert.equal(run.handledErrors, 1);
    assert.equal(run.failedSteps, 0, 'a handled error is not a failure');
    assert.equal((await store.getSteps(m.id)).length, 2);
});

test('a browser run key: the same actor reopens it, another actor gets null; idle runs read as ended', async () => {
    const key = 'rk_abcdefghijklmnop1';
    const click = meta({ origin: 'click', viewerUserId: 'viewer1', clientRunKey: key });
    const id = await store.claimClickRun(click);
    assert.ok(id);
    assert.equal(await store.claimClickRun({ ...click, id: newRunId() }), id, 'the next step of the same click');
    assert.equal(await store.claimClickRun({ ...click, id: newRunId(), viewerUserId: 'mallory' }), null, 'never into another person\'s run');
    await store.appendSteps(id, [step({ status: 'error', error: 'nope' })], { maxSteps: 500 });

    assert.equal((await store.getLoggedRun('app_a', id, IDLE)).status, 'running', 'still inside the idle window');
    await pg.query("UPDATE studio_app_action_runs SET last_activity_at = NOW() - INTERVAL '5 minutes' WHERE id = $1", [id]);
    const idle = await store.getLoggedRun('app_a', id, IDLE);
    assert.equal(idle.status, 'error', 'reads as ended, status from its steps');
    assert.equal(idle.endedBy, 'idle');
    assert.ok(idle.durationMs >= 0);

    assert.equal(await store.closeIdleRuns(IDLE), 1);
    assert.equal(await store.claimClickRun({ ...click, id: newRunId() }), id, 'a late step reopens an idle-closed run');
    assert.equal(await store.endClickRun('app_a', key, { viewerUserId: 'mallory' }, { status: 'success' }), false);
    assert.equal(await store.endClickRun('app_a', key, { viewerUserId: 'viewer1' }, { status: 'success', handled: true }), true);
    const ended = await store.getLoggedRun('app_a', id, IDLE);
    assert.equal(ended.status, 'success');
    assert.equal(ended.endedBy, 'client');
});

test('background rows are never idle-closed', async () => {
    const id = newRunId();
    await runs.insertRunningRun({ id, appId: 'app_a', ownerUserId: 'owner', viewerUserId: 'viewer1', actionId: 'act_bg', origin: 'background', draft: false, definitionVersion: 1, dryRun: false, lockKey: null, instanceId: 't', staleMs: 90_000 });
    await pg.query("UPDATE studio_app_action_runs SET last_activity_at = NOW() - INTERVAL '2 hours' WHERE id = $1", [id]);
    assert.equal(await store.closeIdleRuns(IDLE), 0);
    assert.equal((await store.getLoggedRun('app_a', id, IDLE)).status, 'running');
});

test('the per-app ceiling deletes the oldest finished runs; steps cascade', async () => {
    const ids = [];
    for (let i = 0; i < 4; i += 1) {
        const m = meta();
        ids.push(m.id);
        await store.insertRun(m);
        await store.appendSteps(m.id, [step()], { maxSteps: 500 });
        await store.finishLogged(m.id, { status: 'success', durationMs: 1 });
        await pg.query(`UPDATE studio_app_action_runs SET started_at = NOW() - INTERVAL '${10 - i} minutes' WHERE id = $1`, [m.id]);
    }
    await store.insertRun(meta({ appId: 'app_b' }));
    assert.equal(await store.pruneOverflow({ maxPerApp: 0 }), 0, '0 = no ceiling');
    assert.equal(await store.pruneOverflow({ maxPerApp: 2 }), 2);
    const left = await pg.query("SELECT id FROM studio_app_action_runs WHERE app_id = 'app_a' ORDER BY started_at");
    assert.deepEqual(left.rows.map((r) => r.id), ids.slice(2));
    const orphan = await pg.query('SELECT COUNT(*)::int AS n FROM studio_app_action_run_steps WHERE run_id = ANY($1::text[])', [ids.slice(0, 2)]);
    assert.equal(orphan.rows[0].n, 0);
});

test('listRuns: filters, keyset pages, display names and never an e-mail address', async () => {
    const mk = async (over, minutesAgo, status) => {
        const m = meta(over);
        await store.insertRun(m);
        await store.finishLogged(m.id, { status, durationMs: 5 });
        await pg.query(`UPDATE studio_app_action_runs SET started_at = NOW() - INTERVAL '${minutesAgo} minutes' WHERE id = $1`, [m.id]);
        return m.id;
    };
    const a = await mk({ viewerUserId: 'owner' }, 1, 'success');
    const b = await mk({ viewerUserId: 'viewer1', origin: 'click', actionId: 'act_2' }, 2, 'error');
    const c = await mk({ viewerUserId: null, visitorKey: 'v_123', origin: 'public' }, 3, 'success');
    const d = await mk({ viewerUserId: null, origin: 'mailbox_hook' }, 4, 'error');
    const base = { appId: 'app_a', limit: 10, ...IDLE };

    const all = await store.listRuns(base);
    assert.deepEqual(all.map((r) => r.id), [a, b, c, d]);
    assert.equal(all[0].viewerName, 'Olga Owner');
    assert.equal(all[1].viewerName, null, 'a username that is an address is not shown');
    assert.ok(!JSON.stringify(all).includes('@'), 'no e-mail address anywhere');

    assert.deepEqual((await store.listRuns({ ...base, status: 'error' })).map((r) => r.id), [b, d]);
    assert.deepEqual((await store.listRuns({ ...base, actionId: 'act_2' })).map((r) => r.id), [b]);
    assert.deepEqual((await store.listRuns({ ...base, origins: ['public', 'mailbox_hook'] })).map((r) => r.id), [c, d]);
    assert.deepEqual((await store.listRuns({ ...base, actor: { kind: 'visitors' } })).map((r) => r.id), [c]);
    assert.deepEqual((await store.listRuns({ ...base, actor: { kind: 'system' } })).map((r) => r.id), [d]);
    assert.deepEqual((await store.listRuns({ ...base, actor: { kind: 'user', userId: 'viewer1' } })).map((r) => r.id), [b]);
    assert.deepEqual((await store.listRuns({ ...base, actor: { kind: 'others', userId: 'owner' } })).map((r) => r.id), [b]);

    const page1 = await store.listRuns({ ...base, limit: 2 });
    const page2 = await store.listRuns({ ...base, limit: 2, before: { startedAt: page1[1].startedAt, id: page1[1].id } });
    assert.deepEqual([...page1, ...page2].map((r) => r.id), [a, b, c, d]);
    assert.equal(await store.getLoggedRun('app_b', a, IDLE), null, 'keyed by the authorised app');

    const facets = await store.actorFacets('app_a');
    assert.deepEqual(facets.users.map((u) => u.userId).sort(), ['owner', 'viewer1']);
    assert.equal(facets.visitors, true);
    assert.equal(facets.system, true);
});
