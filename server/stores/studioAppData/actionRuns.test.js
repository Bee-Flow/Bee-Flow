'use strict';

/**
 * The action-run store against a real Postgres (PGlite), with the DDL lifted out of
 * ./schema.js: the lockKey is exclusive among running rows, a stale holder is reclaimed,
 * finishRun never resurrects a row, the prune nulls and deletes, an app delete cascades.
 *
 * Run: cd server && node --test stores/studioAppData/actionRuns.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { pgliteDb } = require('../../testUtils/pgliteDb');
const { makeActionRunStore } = require('./actionRuns.mts');
const { newRunId } = require('./runPolicy.mts');

const { pg, db } = pgliteDb();
const store = makeActionRunStore(db);

function shippedDdl() {
    const text = fs.readFileSync(path.join(__dirname, 'schema.js'), 'utf8');
    const m = /`(\s*CREATE TABLE IF NOT EXISTS studio_app_action_runs[\s\S]*?)`/.exec(text);
    assert.ok(m, 'schema.js still creates studio_app_action_runs');
    return m[1];
}

before(async () => {
    await pg.exec('CREATE TABLE studio_apps (id TEXT PRIMARY KEY, user_id TEXT NOT NULL)');
    await pg.exec(shippedDdl());
    await pg.query("INSERT INTO studio_apps (id, user_id) VALUES ('app_a', 'owner'), ('app_b', 'owner'), ('app_gone', 'owner')");
});
after(async () => { await pg.close(); });

const STALE = 90_000;
const start = (over = {}) => store.insertRunningRun({
    id: newRunId(), appId: 'app_a', ownerUserId: 'owner', viewerUserId: 'viewer1', actionId: 'act_1', origin: 'background',
    draft: false, definitionVersion: 3, dryRun: false, lockKey: null, instanceId: 'test', staleMs: STALE, ...over,
});

test('spec: a second running row with the same lockKey is refused and names the holder', async () => {
    const id = newRunId();
    assert.deepEqual(await start({ id, lockKey: 'order:1' }), { ok: true });
    const second = await start({ lockKey: 'order:1', viewerUserId: 'viewer2' });
    assert.equal(second.ok, false);
    assert.equal(second.holder.id, id);
    assert.equal(second.holder.viewerUserId, 'viewer1');
    assert.equal((await store.isLockHeld('app_a', 'order:1', STALE)).id, id);
    // Another key, another app, or no key at all: free.
    assert.equal((await start({ lockKey: 'order:2' })).ok, true);
    assert.equal((await start({ appId: 'app_b', lockKey: 'order:1' })).ok, true);
    assert.equal((await start({ lockKey: null })).ok, true);
    // After the holder finishes, the key is free again.
    assert.equal(await store.finishRun(id, { status: 'success', result: { n: 1 }, durationMs: 5 }), true);
    assert.equal(await store.isLockHeld('app_a', 'order:1', STALE), null);
    assert.equal((await start({ lockKey: 'order:1' })).ok, true);
});

test('a holder that stopped beating is reclaimed as interrupted', async () => {
    const id = newRunId();
    await start({ id, lockKey: 'stale:1' });
    await pg.query("UPDATE studio_app_action_runs SET last_activity_at = NOW() - INTERVAL '10 minutes' WHERE id = $1", [id]);
    assert.equal(await store.isLockHeld('app_a', 'stale:1', STALE), null, 'a stale holder does not count');
    assert.equal((await start({ lockKey: 'stale:1' })).ok, true);
    const old = await store.getRun('app_a', id);
    assert.equal(old.status, 'interrupted');
    assert.match(old.error, /stopped answering/);
});

test('finishRun only changes a running row (never resurrects)', async () => {
    const id = newRunId();
    await start({ id });
    await store.markInterrupted([id], 'The server restarted while this ran.');
    assert.equal(await store.finishRun(id, { status: 'success' }), false);
    assert.equal((await store.getRun('app_a', id)).status, 'interrupted');
});

test('progress, heartbeat, reads and the viewer list', async () => {
    const id = newRunId();
    await start({ id, actionId: 'act_list', viewerUserId: 'lister' });
    await store.updateProgress(id, { stepIndex: 2, kind: 'ai_generate', message: 'Reading 2 of 5' });
    assert.equal(await store.heartbeat([id]), 1);
    const row = await store.getRun('app_a', id);
    assert.deepEqual(row.progress, { stepIndex: 2, kind: 'ai_generate', message: 'Reading 2 of 5' });
    assert.equal(await store.getRun('app_b', id), null, 'keyed by the app');
    assert.equal((await store.listRunsForViewer('app_a', 'lister', { activeOnly: true })).length, 1);
    await store.finishRun(id, { status: 'error', error: 'x', errorStep: { path: 'steps[0]', kind: 'ai_generate', stepIndex: 0 } });
    assert.equal((await store.listRunsForViewer('app_a', 'lister', { activeOnly: true })).length, 0);
    const [done] = await store.listRunsForViewer('app_a', 'lister');
    assert.deepEqual(done.errorStep, { path: 'steps[0]', kind: 'ai_generate', stepIndex: 0 });
    assert.equal(await store.countRunning('app_a', { viewerUserId: 'lister', staleMs: STALE }), 0);
});

test('countRunning counts live background rows only', async () => {
    const before = await store.countRunning('app_b', { staleMs: STALE });
    await start({ appId: 'app_b', viewerUserId: 'counter' });
    await start({ appId: 'app_b', viewerUserId: 'counter', origin: 'mcp' });
    assert.equal(await store.countRunning('app_b', { staleMs: STALE }), before + 1);
    assert.equal(await store.countRunning('app_b', { viewerUserId: 'counter', staleMs: STALE }), 1);
});

test('markStaleInterrupted sweeps background rows nobody beats', async () => {
    const id = newRunId();
    await start({ id, appId: 'app_b' });
    await pg.query("UPDATE studio_app_action_runs SET last_activity_at = NOW() - INTERVAL '10 minutes' WHERE id = $1", [id]);
    assert.ok(await store.markStaleInterrupted(STALE, 10) >= 1);
    assert.equal((await store.getRun('app_b', id)).status, 'interrupted');
});

test('pruneRuns nulls payloads after the TTL and deletes rows after the retention; 0 keeps', async () => {
    const a = newRunId();
    const b = newRunId();
    await start({ id: a });
    await start({ id: b });
    await store.finishRun(a, { status: 'success', result: { secret: 'value' }, vars: { v: 1 }, effects: [{ kind: 'toast' }] });
    await store.finishRun(b, { status: 'success', result: { n: 1 } });
    await pg.query("UPDATE studio_app_action_runs SET ended_at = NOW() - INTERVAL '2 days' WHERE id = $1", [a]);
    await pg.query("UPDATE studio_app_action_runs SET started_at = NOW() - INTERVAL '40 days', ended_at = NOW() - INTERVAL '40 days' WHERE id = $1", [b]);
    assert.deepEqual(await store.pruneRuns({ resultTtlHours: 0, retentionDays: 0 }), { nulled: 0, deleted: 0 });
    const out = await store.pruneRuns({ resultTtlHours: 24, retentionDays: 30 });
    assert.ok(out.nulled >= 1 && out.deleted >= 1, JSON.stringify(out));
    const kept = await store.getRun('app_a', a);
    assert.equal(kept.result, null);
    assert.equal(kept.vars, null);
    assert.equal(kept.effects, null);
    assert.equal(await store.getRun('app_a', b), null);
});

test('deleting the app cascades its runs', async () => {
    const id = newRunId();
    await start({ id, appId: 'app_gone' });
    await pg.query("DELETE FROM studio_apps WHERE id = 'app_gone'");
    assert.equal(await store.getRun('app_gone', id), null);
});
