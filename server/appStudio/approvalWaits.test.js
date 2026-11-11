/**
 * The approval side of a waiting run (approvalWaits.mts) and the await_approval executor
 * (actionExecutor/steps/await_approval.mts), with fakes for the stores: nobody is asked where no
 * run can wait; a timeout the operator does not allow fails before anything is asked; the wake job
 * continues a run with a decision that is already there and closes a request still open; a run
 * that will not wait withdraws only its own open request.
 *
 * Run: cd server && node --test appStudio/approvalWaits.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { settleDueWait, releaseWait, decisionOf, isAwaitedApproval } = require('./approvalWaits.mts');
const { runAwaitApproval, waitingForOf } = require('./actionExecutor/steps/await_approval.mts');
const { backgroundLimits } = require('./backgroundRunPolicy.mts');

const ROW = { id: 'run_1', appId: 'app_1', waitKind: 'approval', waitRef: 'apr_1' };
const awaited = (over = {}) => ({ id: 'apr_1', source: 'app', stepId: 'await_approval', studioAppId: 'app_1', status: 'pending', ...over });

/** Fake approval deps: `rows` by id, every call written down in `calls`. */
function fakes(rows, { expireWins = true } = {}) {
    const calls = [];
    return {
        calls,
        deps: {
            getApproval: async (id) => rows[id] ?? null,
            expire: async (a) => { calls.push(['expire', a.id]); return expireWins ? { ...a, status: 'expired' } : null; },
            withdraw: async (a, reason) => { calls.push(['withdraw', a.id, reason]); },
            resumeWaiting: async (kind, ref, payload) => { calls.push(['resume', kind, ref, payload.decision]); return [{ ok: true }]; },
            log: { info() {}, warn() {} },
        },
    };
}

test('only a request an await_approval step made counts, never a test approval', () => {
    assert.equal(isAwaitedApproval(awaited()), true);
    assert.equal(isAwaitedApproval(awaited({ stepId: null })), false);
    assert.equal(isAwaitedApproval(awaited({ source: 'run' })), false);
    assert.equal(isAwaitedApproval(awaited({ isTest: true })), false);
    assert.deepEqual(decisionOf(awaited({ status: 'rejected', decisionReason: 'No budget', decidedAt: new Date(0) })), {
        decision: 'rejected', reason: 'No budget', answers: null, decidedBy: null, decidedByName: null, decidedAt: '1970-01-01T00:00:00.000Z', approvalId: 'apr_1',
    });
});

test('a due wait: a decision that is there continues the run, an open request is closed as expired first', async () => {
    let f = fakes({ apr_1: awaited({ status: 'approved' }) });
    assert.equal(await settleDueWait(ROW, f.deps), true);
    assert.deepEqual(f.calls, [['resume', 'approval', 'apr_1', 'approved']]);

    f = fakes({ apr_1: awaited() });
    assert.equal(await settleDueWait(ROW, f.deps), true);
    assert.deepEqual(f.calls, [['expire', 'apr_1']], 'the expiry goes through the decided hook, which continues the run');

    // A decider was first: the run goes on with what they decided.
    const rows = { apr_1: awaited() };
    f = fakes(rows, { expireWins: false });
    f.deps.expire = async (a) => { rows.apr_1 = { ...a, status: 'approved' }; return null; };
    assert.equal(await settleDueWait(ROW, f.deps), true);
    assert.deepEqual(f.calls, [['resume', 'approval', 'apr_1', 'approved']]);

    for (const other of [{ ...ROW, waitKind: null }, { ...ROW, appId: 'app_2' }, { ...ROW, waitRef: 'apr_gone' }]) {
        assert.equal(await settleDueWait(other, fakes({ apr_1: awaited() }).deps), false, 'left to the timer');
    }
});

test('a run that will not wait withdraws its own open request, nothing else', async () => {
    const f = fakes({ apr_1: awaited(), apr_2: awaited({ id: 'apr_2', status: 'approved' }), apr_3: awaited({ id: 'apr_3', stepId: null }) });
    assert.equal(await releaseWait('app_1', 'approval', 'apr_1', 'cancelled', f.deps), true);
    assert.equal(await releaseWait('app_2', 'approval', 'apr_1', 'cancelled', f.deps), false);
    assert.equal(await releaseWait('app_1', 'approval', 'apr_2', 'cancelled', f.deps), false);
    assert.equal(await releaseWait('app_1', 'approval', 'apr_3', 'cancelled', f.deps), false);
    assert.equal(await releaseWait('app_1', 'timer', 'apr_1', 'cancelled', f.deps), false);
    assert.deepEqual(f.calls, [['withdraw', 'apr_1', 'cancelled']]);
});

test('the executor asks nobody where no run can wait, nor with a timeout the operator does not allow', async () => {
    const asked = [];
    const deps = {
        request: async (...a) => { asked.push(a); return { ok: true, result: { approvalId: 'apr_1', status: 'pending', expiresAt: null } }; },
        getApproval: async () => null, userName: async () => null, groupName: async () => null,
        limits: () => ({ ...backgroundLimits({}), maxPauseMs: 24 * 3_600_000 }),
    };
    const step = { kind: 'await_approval', prompt: { kind: 'static', value: 'OK?' }, resultVar: 'ok' };
    assert.equal((await runAwaitApproval({}, null, step, {}, deps)).code, 'pause_unsupported');
    assert.equal((await runAwaitApproval({}, null, { ...step, timeoutHours: 48 }, { canPause: true }, deps)).code, 'pause_too_long');
    const dry = await runAwaitApproval({}, null, step, { dryRun: true, canPause: true }, deps);
    assert.equal(dry.result.decision, 'approved');
    assert.equal(asked.length, 0);

    const paused = await runAwaitApproval({}, null, step, { canPause: true }, deps);
    assert.equal(asked.length, 1);
    assert.deepEqual(paused.pause, {
        kind: 'approval', ref: 'apr_1', waitingFor: { kind: 'owner' },
        timeoutResult: { decision: 'expired', reason: null, answers: null, decidedBy: null, decidedByName: null, decidedAt: null, approvalId: 'apr_1' },
    });
    deps.request = async () => ({ ok: false, error: 'Approvals are an Enterprise feature' });
    assert.equal((await runAwaitApproval({}, null, step, { canPause: true }, deps)).error, 'Approvals are an Enterprise feature');
});

test('who decides, as the tray shows it: a name, a group, a panel or the owner; a failed lookup says less', async () => {
    const names = { userName: async () => 'Ann', groupName: async () => { throw new Error('down'); } };
    assert.deepEqual(await waitingForOf({ id: 'a', assigneeUserId: 'u1' }, names), { kind: 'user', name: 'Ann' });
    assert.deepEqual(await waitingForOf({ id: 'a', assigneeGroupId: 'g1' }, names), { kind: 'group', name: null });
    assert.deepEqual(await waitingForOf({ id: 'a', approvers: [{}, {}] }, names), { kind: 'panel', count: 2 });
    assert.deepEqual(await waitingForOf({ id: 'a', stages: [{}] }, names), { kind: 'stages', count: 1 });
    assert.deepEqual(await waitingForOf(null, names), { kind: 'owner' });
});
