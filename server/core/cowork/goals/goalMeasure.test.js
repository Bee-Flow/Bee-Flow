/**
 * Measuring a goal (./goalMeasure.mts) with the real goal store on PGlite and the runner handed in: the approved
 * check runs once as a dry run, runs that end within fifteen minutes are measured once, a check that is refused or
 * fails is kept as a failed measurement and never thrown, and an item without an approved check is not touched.
 *
 * Run: cd server && node --test core/cowork/goals/goalMeasure.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { measureAfterRun, start, stop, MEASURE_WINDOW_MS } = require('./goalMeasure.mts');
const { runEnded } = require('../runEnded.mts');
const { fakeLookups } = require('../plan/plan.testkit');
const { literal, checkOf, goalStoreOnPglite } = require('./goals.testkit');

const { pg, store, addItem, nextSeq } = goalStoreOnPglite({ onClose: stop });

const COUNT = { id: 'count', type: 'set', fields: { met: literal(46), total: literal(49), period: literal('this week') } };
const CHECK = checkOf([{ id: 'mail', type: 'integration_action', tool: 'outlook_search', inputs: {} }, COUNT]);

/** An item with an approved check; answers the item and what the runner was asked. */
async function world({ definition = CHECK, run = async () => ({ id: 'ar-1', status: 'success', lastOutput: { met: 46, total: 49, period: 'this week' } }), owner = 'ann' } = {}) {
    const id = await addItem('w');
    await store.saveGoal({ scheduleId: id, userId: 'ann', sentence: 'Every supplier mail gets an answer within two working days', targetPercent: 95 });
    await store.setCheck(id, 'auto-check');
    await store.approveCheck(id, { definition, fingerprint: 'f'.repeat(64) });
    const asked = [];
    let clock = new Date('2026-11-23T09:00:00Z');
    const deps = {
        store,
        // The check's automation as it is now: changed since the approval.
        getAutomation: async (automationId) => ({ id: automationId, userId: owner, organizationId: 'org-1', definition: checkOf([{ id: 'other', type: 'set', fields: {} }]) }),
        isManaged: async () => false,
        executeAutomation: async (automation, opts) => { asked.push({ automation, opts }); return run(automation, opts); },
        lookups: fakeLookups(),
        now: () => clock,
    };
    return { item: { id, userId: 'ann', title: 'Supplier radar' }, deps, asked, later: (ms) => { clock = new Date(clock.getTime() + ms); } };
}

test('the approved check runs once as a dry run, as approved, and its count is kept', async () => {
    const { item, deps, asked } = await world();
    assert.strictEqual(await measureAfterRun(item, 'run-1', deps), 'measured');
    assert.strictEqual(asked.length, 1);
    const { automation, opts } = asked[0];
    assert.deepStrictEqual([opts.mode, opts.triggerKind, opts.pausesRequested, opts.startedByUserId], ['dry_run', 'dry_run', false, 'ann']);
    assert.deepStrictEqual(automation.definition.steps.map((s) => s.id), ['mail', 'count'], 'the approved definition, not the automation of the moment');
    const [result] = await store.listResults(item.id);
    assert.deepStrictEqual([result.runId, result.met, result.total, result.period, result.ok, result.error], ['run-1', 46, 49, 'this week', true, null]);
});

test('two runs that end within fifteen minutes are measured once; the next window measures again', async () => {
    const { item, deps, asked, later } = await world();
    assert.strictEqual(await measureAfterRun(item, 'run-a', deps), 'measured');
    later(10 * 60_000);
    assert.strictEqual(await measureAfterRun(item, 'run-b', deps), 'coalesced');
    assert.strictEqual(asked.length, 1, 'the second run did not start the check');
    later(MEASURE_WINDOW_MS - 10 * 60_000);
    assert.strictEqual(await measureAfterRun(item, 'run-c', deps), 'measured');
    assert.deepStrictEqual((await store.listResults(item.id)).map((r) => r.runId), ['run-c', 'run-a']);
});

test('a check that would change, send or ask a model is refused at measurement, and nothing runs', async () => {
    const steps = [
        { id: 'send', type: 'integration_action', tool: 'outlook_compose', inputs: { to: literal('boss@example.com') } },
        { id: 'judge', type: 'ai_step', prompt: 'Judge them.' },
        { id: 'draft', type: 'integration_action', tool: 'outlook_create_draft', inputs: {} },
    ];
    for (const step of steps) {
        const { item, deps, asked } = await world({ definition: checkOf([step, COUNT]) });
        assert.strictEqual(await measureAfterRun(item, `run-${step.id}`, deps), 'failed');
        assert.strictEqual(asked.length, 0, `${step.id}: the runner was not asked`);
        const [result] = await store.listResults(item.id);
        assert.strictEqual(result.ok, false);
        assert.match(result.error, /^The check may not run: A goal's check/);
    }
});

test('a check that throws, fails or ends without a count is a failed measurement, never an error', async () => {
    const cases = [
        [async () => { throw new Error('the engine broke'); }, /^The check could not run/],
        [async () => ({ id: 'ar', status: 'error', error: 'Step "mail" failed' }), /did not finish \(error\): Step "mail" failed/],
        [async () => ({ id: 'ar', status: 'success', lastOutput: { met: 'many' } }), /two whole numbers/],
    ];
    for (const [run, reason] of cases) {
        const { item, deps } = await world({ run });
        assert.strictEqual(await measureAfterRun(item, `run-${nextSeq()}`, deps), 'failed');
        const [result] = await store.listResults(item.id);
        assert.deepStrictEqual([result.ok, result.met, result.total], [false, null, null]);
        assert.match(result.error, reason);
    }
    const handedOver = await world({ owner: 'someone-else' });
    assert.strictEqual(await measureAfterRun(handedOver.item, 'run-x', handedOver.deps), 'failed');
    assert.strictEqual(handedOver.asked.length, 0, 'a check of someone else does not run');
});

test('an item without a goal, or without an approved check, is not touched', async () => {
    const { deps, asked } = await world();
    assert.strictEqual(await measureAfterRun({ id: 'no-goal', userId: 'ann' }, 'run-n', deps), 'no_check');
    await pg.query('INSERT INTO cowork_schedules (id) VALUES ($1)', ['w-unapproved']);
    await store.saveGoal({ scheduleId: 'w-unapproved', userId: 'ann', sentence: 'A goal', targetPercent: 100 });
    assert.strictEqual(await measureAfterRun({ id: 'w-unapproved', userId: 'ann' }, 'run-u', deps), 'no_check');
    assert.strictEqual(asked.length, 0);
});

test('started, it hears the runs that end and measures after them', async () => {
    const { item, deps, asked } = await world();
    assert.strictEqual(start(deps), true);
    assert.strictEqual(start(deps), false, 'a second start does nothing');
    runEnded(item, 'run-heard');
    for (let i = 0; i < 50 && (await store.listResults(item.id)).length === 0; i++) await new Promise((r) => { setTimeout(r, 10); });
    stop();
    assert.strictEqual(asked.length, 1);
    assert.deepStrictEqual((await store.listResults(item.id)).map((r) => r.runId), ['run-heard']);
});
