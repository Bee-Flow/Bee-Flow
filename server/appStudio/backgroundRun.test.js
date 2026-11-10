'use strict';

/**
 * Background actions (backgroundRun.mts) with a fake clock, fake timers and an injected
 * executor, against the REAL run store on PGlite: the job outlives the request, progress
 * lands in the row, the lockKey excludes a second start, caps and budgets hold, an AI call
 * that never answers fails after its time-out with the real message.
 *
 * Run: cd server && node --test appStudio/backgroundRun.test.js
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const BG = require('./backgroundRun.mts');
const { guardedAiCall } = require('./aiCallGuard.mts');
const { describeStepError } = require('./actionExecutor/stepErrors.mts');
const { backgroundRunHarness } = require('../testUtils/backgroundRunHarness.testkit');

const { s, pg, db, store, deps, input, startAndSettle, status } = backgroundRunHarness({ before, after, beforeEach });

test('spec: a 5-minute background action keeps running after the client is gone and ends in success', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    s.execute = async (_a, _m, step) => {
        if (step.kind === 'ai_generate') { await gate; return { ok: true, result: { text: 'done after five minutes' } }; }
        return { ok: true, result: null };
    };
    const action = { kind: 'sequence', background: true, progressVar: 'status', steps: [status('Reading the order'), { kind: 'ai_generate', prompt: 'x', resultVar: 'summary' }, status('Finished')] };
    const started = await BG.startBackgroundRun(input(action), deps());
    assert.equal(started.ok, true);
    assert.match(started.jobId, /^sar_[0-9a-f]{32}$/);
    // The start answered while the AI step is still waiting: nothing is holding the request.
    await new Promise((r) => { setImmediate(r); });
    let row = await store.getRun('app_1', started.jobId);
    assert.equal(row.status, 'running');
    assert.equal(row.origin, 'background');
    assert.equal(row.viewerUserId, 'viewer1');
    // Five minutes pass (well under the 30-minute default), the heartbeat beats.
    s.clock += 5 * 60_000;
    assert.equal(s.beats.length, 1, 'one heartbeat timer');
    s.beats[0]();
    release();
    await BG._settled(started.jobId);
    row = await store.getRun('app_1', started.jobId);
    assert.equal(row.status, 'success', row.error);
    assert.deepEqual(row.result, { text: 'done after five minutes' });
    assert.deepEqual(row.vars, { status: 'Finished', summary: { text: 'done after five minutes' } }, 'only the vars the run wrote');
    assert.equal(row.progress.message, 'Finished');
    assert.ok(row.durationMs >= 5 * 60_000);
    const view = BG.toJobView(row);
    assert.equal(view.jobId, started.jobId);
    assert.equal(view.status, 'success');
    assert.equal(view.progress.message, 'Finished');
});

test('the run-time limit stops a job with a message naming the variable and its value', async () => {
    s.limits.maxRunMs = 1000;
    s.execute = async () => { s.clock += 2000; return { ok: true, result: 1 }; };
    const row = await startAndSettle({ kind: 'sequence', background: true, steps: [{ kind: 'create_record', tableId: 't' }, { kind: 'create_record', tableId: 't' }] });
    assert.equal(row.status, 'error');
    assert.match(row.error, /Stopped after 1 s, the limit for a background run \(STUDIO_APP_BACKGROUND_MAX_RUN_MS=1000\)/);
    assert.equal(s.executed.length, 1);
});

test('spec: an AI call that never answers fails after the time-out with a clear error', async () => {
    s.execute = async (_a, _m, step) => {
        try {
            await guardedAiCall(() => new Promise(() => {}), { kind: 'ai_generate', model: 'm' }, { env: { STUDIO_AI_CALL_TIMEOUT_MS: '600' }, log: { info() {} } });
            return { ok: true };
        } catch (e) {
            return describeStepError(e, step, { log: { error() {} } });
        }
    };
    const row = await startAndSettle({ kind: 'sequence', background: true, steps: [{ kind: 'ai_generate', prompt: 'x' }, { kind: 'create_record', tableId: 't' }] });
    assert.equal(row.status, 'error');
    assert.equal(row.error, 'The AI gave no answer within 1 s');
    assert.equal(row.errorCode, 'ai_timeout');
    assert.deepEqual(row.errorStep, { path: 'steps[0]', kind: 'ai_generate', stepIndex: 0 });
    assert.equal(s.executed.length, 1, 'the run stopped at the failing step');
});

test('loop position, deferred toast/refresh, a leading confirm skipped', async () => {
    const seen = [];
    s.execute = async () => { s.clock += 1500; return { ok: true, result: null }; };
    const d = deps({ store: () => ({ ...store, updateProgress: async (id, p) => { seen.push(p); return store.updateProgress(id, p); } }) });
    const action = { kind: 'sequence', background: true, steps: [
        { kind: 'confirm', message: 'Start?' },
        { kind: 'loop', source: { kind: 'static', value: ['a', 'b', 'c'] }, itemVar: 'doc', steps: [{ kind: 'create_record', tableId: 't' }] },
        { kind: 'toast', message: 'All done', tone: 'success' }, { kind: 'refresh', tableId: 't' }, { kind: 'toast', message: 'All done', tone: 'success' },
    ] };
    const row = await startAndSettle(action, {}, d);
    assert.equal(row.status, 'success');
    assert.equal(s.executed.length, 3);
    assert.deepEqual(row.effects, [{ kind: 'toast', message: 'All done', tone: 'success' }, { kind: 'refresh', tableId: 't' }], 'de-duplicated, in order');
    assert.ok(seen.some((p) => p.loop && p.loop.count === 3), JSON.stringify(seen));
    assert.deepEqual(s.executed.map((e) => e.ctx.item), ['a', 'b', 'c']);
    assert.equal(s.executed[0].ctx.viewerId, 'viewer1');
    assert.deepEqual(s.executed[0].ctx.formValues, { id: 'o7' });
});

test('a browser-only step makes the start refuse with 400', async () => {
    const out = await BG.startBackgroundRun(input({ kind: 'sequence', background: true, steps: [{ kind: 'navigate', screenId: 's' }] }), deps());
    assert.equal(out.ok, false);
    assert.equal(out.status, 400);
    assert.equal(out.code, 'background_not_runnable');
    const plain = await BG.startBackgroundRun(input({ kind: 'sequence', steps: [] }), deps());
    assert.equal(plain.code, 'not_background');
});

test('spec: a double start with the same lockKey is refused while the first runs, then allowed', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    s.execute = async () => { await gate; return { ok: true, result: 1 }; };
    const action = { kind: 'sequence', background: true, lockKey: { kind: 'formula', expr: 'form.id' }, steps: [{ kind: 'create_record', tableId: 't' }] };
    const first = await BG.startBackgroundRun(input(action), deps());
    assert.equal(first.ok, true);
    const again = await BG.startBackgroundRun(input(action), deps());
    assert.equal(again.ok, false);
    assert.equal(again.status, 409);
    assert.equal(again.code, 'action_locked');
    assert.match(again.error, /already running for the same item/);
    assert.equal(again.jobId, first.jobId, 'the same viewer may attach to the running job');
    const other = await BG.startBackgroundRun(input(action, { viewer: { id: 'viewer2' } }), deps());
    assert.equal(other.code, 'action_locked');
    assert.equal(other.jobId, undefined, 'another viewer does not learn the job id');
    const otherItem = await BG.startBackgroundRun(input(action, { scope: { formValues: { id: 'o8' } } }), deps());
    assert.equal(otherItem.ok, true, 'another key runs');
    assert.ok(await BG.lockHolderFor(input(action), deps()));
    release();
    await BG._settled(first.jobId);
    await BG._settled(otherItem.jobId);
    assert.equal(await BG.lockHolderFor(input(action), deps()), null);
    const later = await BG.startBackgroundRun(input(action), deps());
    assert.equal(later.ok, true);
    await BG._settled(later.jobId);
});

test('the per-user cap refuses with 429 naming the variable', async () => {
    s.limits.perUser = 1;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    s.execute = async () => { await gate; return { ok: true }; };
    const action = { kind: 'sequence', background: true, steps: [{ kind: 'create_record', tableId: 't' }] };
    const first = await BG.startBackgroundRun(input(action), deps());
    const second = await BG.startBackgroundRun(input(action), deps());
    assert.equal(second.status, 429);
    assert.match(second.error, /STUDIO_APP_BACKGROUND_PER_USER=1/);
    release();
    await BG._settled(first.jobId);
});

test('a full per-minute budget is waited out; a full daily e-mail budget fails the step', async () => {
    let tries = 0;
    const minute = { take: async () => (tries++ === 0 ? { ok: false, retryAfterSecs: 7 } : { ok: true }) };
    s.budgets = () => [{ limiter: minute, name: 'STUDIO_APP_AI_STEP_RPM', daily: false }];
    const ok = await startAndSettle({ kind: 'sequence', background: true, steps: [{ kind: 'ai_generate', prompt: 'x' }] });
    assert.equal(ok.status, 'success');
    assert.deepEqual(s.sleeps, [7000]);
    const daily = { take: async () => ({ ok: false, retryAfterSecs: 3600 }) };
    s.budgets = () => [{ limiter: daily, name: 'STUDIO_APP_SEND_EMAIL_DAILY', daily: true }];
    const mail = await startAndSettle({ kind: 'sequence', background: true, steps: [{ kind: 'send_email', connectorId: 'c' }] });
    assert.equal(mail.status, 'error');
    assert.match(mail.error, /daily e-mail limit .*STUDIO_APP_SEND_EMAIL_DAILY/);
    assert.equal(s.executed.length, 1, 'the mail step never reached the executor');
});

test('the heavy-step gate holds for a viewer without a role; the owner passes', async () => {
    const action = { kind: 'sequence', background: true, steps: [{ kind: 'ai_generate', prompt: 'x' }] };
    const denied = await startAndSettle(action, { role: null });
    assert.equal(denied.status, 'error');
    assert.match(denied.error, /do not have access/);
    assert.equal(s.executed.length, 0);
    const owner = await startAndSettle(action, { role: null, isOwner: true, viewer: { id: 'owner' } });
    assert.equal(owner.status, 'success');
});

test('an onError handler inside a background run handles the failure and the run goes on', async () => {
    s.execute = async (_a, _m, step) => (step.kind === 'ai_generate' ? { ok: false, error: 'The AI gave no answer within 120 s', code: 'ai_timeout', retryable: false } : { ok: true, result: 'written' });
    const row = await startAndSettle({ kind: 'sequence', background: true, steps: [
        { kind: 'ai_generate', prompt: 'x', onError: { steps: [{ kind: 'set_variable', name: 'why', value: { kind: 'formula', expr: 'error.code' } }] } },
        { kind: 'create_record', tableId: 't' },
    ] });
    assert.equal(row.status, 'success', row.error);
    assert.equal(row.vars.why, 'ai_timeout');
    assert.equal(s.executed.length, 2);
});

test('stop() ends running jobs as interrupted and refuses new starts', async () => {
    s.execute = async () => new Promise(() => {});
    const action = { kind: 'sequence', background: true, steps: [{ kind: 'create_record', tableId: 't' }] };
    const started = await BG.startBackgroundRun(input(action), deps());
    await BG.stop({ timeoutMs: 20 }, deps());
    const row = await store.getRun('app_1', started.jobId);
    assert.equal(row.status, 'interrupted');
    assert.match(row.error, /restarted/);
    const refused = await BG.startBackgroundRun(input(action), deps());
    assert.equal(refused.status, 503);
    BG._resetForTests();
});

test('run log: the job row itself gets the step rows (no second row), the failing step with its error', async () => {
    const { makeRunLogStore } = require('../stores/studioAppData/runLogStore.mts');
    const runLog = makeRunLogStore(db);
    s.execute = async (_a, _m, step) => { s.clock += 10; return step.kind === 'update_record' ? { ok: false, error: 'Record r9 was not found', code: 'not_found' } : { ok: true, result: { id: 'r1' } }; };
    const row = await startAndSettle(
        { kind: 'sequence', background: true, steps: [{ kind: 'create_record', tableId: 't' }, { kind: 'update_record', tableId: 't', recordId: 'r9' }] },
        {}, deps({ runLog: () => runLog }),
    );
    assert.equal(row.status, 'error');
    const { rows } = await pg.query('SELECT COUNT(*)::int AS n FROM studio_app_action_runs');
    assert.equal(rows[0].n, 1, 'one row: the job');
    const steps = await runLog.getSteps(row.id);
    assert.deepEqual(steps.map((s) => [s.path, s.status, s.durationMs]), [['steps[0]', 'ok', 10], ['steps[1]', 'error', 10]]);
    assert.equal(steps[1].error, 'Record r9 was not found');
    const logged = await runLog.getLoggedRun('app_1', row.id, { idleMs: 60_000, staleMs: 900_000 });
    assert.equal(logged.origin, 'background');
    assert.equal(logged.failedSteps, 1);
});

test('usage: the owner pays, the viewer is the actor and the job is the run, also for the AI calls inside a step', async () => {
    const { usageAttributionFields } = require('./usageAttribution');
    const { areaOf } = require('../shared/usageAreas');
    const rows = [];
    const inside = [];
    s.execute = async () => { inside.push(usageAttributionFields()); return { ok: true, result: null }; };
    const row = await startAndSettle({ kind: 'sequence', background: true, steps: [{ kind: 'create_record', tableId: 't' }] }, {},
        deps({ logUsage: async (entry) => { rows.push(entry); } }));
    assert.equal(row.status, 'success');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].user_id, 'owner');
    assert.equal(rows[0].organization_id, 'org_1');
    assert.equal(rows[0].agent_id, 'app_1');
    assert.equal(rows[0].actor_user_id, 'viewer1');
    assert.equal(rows[0].run_id, row.id);
    assert.notEqual(areaOf(rows[0].source), 'other');
    // What aiRuntime's usage entry reads while the step runs.
    assert.deepEqual(inside, [{ actor_user_id: 'viewer1', run_id: row.id }]);
});

test('a deferred toast with a messageExpr is worked out in the run scope; an empty result falls back to the literal', async () => {
    s.execute = async () => ({ ok: true, result: null });
    const action = { kind: 'sequence', background: true, steps: [
        status('five'),
        { kind: 'toast', message: 'fallback', messageExpr: 'vars.status', tone: 'success' },
        { kind: 'toast', message: 'literal wins when the formula is empty', messageExpr: 'vars.nothing_here', tone: 'info' },
    ] };
    const row = await startAndSettle(action);
    assert.equal(row.status, 'success');
    assert.deepEqual(row.effects, [
        { kind: 'toast', message: 'five', tone: 'success' },
        { kind: 'toast', message: 'literal wins when the formula is empty', tone: 'info' },
    ]);
});
