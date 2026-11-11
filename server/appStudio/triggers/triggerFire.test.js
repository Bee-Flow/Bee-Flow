'use strict';

/**
 * Server triggers end to end, against the REAL trigger store and run store on PGlite with a fake
 * clock (testUtils/triggerHarness.testkit.js): what a publish arms, what a pass of the job fires,
 * and what the run of a fire does to its trigger.
 *
 * Run: cd server && node --test appStudio/triggers/triggerFire.test.js
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { triggerHarness } = require('../../testUtils/triggerHarness.testkit');
const { settleOutcome } = require('./triggerFire.mts');
const { triggerLimits, backoffMs, withMinInterval } = require('./triggerLimits.mts');

const h = triggerHarness({ before, after, beforeEach });
const { s, t, publish, unpublish, rows, row, pass, settle, runs, definition, every, write, MINUTE } = h;

const NOTHING = { settled: 0, due: 0, fired: 0, skipped: 0, disarmed: 0 };
/** Publish one 15-minute trigger, move the clock past its time, fire it and wait for its run. */
async function fireOnce(steps) {
    await publish(definition([every(15)], steps));
    s.clock += 15 * MINUTE;
    const out = await pass();
    const armed = await row();
    return { out, armed, run: armed.lastRunId ? await settle(armed.lastRunId) : null };
}

// ── Arming ──────────────────────────────────────────────────────────────────

test('a draft arms nothing: a trigger in the working definition has no row and never fires', async () => {
    t.app.definition = definition([every(15)]);
    assert.deepEqual(await h.syncDeps().store().listForApp('app_1'), []);
    assert.deepEqual(await unpublish(), { armed: 0, updated: 0, kept: 0, removed: 0 }, 'a sync of an unpublished app writes nothing');
    s.clock += 24 * 60 * MINUTE;
    assert.deepEqual(await pass(), NOTHING);
    assert.deepEqual(await runs(), []);
});

test('an app without triggers has no rows, published or not', async () => {
    assert.deepEqual(await publish(definition(null)), { armed: 0, updated: 0, kept: 0, removed: 0 });
    assert.deepEqual(await rows(), []);
});

test('a publish arms the triggers of the published copy: the row carries the kind, the action and the next time', async () => {
    assert.deepEqual(await publish(definition([every(15)])), { armed: 1, updated: 0, kept: 0, removed: 0 });
    const armed = await row();
    assert.equal(armed.state, 'armed');
    assert.equal(armed.kind, 'schedule');
    assert.equal(armed.actionId, 'act_job');
    assert.equal(armed.ownerUserId, 'owner');
    assert.deepEqual(armed.config, { schedule: { everyMinutes: 15 } });
    assert.equal(Date.parse(armed.nextFireAt), 1_000_000 + 15 * MINUTE);
    assert.match(armed.fingerprint, /^[0-9a-f]{64}$/);
});

test('the sync is idempotent: the same publish again keeps the row, its next time and its history', async () => {
    await publish(definition([every(15)]));
    const first = await row();
    s.clock += 5 * MINUTE;
    assert.deepEqual(await publish(definition([every(15)])), { armed: 0, updated: 0, kept: 1, removed: 0 });
    assert.deepEqual(await row(), first);
});

test('a publish updates a changed trigger, adds a new one and removes one that left; two syncs at once leave one set', async () => {
    await publish(definition([every(15), every(60, { id: 'hourly' })]));
    const next = definition([every(30), every(5, { id: 'often' })]);
    Object.assign(t.app, { definition: next, publishedDefinition: next });
    const [a, b] = await Promise.all([h.publish(next), h.publish(next)]);
    assert.deepEqual([a.armed + b.armed, a.updated + b.updated, a.removed + b.removed], [1, 1, 1], 'each change is made once');
    assert.deepEqual((await rows()).map((r) => [r.triggerId, r.config.schedule.everyMinutes]), [['often', 5], ['tick', 30]]);
});

test('a trigger that is switched off in the definition, or whose action may not run unattended, is not armed', async () => {
    const def = definition([every(15, { enabled: false }), every(15, { id: 'page', actionId: 'act_page' })], undefined, {
        actions: { act_page: { kind: 'sequence', steps: [{ kind: 'navigate', screenId: 'home' }] } },
    });
    assert.deepEqual(await publish(def), { armed: 0, updated: 0, kept: 0, removed: 0 });
});

test('an unpublish disarms: the rows go, and nothing fires afterwards', async () => {
    await publish(definition([every(15)]));
    assert.deepEqual(await unpublish(), { armed: 0, updated: 0, kept: 0, removed: 1 });
    s.clock += 60 * MINUTE;
    assert.deepEqual(await pass(), NOTHING);
});

// ── The fire ────────────────────────────────────────────────────────────────

test('not due: a pass before the time fires nothing', async () => {
    await publish(definition([every(15)]));
    s.clock += 14 * MINUTE;
    assert.deepEqual(await pass(), NOTHING);
    assert.deepEqual(await runs(), []);
});

test('due: the pass starts a server run of the action as the owner, with origin trigger, and moves the trigger on', async () => {
    const { out, armed, run } = await fireOnce();
    assert.deepEqual(out, { settled: 0, due: 1, fired: 1, skipped: 0, disarmed: 0 });
    assert.equal(run.status, 'success', run.error);
    assert.equal(run.origin, 'trigger');
    assert.equal(run.triggerId, 'tick');
    assert.equal(run.viewerUserId, 'owner', 'the run is the owner');
    assert.equal(run.draft, false);
    assert.equal(s.executed.length, 1);
    const { ctx } = s.executed[0];
    assert.deepEqual([ctx.viewerId, ctx.role, ctx.viewer.role, ctx.viewerEmail], ['owner', 'owner', 'owner', 'olga@example.test'], 'viewer.* is the owner');
    assert.equal(armed.lastStatus, 'running');
    assert.equal(Date.parse(armed.lastFiredAt), s.clock);
    assert.equal(Date.parse(armed.nextFireAt), s.clock + 15 * MINUTE, 'the next time counts from the fire');
    assert.equal(armed.fireSeq, 1);
});

test('a double tick has one winner: two passes at the same moment start one run', async () => {
    await publish(definition([every(15)]));
    s.clock += 15 * MINUTE;
    const [a, b] = await Promise.all([pass(), pass()]);
    assert.equal(a.fired + b.fired, 1);
    const started = await runs();
    assert.equal(started.length, 1);
    await settle(started[0].id);
    assert.equal(s.executed.length, 1);
});

test('two instances that both read the row as due: the compare-and-set gives the fire to one', async () => {
    await publish(definition([every(15)]));
    s.clock += 15 * MINUTE;
    const seen = await row();
    const at = { firedAt: s.clock, nextFireAt: s.clock + 15 * MINUTE };
    const [a, b] = await Promise.all([h.triggers.claimFire(seen, at), h.triggers.claimFire(seen, at)]);
    assert.equal([a, b].filter(Boolean).length, 1);
});

test('downtime catch-up: after many missed times the trigger fires once, then goes on from now', async () => {
    await publish(definition([every(15)]));
    s.clock += 10 * 60 * MINUTE; // forty of its times passed while nothing ran
    assert.equal((await pass()).fired, 1);
    await settle((await row()).lastRunId);
    assert.equal(Date.parse((await row()).nextFireAt), s.clock + 15 * MINUTE);
    assert.deepEqual(await pass(), { ...NOTHING, settled: 1 }, 'no backlog: the next pass only settles the run');
    assert.equal((await runs()).length, 1);
});

/** An executor whose step stays busy until `release()`; `busy()` resolves once the run is inside it. */
function heldStep() {
    const held = { release: null };
    s.execute = () => new Promise((resolve) => { held.release = () => resolve({ ok: true, result: {} }); });
    const busy = async () => { while (!held.release) await new Promise((resolve) => { setImmediate(resolve); }); };
    return { busy, release: () => held.release() };
}

test('one run at a time: a trigger whose run is still going is not due again', async () => {
    const step = heldStep();
    await publish(definition([every(15)]));
    s.clock += 15 * MINUTE;
    assert.equal((await pass()).fired, 1);
    await step.busy();
    s.clock += 20 * MINUTE;
    assert.deepEqual(await pass(), NOTHING, 'the run is going: nothing is settled and nothing fires');
    step.release();
    await settle((await row()).lastRunId);
    s.execute = async () => ({ ok: true, result: {} });
    assert.deepEqual(await pass(), { settled: 1, due: 1, fired: 1, skipped: 0, disarmed: 0 });
    await settle((await row()).lastRunId);
});

test('a cron trigger fires at its wall-clock time in its time zone', async () => {
    s.clock = Date.parse('2026-03-02T06:30:00Z');
    await publish(definition([{ id: 'morning', kind: 'schedule', actionId: 'act_job', schedule: { cron: '0 8 * * 1-5', tz: 'Europe/Amsterdam' } }]));
    assert.equal((await row('morning')).nextFireAt, '2026-03-02T07:00:00.000Z', '08:00 in Amsterdam on a Monday in winter');
    s.clock = Date.parse('2026-03-02T07:00:20Z');
    assert.equal((await pass()).fired, 1);
    assert.equal((await row('morning')).nextFireAt, '2026-03-03T07:00:00.000Z');
    await settle((await row('morning')).lastRunId);
});

// ── What the run of a fire does to its trigger ──────────────────────────────

test('a run that succeeds settles as success and clears the failures', async () => {
    await fireOnce();
    assert.equal((await pass()).settled, 1);
    const armed = await row();
    assert.deepEqual([armed.lastStatus, armed.lastError, armed.consecutiveFailures, armed.state], ['success', null, 0, 'armed']);
});

test('back-off: a failed run holds the trigger back, longer after each failure in a row', async () => {
    s.execute = async () => ({ ok: false, error: 'The table is gone.', code: 'failed', retryable: false });
    await fireOnce();
    assert.equal((await pass()).settled, 1);
    let armed = await row();
    assert.deepEqual([armed.lastStatus, armed.consecutiveFailures, armed.state], ['error', 1, 'armed']);
    assert.equal(armed.lastError, 'The table is gone.');
    // Its own next time is 15 minutes away, the first back-off 5: the later of the two holds.
    assert.equal(Date.parse(armed.nextFireAt), s.clock + 15 * MINUTE);
    t.limits.backoffMs = 60 * MINUTE;
    s.clock += 15 * MINUTE;
    assert.equal((await pass()).fired, 1);
    await settle((await row()).lastRunId);
    await pass();
    armed = await row();
    assert.equal(armed.consecutiveFailures, 2);
    assert.equal(Date.parse(armed.nextFireAt), s.clock + 120 * MINUTE, 'the second failure waits twice the base');
    s.clock += 119 * MINUTE;
    assert.deepEqual(await pass(), NOTHING, 'held back until the wait is over');
});

test('auto-pause: after the limit of failed runs in a row the trigger is paused with the reason, and stays so', async () => {
    t.limits.maxFailures = 2;
    t.limits.backoffMs = 0;
    s.execute = async () => ({ ok: false, error: 'No.', code: 'failed', retryable: false });
    await fireOnce();
    await pass();
    s.clock += 15 * MINUTE;
    await pass();
    await settle((await row()).lastRunId);
    assert.equal((await pass()).settled, 1);
    const armed = await row();
    assert.equal(armed.state, 'paused');
    assert.equal(armed.pausedCode, 'failures');
    assert.match(armed.pausedReason, /Paused after 2 failed runs in a row \(STUDIO_APP_TRIGGER_MAX_FAILURES=2\)/);
    s.clock += 24 * 60 * MINUTE;
    assert.deepEqual(await pass(), NOTHING, 'a paused trigger does not fire');
    const view = (await h.state()).triggers[0];
    assert.deepEqual([view.armed, view.state, view.nextFireAt], [false, 'paused', null]);
    // The owner switches it on again: the failures are forgotten and it fires at its next time.
    const on = await h.switchTrigger('tick', true);
    assert.equal(on.ok, true);
    assert.deepEqual([on.trigger.armed, on.trigger.consecutiveFailures], [true, 0]);
    assert.equal(Date.parse(on.trigger.nextFireAt), s.clock + 15 * MINUTE);
});

test('a publish lifts a pause for failures; a pause the owner set stays when the trigger did not change', async () => {
    await publish(definition([every(15), every(15, { id: 'other' })]));
    await h.triggers.setPaused('app_1', 'tick', { paused: true, code: 'failures', reason: 'Paused after 5 failed runs in a row.' });
    assert.equal((await h.switchTrigger('other', false)).ok, true);
    assert.deepEqual(await publish(definition([every(15), every(15, { id: 'other' })])), { armed: 0, updated: 1, kept: 1, removed: 0 });
    assert.deepEqual((await rows()).map((r) => [r.triggerId, r.state, r.pausedCode]), [['other', 'paused', 'user'], ['tick', 'armed', null]]);
});

test('settleOutcome: success, a failure with its wait, the pause at the limit, a cancel, a run that is gone or still going', () => {
    const limits = { ...triggerLimits({}), maxFailures: 3, backoffMs: 1000, backoffMaxMs: 3000 };
    const armed = { consecutiveFailures: 1 };
    const run = (status, error = null) => ({ status, error });
    assert.deepEqual(settleOutcome(armed, run('success'), 50, limits), { status: 'success', error: null, failures: 0 });
    assert.deepEqual(settleOutcome(armed, run('error', 'x'), 50, limits), { status: 'error', error: 'x', failures: 2, notBefore: 2050 });
    assert.equal(settleOutcome({ consecutiveFailures: 2 }, run('interrupted'), 50, limits).pause.code, 'failures');
    assert.equal(settleOutcome({ consecutiveFailures: 9 }, run('refused'), 50, { ...limits, maxFailures: 0 }).pause, undefined, '0 never pauses');
    assert.deepEqual(settleOutcome(armed, run('cancelled', 'The run was cancelled.'), 50, limits), { status: 'cancelled', error: 'The run was cancelled.', failures: 1 });
    assert.equal(settleOutcome(armed, null, 50, limits).status, 'unknown');
    assert.equal(settleOutcome(armed, run('running'), 50, limits), null);
    assert.equal(settleOutcome(armed, run('paused'), 50, limits), null);
});

test('the limits: read from the environment, 0 is unlimited, the wait doubles up to its ceiling', () => {
    const env = { STUDIO_APP_TRIGGER_MIN_INTERVAL_SECONDS: '900', STUDIO_APP_TRIGGER_RUNS_PER_APP: '0', STUDIO_APP_TRIGGER_BATCH: 'many' };
    const limits = triggerLimits(env);
    assert.deepEqual([limits.minIntervalSeconds, limits.runsPerApp, limits.batch, limits.maxFailures], [900, 0, 50, 5]);
    assert.equal(withMinInterval(1000, 0, limits), 900_000, 'never sooner than the shortest interval after the fire');
    assert.equal(withMinInterval(1000, 0, { ...limits, minIntervalSeconds: 0 }), 1000);
    assert.equal(withMinInterval(null, 0, limits), null);
    const b = { ...limits, backoffMs: 1000, backoffMaxMs: 5000 };
    assert.deepEqual([0, 1, 2, 3, 4].map((n) => backoffMs(n, b)), [0, 1000, 2000, 4000, 5000]);
    assert.equal(backoffMs(3, { ...b, backoffMs: 0 }), 0);
});

test('the shortest interval of the install holds a frequent schedule back', async () => {
    t.limits.minIntervalSeconds = 3600;
    await publish(definition([every(1)]));
    assert.equal(Date.parse((await row()).nextFireAt), s.clock + 60 * MINUTE);
});

// ── Limits per app ──────────────────────────────────────────────────────────

test('the per-app limits skip a fire, they do not queue it: concurrent runs and runs per hour', async () => {
    const step = heldStep();
    t.limits.runsPerApp = 1;
    await publish(definition([every(15), every(15, { id: 'second' })]));
    s.clock += 15 * MINUTE;
    assert.deepEqual(await pass(), { settled: 0, due: 2, fired: 1, skipped: 1, disarmed: 0 });
    const skipped = (await rows()).find((r) => r.lastStatus === 'skipped');
    assert.match(skipped.lastError, /1 trigger runs of this app were already going \(STUDIO_APP_TRIGGER_RUNS_PER_APP=1\)/);
    assert.equal(Date.parse(skipped.nextFireAt), s.clock + 15 * MINUTE, 'it keeps its next time');
    await step.busy();
    step.release();
    await settle((await rows()).find((r) => r.lastRunId).lastRunId);
    t.limits.runsPerApp = 0;
    t.limits.firesPerHour = 1;
    s.clock += 15 * MINUTE;
    const out = await pass();
    assert.deepEqual([out.fired, out.skipped], [0, 2], 'the app already started its one run this hour');
});

// ── The fresh check at the fire ─────────────────────────────────────────────

test('owner deactivated: the fire is refused, nothing runs, and the trigger fires again once the account is active', async () => {
    await publish(definition([every(15)]));
    t.owner.status = 'deactivated';
    s.clock += 15 * MINUTE;
    assert.deepEqual(await pass(), { settled: 0, due: 1, fired: 0, skipped: 1, disarmed: 0 });
    let armed = await row();
    assert.deepEqual([armed.lastStatus, armed.state, armed.lastRunId], ['refused', 'armed', null]);
    assert.match(armed.lastError, /account that owns the app is not active/);
    assert.deepEqual(await runs(), []);
    t.owner.status = 'active';
    s.clock += 15 * MINUTE;
    assert.equal((await pass()).fired, 1);
    armed = await row();
    await settle(armed.lastRunId);
});

test('App Studio switched off for the owner: the fire is refused and the trigger stays armed', async () => {
    await publish(definition([every(15)]));
    t.capability = false;
    s.clock += 15 * MINUTE;
    assert.equal((await pass()).skipped, 1);
    assert.match((await row()).lastError, /App Studio is not available/);
});

test('the published copy changed without a publish: the fire disarms the trigger and runs nothing', async () => {
    await publish(definition([every(15)]));
    // A deploy or a restore wrote another published copy; nobody published.
    t.app.publishedDefinition = definition([every(15)], [write('other_table')]);
    s.clock += 15 * MINUTE;
    assert.deepEqual(await pass(), { settled: 0, due: 1, fired: 0, skipped: 0, disarmed: 1 });
    assert.deepEqual(await rows(), []);
    assert.deepEqual(await runs(), []);
});

test('unpublished behind the sync\'s back: the fire disarms the trigger', async () => {
    await publish(definition([every(15)]));
    t.app.isPublished = false;
    s.clock += 15 * MINUTE;
    assert.equal((await pass()).disarmed, 1);
    assert.deepEqual(await rows(), []);
});

test('at run time too: a step that may not run unattended stops the run where it would run', async () => {
    await publish(definition([every(15)]));
    // What the validator and the fire refuse, handed straight to the runner.
    const { startTriggerRun } = require('./triggerRun.mts');
    const ctx = await h.fireDeps().context(await row());
    const def = definition([every(15)], [write('a'), { kind: 'toast', message: 'Done' }, write('b')]);
    const started = await startTriggerRun({ ...ctx.input, def }, 'tick', h.deps());
    const run = await settle(started.jobId);
    assert.equal(run.status, 'error');
    assert.match(run.error, /toast step cannot run without a person at the page/);
    assert.deepEqual(s.executed.map((e) => e.step.tableId), ['a'], 'nothing after it ran');
});

// ── The owner's panel ───────────────────────────────────────────────────────

test('the state the panel reads: not armed in a draft, armed after a publish, not live after a change of the draft', async () => {
    t.app.definition = definition([every(15)]);
    assert.deepEqual(await h.state(), { published: false, triggers: [{
        id: 'tick', kind: 'schedule', actionId: 'act_job', armed: false, state: 'none', pausedCode: null, pausedReason: null, live: null,
        nextFireAt: null, lastFiredAt: null, lastRunId: null, lastStatus: null, lastError: null, consecutiveFailures: 0,
    }] });
    await publish(definition([every(15)]));
    let view = (await h.state()).triggers[0];
    assert.deepEqual([view.armed, view.state, view.live, Date.parse(view.nextFireAt)], [true, 'armed', true, s.clock + 15 * MINUTE]);
    t.app.definition = definition([every(30), every(5, { id: 'draft_only' })]);
    const state = await h.state();
    view = state.triggers.find((v) => v.id === 'tick');
    assert.equal(view.live, false, 'the armed trigger is still the published one');
    assert.deepEqual(state.triggers.find((v) => v.id === 'draft_only').armed, false);
});

test('the switch: off pauses the armed row, on arms it again; a trigger that is not armed cannot be switched', async () => {
    t.app.definition = definition([every(15)]);
    assert.deepEqual(await h.switchTrigger('tick', true), { ok: false, status: 409, code: 'not_armed', error: 'This trigger is not armed. Publish the app to arm its triggers.' });
    await publish(definition([every(15)]));
    const off = await h.switchTrigger('tick', false);
    assert.deepEqual([off.ok, off.trigger.state, off.trigger.pausedCode], [true, 'paused', 'user']);
    s.clock += 60 * MINUTE;
    assert.deepEqual(await pass(), NOTHING);
    const on = await h.switchTrigger('tick', true);
    assert.deepEqual([on.trigger.state, Date.parse(on.trigger.nextFireAt)], ['armed', s.clock + 15 * MINUTE]);
    // Switching on asks the fire's own question: an owner who is not active gets the reason, and the row stays paused.
    await h.switchTrigger('tick', false);
    t.owner.status = 'deactivated';
    const refused = await h.switchTrigger('tick', true);
    assert.deepEqual([refused.ok, refused.code], [false, 'owner_inactive']);
    assert.equal((await row()).state, 'paused');
});
