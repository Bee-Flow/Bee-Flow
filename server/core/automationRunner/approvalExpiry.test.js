/**
 * An approval nobody decided before its deadline (approvalExpiry.mts): with an
 * 'on_expired' edge the reaped run continues along it; without one (the
 * characterisation half) it stays closed exactly as the reaper left it and is
 * handed back for the old handling, with nothing written, resumed or announced.
 * Dependencies are handed in; no module is mocked.
 *
 * Run: cd server && node --test core/automationRunner/approvalExpiry.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { continueOnExpiredBranches, EXPIRED_BRANCH_SUMMARY } = require('./approvalExpiry.mts');

const NOW = new Date('2026-11-15T10:00:00.000Z');
const PLAIN = [{ from: 'trg', to: 'ap' }, { from: 'ap', to: 'yes' }, { from: 'ap', to: 'no', label: 'on_rejected' }];
const WITH_EXPIRED = [...PLAIN, { from: 'ap', to: 'late', label: 'on_expired' }];

/** A world where every run is pinned to `edges`; records what was done. */
function world({ edges = WITH_EXPIRED, resume, definitionFails = false } = {}) {
    const seen = { reads: [], resumes: [], updates: [], closedRows: [], expired: [] };
    const deps = {
        getRun: async (id) => { seen.reads.push(id); return { id, automationId: 'auto1', status: 'error' }; },
        automationToResume: async () => { if (definitionFails) throw new Error('gone'); return { definition: { edges } }; },
        resumeFromStep: resume || (async (runId, stepId, options) => {
            seen.resumes.push({ runId, stepId, options });
            options.onRunCreated({ id: `child-of-${runId}` });
            return { id: `child-of-${runId}` };
        }),
        updateRun: async (id, patch) => { seen.updates.push({ id, patch }); },
        closeAwaitingStepRow: async (...args) => { seen.closedRows.push(args); },
        expireApprovalsOf: async (runId) => { seen.expired.push(runId); },
        log: { warn() {}, error() {} },
        now: () => NOW,
    };
    return { deps, seen };
}

const reaped = (id = 'run1', awaitingStepId = 'ap') => ({ id, automationId: 'auto1', userId: 'u1', awaitingStepId });

test('without an expired branch the run stays closed and nothing else happens (the behaviour before on_expired)', async () => {
    const { deps, seen } = world({ edges: PLAIN });
    const runs = [reaped('run1'), reaped('run2')];
    assert.deepStrictEqual(await continueOnExpiredBranches(runs, deps), runs, 'every run handed back, in order');
    assert.deepStrictEqual([seen.resumes, seen.updates, seen.closedRows, seen.expired], [[], [], [], []]);
});

test('an on_expired edge out of ANOTHER step does not continue this approval', async () => {
    const { deps, seen } = world({ edges: [...PLAIN, { from: 'other', to: 'late', label: 'on_expired' }] });
    assert.strictEqual((await continueOnExpiredBranches([reaped()], deps)).length, 1);
    assert.deepStrictEqual(seen.resumes, []);
});

test('with an expired branch the run continues on it, with approved:false, expired:true as the step output', async () => {
    const { deps, seen } = world();
    assert.deepStrictEqual(await continueOnExpiredBranches([reaped()], deps), [], 'nothing left for the old handling');
    assert.strictEqual(seen.resumes.length, 1);
    const { runId, stepId, options } = seen.resumes[0];
    assert.deepStrictEqual([runId, stepId, options.continuesJourney], ['run1', 'ap', true]);
    assert.deepStrictEqual(options.decision, {
        approved: false, by: null, reason: null, decidedAt: NOW.toISOString(), answers: {}, votes: [], expired: true,
    });
    assert.deepStrictEqual(seen.updates, [{ id: 'run1', patch: { status: 'success', error: null, errorClass: null, summary: EXPIRED_BRANCH_SUMMARY, finishedAt: NOW.toISOString() } }]);
    assert.deepStrictEqual(seen.closedRows, [['run1', 'ap', 'awaiting_approval', 'expired']]);
    assert.deepStrictEqual(seen.expired, ['run1'], 'its approval rows expire, with the continued bell');
});

test('the reaper sees only the runs that stay closed, in a mixed tick', async () => {
    const pinned = { run1: WITH_EXPIRED, run2: PLAIN };
    const { deps } = world();
    deps.automationToResume = async (run) => ({ definition: { edges: pinned[run.id] } });
    const closed = await continueOnExpiredBranches([reaped('run1'), reaped('run2'), reaped('run3', null)], deps);
    assert.deepStrictEqual(closed.map((r) => r.id), ['run2', 'run3']);
});

test('a run without a recorded step, or whose definition cannot be read, stays closed', async () => {
    const noStep = world();
    assert.strictEqual((await continueOnExpiredBranches([reaped('run1', null)], noStep.deps)).length, 1);
    assert.deepStrictEqual(noStep.seen.reads, [], 'not even read');

    const unreadable = world({ definitionFails: true });
    assert.strictEqual((await continueOnExpiredBranches([reaped()], unreadable.deps)).length, 1);
    assert.deepStrictEqual(unreadable.seen.resumes, []);
});

test('a continuation that never starts leaves the run closed as the reaper left it', async () => {
    for (const resume of [async () => { throw new Error('no runner'); }, async () => null]) {
        const { deps, seen } = world({ resume });
        assert.strictEqual((await continueOnExpiredBranches([reaped()], deps)).length, 1);
        assert.deepStrictEqual([seen.updates, seen.closedRows, seen.expired], [[], [], []]);
    }
});

test('a continuation that ends before onRunCreated still counts by the run it returns', async () => {
    const { deps, seen } = world({ resume: async () => ({ id: 'child-1' }) });
    assert.deepStrictEqual(await continueOnExpiredBranches([reaped()], deps), []);
    assert.strictEqual(seen.updates[0].patch.status, 'success');
});

test('a failing bookkeeping write after the continuation started never throws', async () => {
    const { deps } = world();
    deps.updateRun = async () => { throw new Error('db down'); };
    deps.closeAwaitingStepRow = async () => { throw new Error('db down'); };
    deps.expireApprovalsOf = async () => { throw new Error('db down'); };
    assert.deepStrictEqual(await continueOnExpiredBranches([reaped()], deps), []);
});
