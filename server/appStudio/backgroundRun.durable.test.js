'use strict';

/**
 * A server run on hold (backgroundRun.mts with backgroundRunDurable.mts), against the REAL run
 * store on PGlite with the harness of backgroundRun.test.js: a step that waits turns the row
 * `paused` with its state on it and nothing in the process; the wake job, a server-side resume
 * or the holder of the token continues it, on any instance, and of two resumers one wins; a
 * cancel ends a paused run at once and stops a running one before its next step; the limits and
 * the retention hold. A step pauses here through the injected executor (runPause.mts).
 *
 * Run: cd server && node --test appStudio/backgroundRun.durable.test.js
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const BG = require('./backgroundRun.mts');
const { pauseUntil, pauseUntilResumed, newResumeToken } = require('./runPause.mts');
const { backgroundRunHarness } = require('../testUtils/backgroundRunHarness.testkit');

const { s, pg, db, store, deps, input, startAndSettle } = backgroundRunHarness({ before, after, beforeEach });

const HOUR = 3_600_000;
const create = (tableId, extra = {}) => ({ kind: 'create_record', tableId, values: {}, ...extra });
const setVar = (name, value) => ({ kind: 'set_variable', name, value: { kind: 'static', value } });
/** The executor: a step on table `wait` pauses with what `pause()` answers; every other step answers its table. */
function pausing(pause) {
    s.execute = async (_app, _model, step) => (step.tableId === 'wait' ? pause(step) : { ok: true, result: { done: step.tableId } });
}
const raw = async (id) => (await pg.query('SELECT * FROM studio_app_action_runs WHERE id = $1', [id])).rows[0];
const ran = () => s.executed.map((e) => e.step.tableId);
const WAITING = { kind: 'sequence', background: true, steps: [setVar('before', 1), create('a'), create('wait', { resultVar: 'answer' }), setVar('after', 2), create('b')] };

async function settle(jobId) {
    await BG._settled(jobId);
    return store.getRun('app_1', jobId);
}

test('a step that waits puts the run on hold: the row is paused with its state, nothing is left in the process', async () => {
    pausing(() => pauseUntil(s.clock + HOUR));
    const row = await startAndSettle(WAITING);
    assert.equal(row.status, 'paused');
    assert.deepEqual(ran(), ['a', 'wait'], 'nothing after the waiting step ran');
    assert.equal(s.executed[0].ctx.canPause, true, 'the host tells the executor that it can put the run on hold');
    assert.equal(Date.parse(row.wakeAt), 1_000_000 + HOUR);
    assert.equal(row.endedAt, null);
    assert.equal(row.instanceId, null);
    assert.equal(row.progress.waiting, 'timer');
    assert.deepEqual(BG.runningJobIds(), []);
    const stored = await raw(row.id);
    assert.equal(stored.paused_state.v, 1);
    assert.equal(stored.paused_state.walk.cursor, 'steps[2]');
    assert.deepEqual(stored.paused_state.walk.vars, { keep: 1, before: 1 });
    assert.equal(stored.paused_state.run.role, 'agent');
    assert.deepEqual(stored.paused_state.actions, { act_bg: WAITING }, 'the action the run is in, as it walks it');
    const view = BG.toJobView(row);
    assert.equal(view.status, 'paused');
    assert.equal(view.wakeAt, row.wakeAt);
    assert.equal(JSON.stringify(view).includes('paused_state'), false);
});

test('restart survival: another process continues the run from the row alone when its wake time passed', async () => {
    pausing(() => pauseUntil(s.clock + HOUR, { result: { waited: true } }));
    const paused = await startAndSettle(WAITING);
    // The process that paused it is gone; a new one has only the database.
    BG._resetForTests();
    const fresh = deps({ instanceId: 'after-restart' });
    assert.deepEqual(await BG.wakeDueRuns(fresh), { due: 1, resumed: 0 }, 'not before its time');
    assert.equal((await store.getRun('app_1', paused.id)).status, 'paused');
    s.clock += HOUR + 1;
    s.executed.length = 0;
    assert.deepEqual(await BG.wakeDueRuns(fresh), { due: 1, resumed: 1 });
    const row = await settle(paused.id);
    assert.equal(row.status, 'success', row.error);
    assert.deepEqual(ran(), ['b'], 'the walk went on after the waiting step, which did not run again');
    assert.deepEqual(row.vars, { before: 1, answer: { waited: true }, after: 2 }, 'what the run wrote before and after the pause');
    assert.deepEqual(row.result, { done: 'b' });
    assert.equal(row.instanceId, 'after-restart');
    assert.equal(row.resumeSeq, 1);
    assert.equal(row.wakeAt, null);
    assert.equal((await raw(row.id)).paused_state, null, 'the state left the row with the resume');
    assert.deepEqual(s.metas[0].written, ['before']);
});

test('of two resumers exactly one continues the run; the other is told it was already resumed', async () => {
    pausing(() => pauseUntil(s.clock));
    const paused = await startAndSettle(WAITING);
    s.executed.length = 0;
    const [one, two] = await Promise.all([
        BG.resumeBackgroundRun(paused.id, { by: 'timer' }, deps({ instanceId: 'one' })),
        BG.resumeBackgroundRun(paused.id, { by: 'timer' }, deps({ instanceId: 'two' })),
    ]);
    const won = [one, two].filter((r) => r.ok);
    const lost = [one, two].filter((r) => !r.ok);
    assert.equal(won.length, 1);
    assert.equal(lost.length, 1);
    assert.equal(lost[0].code, 'already_resumed');
    assert.equal(lost[0].status, 409);
    const row = await settle(paused.id);
    assert.equal(row.status, 'success');
    assert.deepEqual(ran(), ['b'], 'the rest ran once');
    assert.equal(row.resumeSeq, 1);
    const late = await BG.resumeBackgroundRun(paused.id, { by: 'timer' }, deps());
    assert.equal(late.code, 'not_paused');
});

test('the store claim is a compare-and-set: a stale resume counter takes nothing', async () => {
    pausing(() => pauseUntil(s.clock));
    const paused = await startAndSettle(WAITING);
    assert.equal(await store.claimResume(paused.id, 7, 'x'), null);
    const claimed = await store.claimResume(paused.id, 0, 'x');
    assert.equal(claimed.row.status, 'running');
    assert.equal(claimed.state.walk.cursor, 'steps[2]');
    assert.equal(await store.claimResume(paused.id, 0, 'y'), null, 'the same counter does not win twice');
    assert.equal(await store.pausedStateOf(paused.id, 1), null);
});

test('a resume token: only its holder, only the starter or the owner, only once; the payload is the step result', async () => {
    const { token, hash } = newResumeToken();
    pausing(() => pauseUntilResumed({ tokenHash: hash }));
    const paused = await startAndSettle(WAITING);
    assert.equal(paused.status, 'paused');
    assert.equal(paused.hasResumeToken, true);
    assert.equal(paused.progress.waiting, 'resume');
    assert.equal(JSON.stringify(await raw(paused.id)).includes(token), false, 'the token itself is not stored');
    const by = (over) => ({ by: 'token', appId: 'app_1', userId: 'viewer1', token, payload: { answer: 42 }, ...over });
    assert.equal((await BG.resumeBackgroundRun(paused.id, by({ token: newResumeToken().token }), deps())).code, 'token_invalid');
    assert.equal((await BG.resumeBackgroundRun(paused.id, by({ token: 'nonsense' }), deps())).code, 'token_invalid');
    assert.equal((await BG.resumeBackgroundRun(paused.id, by({ userId: 'viewer2' }), deps())).code, 'not_found', 'another viewer, even with the token');
    assert.equal((await BG.resumeBackgroundRun(paused.id, by({ appId: 'app_other' }), deps())).code, 'not_found', 'not through another app');
    assert.equal((await BG.resumeBackgroundRun(paused.id, { by: 'timer' }, deps())).code, 'not_due', 'the timer does not stand in for the token');
    assert.equal((await store.getRun('app_1', paused.id)).status, 'paused', 'a refused resume leaves the run on hold');
    const ok = await BG.resumeBackgroundRun(paused.id, by({ userId: 'owner' }), deps());
    assert.equal(ok.ok, true);
    const row = await settle(paused.id);
    assert.equal(row.status, 'success');
    assert.deepEqual(row.vars.answer, { answer: 42 });
    assert.equal(row.hasResumeToken, false);
    assert.equal((await BG.resumeBackgroundRun(paused.id, by({}), deps())).code, 'not_paused', 'the token is used up');
});

test('server code resumes the runs that wait for a (kind, ref); a wait that passes its time fails the step with pause_expired', async () => {
    pausing(() => pauseUntilResumed({ kind: 'approval', ref: 'apr_1', until: s.clock + HOUR }));
    const first = await startAndSettle(WAITING);
    const second = await startAndSettle(WAITING);
    assert.equal(first.waitKind, 'approval');
    assert.equal(first.progress.waiting, 'approval');
    assert.equal((await BG.resumeBackgroundRun(first.id, { by: 'system', waitKind: 'approval', waitRef: 'apr_2' }, deps())).code, 'wait_mismatch');
    assert.deepEqual(await BG.resumeWaiting('approval', 'apr_other', {}, deps()), []);
    const [one] = await BG.resumeWaiting('approval', 'apr_1', { decision: 'approved' }, deps());
    assert.equal(one.ok, true);
    // resumeWaiting took both; cancel the second's effect by looking at each row.
    const done = await settle(first.id);
    assert.equal(done.status, 'success');
    assert.deepEqual(done.vars.answer, { decision: 'approved' });
    assert.equal((await settle(second.id)).status, 'success');

    const third = await startAndSettle(WAITING);
    s.clock += HOUR + 1;
    await BG.wakeDueRuns(deps());
    const expired = await settle(third.id);
    assert.equal(expired.status, 'error');
    assert.equal(expired.errorCode, 'pause_expired');
    assert.deepEqual(expired.errorStep, { path: 'steps[2]', kind: 'create_record', stepIndex: 2 });
    assert.equal(ran().filter((t) => t === 'b').length, 2, 'the expired run did not go on');
});

test('cancel while running: the job stops before its next step and ends cancelled', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    s.execute = async (_a, _m, step) => { if (step.tableId === 'a') await gate; return { ok: true, result: 1 }; };
    const started = await BG.startBackgroundRun(input({ kind: 'sequence', background: true, steps: [create('a'), create('b'), { kind: 'toast', message: 'Done' }] }), deps());
    await new Promise((r) => { setImmediate(r); });
    assert.equal(await BG.cancelBackgroundRun('app_other', started.jobId, deps()), null, 'not through another app');
    assert.equal(await BG.cancelBackgroundRun('app_1', started.jobId, deps()), 'cancelling');
    assert.equal((await store.getRun('app_1', started.jobId)).status, 'running');
    release();
    const row = await settle(started.jobId);
    assert.equal(row.status, 'cancelled');
    assert.equal(row.errorCode, 'cancelled');
    assert.equal(row.error, 'The run was cancelled.');
    assert.deepEqual(ran(), ['a'], 'the step in flight finished; the next one did not start');
    assert.equal(row.effects, null);
    assert.equal((await raw(row.id)).ended_by, 'user');
    assert.equal(await BG.cancelBackgroundRun('app_1', started.jobId, deps()), null, 'an ended run is not cancelled again');
});

test('cancel from another instance: the job reads the flag on the row before its next step', async () => {
    s.execute = async (_a, _m, step) => {
        // Another server instance takes the cancel while step `a` runs here.
        if (step.tableId === 'a') { s.clock += 1500; assert.equal(await store.requestCancel('app_1', s.jobId), 'running'); }
        return { ok: true, result: 1 };
    };
    const started = await BG.startBackgroundRun(input({ kind: 'sequence', background: true, steps: [create('a'), create('b')] }), deps());
    s.jobId = started.jobId;
    const row = await settle(started.jobId);
    assert.equal(row.status, 'cancelled');
    assert.deepEqual(ran(), ['a']);
});

test('cancel while paused: the run ends there, its state is gone and nothing resumes it', async () => {
    const { token, hash } = newResumeToken();
    pausing(() => pauseUntilResumed({ tokenHash: hash, until: s.clock + HOUR, timeoutResult: null }));
    const paused = await startAndSettle(WAITING);
    assert.equal(await BG.cancelBackgroundRun('app_1', paused.id, deps()), 'cancelled');
    const stored = await raw(paused.id);
    assert.equal(stored.status, 'cancelled');
    assert.equal(stored.ended_by, 'user');
    assert.equal(stored.paused_state, null);
    assert.equal(stored.resume_token_hash, null);
    assert.equal(stored.wake_at, null);
    s.clock += 2 * HOUR;
    assert.deepEqual(await BG.wakeDueRuns(deps()), { due: 0, resumed: 0 });
    assert.equal((await BG.resumeBackgroundRun(paused.id, { by: 'token', appId: 'app_1', userId: 'viewer1', token }, deps())).code, 'not_paused');
    assert.deepEqual(ran(), ['a', 'wait']);
});

test('a cancel that arrives while the waiting step runs wins over the pause', async () => {
    s.execute = async (_a, _m, step) => {
        if (step.tableId !== 'wait') return { ok: true, result: 1 };
        await store.requestCancel('app_1', s.jobId);
        return pauseUntil(s.clock + HOUR);
    };
    const started = await BG.startBackgroundRun(input(WAITING), deps());
    s.jobId = started.jobId;
    const row = await settle(started.jobId);
    assert.equal(row.status, 'cancelled');
    assert.equal((await raw(row.id)).paused_state, null);
});

// ── The snapshot: a run on hold goes on in the actions its pause kept ─────────

const CALLING = { kind: 'sequence', runOn: 'server', steps: [create('a'), create('wait'), { kind: 'call_action', actionId: 'act_part' }, create('b', { onError: { steps: [setVar('handled', true)] } }), create('c')] };
const PARTS = { act_part: { kind: 'sequence', steps: [create('part')] }, act_unrelated: { kind: 'sequence', steps: [create('never')] } };

test('the snapshot holds the action and what it can call, nothing else; it is what the resumed run walks', async () => {
    pausing(() => pauseUntil(s.clock));
    const paused = await startAndSettle(CALLING, { actions: PARTS });
    const kept = (await raw(paused.id)).paused_state.actions;
    assert.deepEqual(Object.keys(kept), ['act_bg', 'act_part']);
    assert.deepEqual(kept.act_part, PARTS.act_part);
    // The app is published again while the run waits: the action and what it calls are rewritten, the data model too.
    const editedActions = { act_bg: { kind: 'sequence', runOn: 'server', steps: [create('new1'), create('new2')] }, act_part: { kind: 'sequence', steps: [create('newpart')] } };
    s.context = async () => ({ ok: true, input: { ...input(CALLING), def: { actions: editedActions }, model: { version: 'today' }, scope: {} } });
    s.executed.length = 0;
    const models = [];
    s.execute = async (_app, model, step) => { models.push(model); return step.tableId === 'b' ? { ok: false, error: 'Table not found', code: 'table_missing' } : { ok: true, result: step.tableId }; };
    assert.equal((await BG.resumeBackgroundRun(paused.id, { by: 'timer' }, deps())).ok, true);
    const row = await settle(paused.id);
    assert.equal(row.status, 'success', row.error);
    assert.deepEqual(ran(), ['part', 'b', 'c'], 'the old steps, the old called action');
    assert.deepEqual(models, [{ version: 'today' }, { version: 'today' }, { version: 'today' }], 'every step reads and writes through the data model of today');
    assert.equal(row.vars.handled, true, 'a step of the snapshot that fails today fails as a step: its handler took it');
});

test('a second pause keeps the same snapshot, not the definition of that moment', async () => {
    let waits = 0;
    s.execute = async (_a, _m, step) => { if (step.tableId === 'wait' || step.tableId === 'part') { waits += 1; return pauseUntil(s.clock); } return { ok: true, result: step.tableId }; };
    const paused = await startAndSettle(CALLING, { actions: PARTS });
    s.context = async () => ({ ok: true, input: { ...input(CALLING), def: { actions: { act_bg: { kind: 'sequence', runOn: 'server', steps: [] } } }, scope: {} } });
    await BG.wakeDueRuns(deps());
    const again = await settle(paused.id);
    assert.equal(again.status, 'paused', again.error);
    assert.equal(waits, 2);
    const stored = (await raw(paused.id)).paused_state;
    assert.equal(stored.walk.cursor, 'steps[2].call.steps[0]');
    assert.deepEqual(stored.actions, { act_bg: CALLING, act_part: PARTS.act_part });
    await BG.wakeDueRuns(deps());
    assert.equal((await settle(paused.id)).status, 'success');
});

test('the size limit counts the snapshot with the walk', async () => {
    pausing(() => pauseUntil(s.clock));
    const big = { kind: 'sequence', runOn: 'server', steps: [create('wait'), { kind: 'toast', message: 'x'.repeat(400) }] };
    s.limits.pauseStateMaxBytes = 600;
    const row = await startAndSettle(big, { scope: {} });
    assert.equal(row.errorCode, 'pause_state_too_large', 'the walk alone is far under the limit');
    assert.match(row.error, /STUDIO_APP_PAUSE_STATE_MAX_BYTES=600/);
    assert.equal((await raw(row.id)).paused_state, null);
    assert.equal((await startAndSettle({ kind: 'sequence', runOn: 'server', steps: [create('wait')] }, { scope: {} })).status, 'paused');
});

test('a snapshot with a step kind this install does not know ends the run as refused', async () => {
    pausing(() => pauseUntil(s.clock));
    const paused = await startAndSettle(WAITING);
    await pg.query(`UPDATE studio_app_action_runs SET paused_state = jsonb_set(paused_state, '{actions,act_bg,steps,4,kind}', '"teleport"') WHERE id = $1`, [paused.id]);
    s.executed.length = 0;
    const out = await BG.resumeBackgroundRun(paused.id, { by: 'timer' }, deps());
    assert.equal(out.code, 'resume_refused');
    const row = await store.getRun('app_1', paused.id);
    assert.equal(row.status, 'refused');
    assert.equal(row.errorCode, 'step_kind_unknown');
    assert.equal((await raw(paused.id)).paused_state, null);
    assert.deepEqual(ran(), [], 'not a single step of it ran');
    assert.equal(s.metas.length, 0);
});

test('the state, snapshot included, is off the row at every end: success, failure, cancel, refusal', async () => {
    pausing(() => pauseUntil(s.clock));
    const ends = {};
    const hold = async () => (await startAndSettle(WAITING)).id;
    ends.success = await hold();
    await BG.wakeDueRuns(deps());
    await settle(ends.success);
    ends.error = await hold();
    s.execute = async () => ({ ok: false, error: 'No' });
    await BG.wakeDueRuns(deps());
    await settle(ends.error);
    pausing(() => pauseUntil(s.clock));
    ends.cancelled = await hold();
    await BG.cancelBackgroundRun('app_1', ends.cancelled, deps());
    ends.refused = await hold();
    s.context = async () => ({ ok: false, code: 'action_removed', error: 'The action was removed from the app while this run was waiting, so the run was ended.' });
    await BG.wakeDueRuns(deps());
    for (const [status, id] of Object.entries(ends)) {
        const stored = await raw(id);
        assert.equal(stored.status, status);
        assert.equal(stored.paused_state, null, status);
    }
});

test('a run that may not continue is ended as refused, with nothing run and its state gone', async () => {
    pausing(() => pauseUntil(s.clock));
    const paused = await startAndSettle(WAITING);
    s.executed.length = 0;
    s.context = async () => ({ ok: false, code: 'unpublished', error: 'The app is no longer published, so the run that was waiting was ended.' });
    const out = await BG.resumeBackgroundRun(paused.id, { by: 'timer' }, deps());
    assert.equal(out.ok, false);
    assert.equal(out.code, 'resume_refused');
    const row = await store.getRun('app_1', paused.id);
    assert.equal(row.status, 'refused');
    assert.equal(row.errorCode, 'unpublished');
    assert.equal((await raw(paused.id)).paused_state, null);
    assert.deepEqual(ran(), []);
    assert.equal(s.metas[0].role, 'agent', 'the check is handed the role the run started with');
});

test('a failing identity read touches nothing: the run stays on hold for the next pass', async () => {
    pausing(() => pauseUntil(s.clock));
    const paused = await startAndSettle(WAITING);
    s.context = async () => { throw new Error('database away'); };
    assert.deepEqual(await BG.wakeDueRuns(deps()), { due: 1, resumed: 0 });
    const row = await store.getRun('app_1', paused.id);
    assert.equal(row.status, 'paused');
    assert.equal(row.resumeSeq, 0);
    assert.ok((await raw(paused.id)).paused_state);
});

test('the limits: the longest wait, the runs on hold per app, the size of the state; 0 lifts each', async () => {
    pausing(() => pauseUntil(s.clock + 3 * HOUR));
    s.limits.maxPauseMs = 2 * HOUR;
    let row = await startAndSettle(WAITING);
    assert.equal(row.status, 'error');
    assert.equal(row.errorCode, 'pause_too_long');
    assert.match(row.error, /STUDIO_APP_PAUSE_MAX_MS=7200000/);
    s.limits.maxPauseMs = 0;
    assert.equal((await startAndSettle(WAITING)).status, 'paused');

    s.limits.pausedPerApp = 1;
    row = await startAndSettle(WAITING);
    assert.equal(row.errorCode, 'pause_limit');
    assert.match(row.error, /STUDIO_APP_PAUSED_PER_APP=1/);
    s.limits.pausedPerApp = 0;

    s.limits.pauseStateMaxBytes = 200;
    row = await startAndSettle(WAITING, { scope: { vars: { big: 'x'.repeat(500) } } });
    assert.equal(row.errorCode, 'pause_state_too_large');
    s.limits.pauseStateMaxBytes = 0;
    assert.equal((await startAndSettle(WAITING, { scope: { vars: { big: 'x'.repeat(500) } } })).status, 'paused');

    // A pause that names neither a time nor what it waits for could never be resumed.
    pausing(() => ({ ok: true, pause: {} }));
    assert.equal((await startAndSettle(WAITING)).errorCode, 'pause_invalid');
    // Without a time, the longest wait ends it.
    s.limits.maxPauseMs = HOUR;
    pausing(() => pauseUntilResumed({ kind: 'approval', ref: 'apr_9' }));
    assert.equal(Date.parse((await startAndSettle(WAITING)).wakeAt), s.clock + HOUR);
});

test('a run on hold keeps its lockKey; the run-time limit counts the time it really ran', async () => {
    pausing(() => pauseUntil(s.clock + HOUR));
    const locked = { ...WAITING, lockKey: { kind: 'formula', expr: 'form.id' } };
    const paused = await startAndSettle(locked);
    assert.equal(paused.status, 'paused');
    const again = await BG.startBackgroundRun(input(locked), deps());
    assert.equal(again.code, 'action_locked');
    assert.equal(again.jobId, paused.id);
    assert.ok(await BG.lockHolderFor(input(locked), deps()));
    // An hour on hold is not an hour of running: the 30-minute limit does not end the run.
    s.clock += HOUR + 1;
    await BG.wakeDueRuns(deps());
    const row = await settle(paused.id);
    assert.equal(row.status, 'success', row.error);
    assert.ok(row.durationMs < 60_000, `${row.durationMs} ms of running`);
    pausing(() => ({ ok: true, result: null }));
    const next = await BG.startBackgroundRun(input(locked), deps());
    assert.equal(next.ok, true, 'the lock is free again');
    await BG._settled(next.jobId);
});

test('a pause inside a loop of a called action resumes in the right round', async () => {
    s.execute = async (_a, _m, step, ctx) => (step.tableId === 'wait' && ctx.params.row === 'b' ? pauseUntil(s.clock) : { ok: true, result: step.tableId });
    const actions = { act_each: { kind: 'sequence', steps: [create('wait'), create('after')] } };
    const each = { kind: 'call_action', actionId: 'act_each', params: { row: { kind: 'formula', expr: 'item' } } };
    const action = { kind: 'sequence', runOn: 'server', steps: [{ kind: 'loop', source: { kind: 'static', value: ['a', 'b', 'c'] }, steps: [each] }, create('end')] };
    const paused = await startAndSettle(action, { actions });
    assert.equal(paused.status, 'paused');
    await BG.wakeDueRuns(deps());
    const row = await settle(paused.id);
    assert.equal(row.status, 'success', row.error);
    assert.deepEqual(s.executed.map((e) => `${e.step.tableId}:${e.ctx.params.row ?? ''}`), ['wait:a', 'after:a', 'wait:b', 'after:b', 'wait:c', 'after:c', 'end:']);
    assert.deepEqual(s.executed.map((e) => e.ctx.actionId), ['act_each', 'act_each', 'act_each', 'act_each', 'act_each', 'act_each', 'act_bg']);
});

test('the run log continues on the same row after a resume', async () => {
    const { makeRunLogStore } = require('../stores/studioAppData/runLogStore.mts');
    const runLog = makeRunLogStore(db);
    pausing(() => pauseUntil(s.clock));
    const d = deps({ runLog: () => runLog });
    const paused = await startAndSettle(WAITING, {}, d);
    assert.deepEqual((await runLog.getSteps(paused.id)).map((st) => st.path), ['steps[0]', 'steps[1]'], 'the waiting step is not logged until it ends');
    await BG.wakeDueRuns(d);
    await settle(paused.id);
    const steps = await runLog.getSteps(paused.id);
    assert.deepEqual(steps.map((st) => `${st.seq} ${st.path} ${st.status}`), ['1 steps[0] ok', '2 steps[1] ok', '3 steps[2] ok', '4 steps[3] ok', '5 steps[4] ok']);
    const { rows } = await pg.query('SELECT COUNT(*)::int AS n FROM studio_app_action_runs');
    assert.equal(rows[0].n, 1);
});

test('retention: a pause older than the run retention, or one whose starter is gone, is ended and its state cleared', async () => {
    pausing(() => pauseUntil(s.clock + HOUR));
    const old = await startAndSettle(WAITING);
    const orphan = await startAndSettle(WAITING);
    const kept = await startAndSettle(WAITING);
    await pg.query("UPDATE studio_app_action_runs SET started_at = NOW() - INTERVAL '40 days' WHERE id = $1", [old.id]);
    await pg.query("UPDATE studio_app_action_runs SET viewer_user_id = NULL, wait_kind = 'approval', wait_ref = 'apr_1' WHERE id = $1", [orphan.id]);
    const waits = [];
    const out = await store.pruneRuns({ resultTtlHours: 24, retentionDays: 30, onEndedWait: async (w) => { waits.push(w); } });
    assert.equal(out.expired, 2);
    assert.deepEqual(waits, [{ runId: orphan.id, appId: 'app_1', waitKind: 'approval', waitRef: 'apr_1' }], 'only the ended pause that waited for something is handed on, to withdraw its request');
    // The one past the retention was ended and, like any ended run that old, deleted in the same pass.
    assert.equal(out.deleted, 1);
    assert.equal(await raw(old.id), undefined);
    const ended = await raw(orphan.id);
    assert.equal(ended.status, 'interrupted');
    assert.equal(ended.error_code, 'pause_expired');
    assert.equal(ended.paused_state, null);
    assert.equal(ended.wake_at, null);
    assert.equal((await raw(kept.id)).status, 'paused');
    assert.ok((await raw(kept.id)).paused_state, 'a pause within the retention keeps its state: the 24-hour payload rule is for ended runs');
    // Without a retention (0 = keep) a pause is not ended for its age.
    await pg.query("UPDATE studio_app_action_runs SET started_at = NOW() - INTERVAL '400 days' WHERE id = $1", [kept.id]);
    assert.equal((await store.pruneRuns({ resultTtlHours: 24, retentionDays: 0 })).expired, 0);
});

test('shutdown: no run is resumed while the server stops', async () => {
    pausing(() => pauseUntil(s.clock));
    const paused = await startAndSettle(WAITING);
    await BG.stop({ timeoutMs: 50 }, deps());
    assert.equal((await BG.resumeBackgroundRun(paused.id, { by: 'timer' }, deps())).code, 'shutting_down');
    assert.deepEqual(await BG.wakeDueRuns(deps()), { due: 0, resumed: 0 });
    assert.equal((await store.getRun('app_1', paused.id)).status, 'paused', 'a run on hold is not interrupted by a restart');
});

test('an existing background action is unchanged: the same row, no pause columns set, the same job view', async () => {
    const row = await startAndSettle({ kind: 'sequence', background: true, steps: [create('a'), { kind: 'toast', message: 'Done', tone: 'success' }] });
    assert.equal(row.status, 'success');
    const stored = await raw(row.id);
    for (const column of ['paused_state', 'paused_at', 'wake_at', 'wait_kind', 'wait_ref', 'resume_token_hash']) assert.equal(stored[column], null, column);
    assert.equal(stored.resume_seq, 0);
    assert.equal(stored.cancel_requested, false);
    assert.deepEqual(Object.keys(BG.toJobView(row)), ['jobId', 'actionId', 'status', 'progress', 'result', 'vars', 'effects', 'error', 'errorStep', 'startedAt', 'finishedAt', 'durationMs']);
    assert.deepEqual(row.effects, [{ kind: 'toast', message: 'Done', tone: 'success' }]);
});

test('runOn: "server" starts a server run like a background action does', async () => {
    const row = await startAndSettle({ kind: 'sequence', runOn: 'server', steps: [create('a')] });
    assert.equal(row.status, 'success');
    assert.equal(row.origin, 'background');
    const plain = await BG.startBackgroundRun(input({ kind: 'sequence', steps: [create('a')] }), deps());
    assert.equal(plain.code, 'not_background');
});
