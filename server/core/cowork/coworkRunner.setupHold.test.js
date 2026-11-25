// @typecheck
/**
 * A task that waits for its owner does not start by itself (./coworkRunner.js executeCowork, ./taskSetup.mts): one that
 * was to get fixed steps runs neither as the AI nor at all until its steps are approved or its owner chose the AI. And
 * who its owner chose to send to travels with a run the AI works out, as the last line of what it reads.
 * The store is the real module with two functions replaced per test; the run itself is handed in.
 *
 * Run: cd server && node --test core/cowork/coworkRunner.setupHold.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const { test, mock, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const coworkStore = require('../../stores/coworkStore');
const { executeCowork } = require('./coworkRunner');

const OPEN_POLICY = { readOnly: false, unattendedApps: null, monthlyBudget: null };
const NEXT = '2026-11-24T09:00:00.000Z';
const waits = { steps: 'wanted', cause: null, since: null, sendsTo: null, askFirst: null, canUndo: false };

/** A schedule as the tick reads it. @param {Record<string, unknown>} [over] */
const schedule = (over = {}) => /** @type {any} */ ({ id: 'cw-1', userId: 'u1', title: 'Meeting overview', prompt: 'Summarise my meetings.', repeatInterval: 'weekly', daysOfWeek: ['mon'], nextRunAt: NEXT, planId: null, setup: null, ...over });

/** What ran and what the store was told. */
function world() {
    const ran = /** @type {any[]} */ ([]);
    const told = /** @type {any[]} */ ([]);
    mock.method(coworkStore, 'advanceSchedule', async (...args) => { told.push(['advance', ...args]); return null; });
    mock.method(coworkStore, 'markError', async (...args) => { told.push(['markError', ...args]); return null; });
    const deps = /** @type {any} */ ({
        policyOf: async () => OPEN_POLICY, orgRefusal: async () => null, budgetRefusal: async () => null,
        executeTask: async (task, opts) => { ran.push({ prompt: task.prompt, due: opts.due === true }); },
    });
    return { ran, told, deps };
}

afterEach(() => mock.restoreAll());

test('a repeating task that waits for its steps does not run at its moment: the moment moves on', async () => {
    const { ran, told, deps } = world();
    await executeCowork(schedule({ setup: waits }), { due: true }, deps);
    assert.deepEqual(ran, [], 'it did not run as the AI');
    assert.deepEqual(told, [['advance', 'cw-1', NEXT, 'weekly', ['mon']]]);
});

test('neither does one whose set-up failed, nor one whose steps wait for approval', async () => {
    const { ran, deps } = world();
    await executeCowork(schedule({ setup: { ...waits, steps: 'failed', cause: 'timeout' } }), { due: true }, deps);
    await executeCowork(schedule({ setup: waits, planAutomationId: 'auto-1' }), { due: true }, deps);
    assert.deepEqual(ran, []);
});

test('a run that holds its own row closes it with the reason, in words', async () => {
    const { ran, told, deps } = world();
    await executeCowork(schedule({ setup: waits }), { trigger: { runId: 'run-7' } }, deps);
    assert.deepEqual(ran, []);
    assert.deepEqual(told, [['markError', 'cw-1', 'This task waits for its owner: its steps are not approved yet.', { runId: 'run-7' }]]);
});

test('once its steps are approved, or its owner chose the AI, it runs', async () => {
    const { ran, deps } = world();
    mock.method(require('../../stores/coworkStarts.mts').coworkStarts(), 'latestRunId', async () => null);
    await executeCowork(schedule({ setup: waits, planAutomationId: 'auto-1', planId: 'plan-1' }), { due: true }, deps);
    await executeCowork(schedule({ setup: { ...waits, steps: 'ai' } }), { due: true }, deps);
    await executeCowork(schedule(), { due: true }, deps);
    assert.equal(ran.length, 3);
});

test('who its owner chose to send to is the last line of what the AI reads; the task itself keeps its sentence', async () => {
    const { ran, deps } = world();
    mock.method(require('../../stores/coworkStarts.mts').coworkStarts(), 'latestRunId', async () => null);
    const task = schedule({ setup: { ...waits, steps: 'ai', sendsTo: { me: true, others: ['sam@example.com'] } } });
    await executeCowork(task, { due: true }, deps);
    assert.equal(ran[0].prompt, 'Summarise my meetings.\n\nSend the result to: me, sam@example.com.');
    assert.equal(task.prompt, 'Summarise my meetings.');
});
