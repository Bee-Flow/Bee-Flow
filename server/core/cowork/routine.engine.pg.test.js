// @typecheck
/**
 * The 2.1 proof of "make it routine": a routine reproduces the recorded run it was made from. A run the AI made is in
 * the item's history; the routine is a plan of fixed steps; a try-out of it runs on the REAL automation engine and
 * stores (PGlite behind db.js), and the side-by-side comparison (usecases/coworkRoutine.mts) finds every item of the
 * recorded run in the routine's result. Nothing is delivered by the try-out.
 *
 * Run: cd server && node --test core/cowork/routine.engine.pg.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { coworkOnEngine, triedOut } = require('./coworkEngine.testkit');

const { pg, store } = coworkOnEngine();
const automationStore = require('../../stores/automationStore');
const { attachPlan } = require('../../usecases/coworkPlan.mts');
const { compareTry } = require('../../usecases/coworkRoutine.mts');

const OWNER = 'u-routine';
const ITEMS = [
    'EU publishes the timetable for the next AI Act duties',
    'Two new open models for document reading',
    'Survey: builders use AI mostly for quotes',
    'Dutch regulator answers questions on AI and personnel files',
];
const literal = (/** @type {unknown} */ value) => ({ kind: 'literal', value });

/** The routine: the digest as fixed data, then the result for the owner. */
function routine(lines) {
    const steps = [
        { id: 'facts', type: 'set', label: 'Collect this week\'s items', fields: { digest: literal(lines.map((l) => `- ${l}`).join('\n')) } },
        { id: 'tell', type: 'notification', label: 'Send me the digest', title: 'AI news digest', body: '{{steps.facts.output.digest}}', channels: ['notification'] },
    ];
    const ids = ['trg', ...steps.map((s) => s.id)];
    return { schemaVersion: 1, trigger: { id: 'trg', type: 'trigger', kind: 'manual', output: {} }, steps, edges: ids.slice(1).map((to, i) => ({ from: ids[i], to })), vars: {} };
}

async function itemWithRecordedRun() {
    const s = await store.createSchedule({ userId: OWNER, title: 'AI news digest', prompt: 'Find this week\'s AI news.', repeatInterval: 'weekly', nextRunAt: new Date(Date.now() + 86_400_000).toISOString() });
    const id = /** @type {{ id: string }} */ (s).id;
    const runId = /** @type {string} */ (await store.markRunning(id, { triggerKind: 'manual' }));
    await store.markCompleted(id, `This week:\n${ITEMS.map((l) => `- ${l}`).join('\n')}`, { runId });
    return /** @type {any} */ (await store.getSchedule(id));
}

test('a routine that finds what the AI found reproduces the recorded run, item by item, and delivers nothing', async () => {
    const item = await itemWithRecordedRun();
    const automation = await automationStore.createAutomation({ userId: OWNER, title: 'AI news digest', definition: routine(ITEMS), triggerType: 'manual' });
    const attached = await attachPlan({ item, automationId: automation.id });
    assert.deepStrictEqual(attached.draft.findings, []);
    const withPlan = /** @type {any} */ (await store.getSchedule(item.id));
    const delivered = async () => (await pg.query(`SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_name = 'notifications'`)).rows[0].n
        ? (await pg.query('SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1', [OWNER])).rows[0].n : 0;
    const before = await delivered();

    const comparison = await compareTry({ item: withPlan, tryId: await triedOut(withPlan) });
    assert.deepStrictEqual([comparison.before, comparison.same, comparison.onlyBefore], [4, 4, []], 'every item of the recorded run is in the routine\'s result');
    assert.match(comparison.afterText, /EU publishes the timetable/);
    assert.strictEqual(await delivered(), before, 'the try-out delivered nothing');
});

test('a routine that misses an item says which one', async () => {
    const item = await itemWithRecordedRun();
    const automation = await automationStore.createAutomation({ userId: OWNER, title: 'AI news digest', definition: routine(ITEMS.slice(0, 3)), triggerType: 'manual' });
    await attachPlan({ item, automationId: automation.id });
    const withPlan = /** @type {any} */ (await store.getSchedule(item.id));
    const comparison = await compareTry({ item: withPlan, tryId: await triedOut(withPlan) });
    assert.deepStrictEqual([comparison.before, comparison.same], [4, 3]);
    assert.deepStrictEqual(comparison.onlyBefore, ['Dutch regulator answers questions on AI and personnel files']);
});

test('a plan with a script runs it outside the API process on the real engine, and hands its result to the next step', async () => {
    const steps = [
        { id: 'facts', type: 'set', label: 'The numbers', fields: { amounts: literal([120, 80, 45]) } },
        { id: 'sum', type: 'code', label: 'Add them up', code: 'return { total: inputs.amounts.reduce((a, b) => a + b, 0) }', inputs: { amounts: { kind: 'ref', path: 'steps.facts.output.amounts' } } },
        { id: 'tell', type: 'notification', label: 'Send me the total', title: 'Total', body: 'Total: {{steps.sum.output.result.total}}', channels: ['notification'] },
    ];
    const ids = ['trg', ...steps.map((s) => s.id)];
    const definition = { schemaVersion: 1, trigger: { id: 'trg', type: 'trigger', kind: 'manual', output: {} }, steps, edges: ids.slice(1).map((to, i) => ({ from: ids[i], to })), vars: {} };
    const s = await store.createSchedule({ userId: OWNER, title: 'Totals', prompt: 'Add up the amounts.', repeatInterval: 'daily', nextRunAt: new Date(Date.now() + 86_400_000).toISOString() });
    const item = /** @type {any} */ (await store.getSchedule(/** @type {any} */ (s).id));
    const automation = await automationStore.createAutomation({ userId: OWNER, title: 'Totals', definition, triggerType: 'manual' });
    const attached = await attachPlan({ item, automationId: automation.id });
    assert.deepStrictEqual(attached.draft.findings, [], 'a script is part of a plan');
    const tryId = await triedOut(/** @type {any} */ (await store.getSchedule(item.id)));
    const rows = await automationStore.getRunSteps(tryId);
    const sum = rows.find((r) => r.stepId === 'sum');
    assert.deepStrictEqual(sum?.output?.result, { total: 245 }, 'the script ran');
    const tell = rows.find((r) => r.stepId === 'tell');
    assert.match(JSON.stringify(tell?.output), /Total: 245/);
});
