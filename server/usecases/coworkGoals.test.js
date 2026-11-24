/**
 * The goal of a Cowork item (./coworkGoals.mts) with the real goal store on PGlite: writing it, the check in plain
 * words, approving exactly the check that was read, and refusing a check that would change, send or ask a model.
 *
 * Run: cd server && node --test usecases/coworkGoals.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { goalOf, saveGoal, draftCheck, approveCheck, removeGoal } = require('./coworkGoals.mts');
const { planFingerprint } = require('../core/cowork/plan/planPermissions.mts');
const { fakeLookups } = require('../core/cowork/plan/plan.testkit');
const { literal: lit, checkOf, goalStoreOnPglite } = require('../core/cowork/goals/goals.testkit');

const { store, addItem } = goalStoreOnPglite();

const READ = { id: 'mail', type: 'integration_action', label: 'Read the supplier mail of the week', tool: 'outlook_search', inputs: {} };
const COUNT = { id: 'count', type: 'set', label: 'Count', fields: { met: lit(46), total: lit(49) } };
const SENTENCE = 'Every supplier mail gets an answer within two working days';

/** An item of ann's, a check automation `auto-check` holding `definition`, and the deps around them. */
async function world(definition = checkOf([READ, COUNT]), { refusal = null } = {}) {
    const item = { id: await addItem('g'), userId: 'ann', title: 'Supplier radar', prompt: 'Answer the supplier mail.' };
    const automations = new Map([['auto-check', { id: 'auto-check', userId: 'ann', organizationId: 'org-1', kind: 'automation', definition }]]);
    const drafted = [];
    const deps = {
        store,
        getAutomation: async (id) => automations.get(id) ?? null,
        isManaged: async () => false,
        ownerRefusal: async () => refusal,
        draft: async (input) => { drafted.push(input); await store.setCheck(input.item.id, 'auto-check'); return { automationId: 'auto-check', summary: 'Counts the mail answered in time.', findings: [], rounds: 2 }; },
        lookups: fakeLookups(),
    };
    return { item, deps, automations, drafted };
}

test('a goal is written, its check drafted and read in plain words, approved as read, and measured counts shown', async () => {
    const { item, deps, drafted } = await world();
    assert.deepStrictEqual(await goalOf(item, deps), { goal: null });
    const written = await saveGoal({ item, sentence: `  ${SENTENCE} `, targetPercent: 95 }, deps);
    assert.deepStrictEqual([written.goal?.sentence, written.goal?.targetPercent, written.goal?.check, written.goal?.approved], [SENTENCE, 95, null, null]);

    const { summary, goal } = await draftCheck({ item, userOrgId: 'org-1' }, deps);
    assert.strictEqual(summary, 'Counts the mail answered in time.');
    assert.deepStrictEqual(drafted[0].goal, { sentence: SENTENCE, targetPercent: 95 });
    assert.deepStrictEqual(goal?.check?.steps.map((s) => [s.title, s.effect]), [['Read the supplier mail of the week', 'reads'], ['Count', 'reads']]);
    assert.deepStrictEqual([goal?.check?.readsOnly, goal?.check?.findings, goal?.approved, goal?.upToDate], [true, [], null, false]);

    const approved = await approveCheck({ item, fingerprint: goal?.check?.fingerprint }, deps);
    assert.deepStrictEqual([approved.goal?.upToDate, approved.goal?.approved?.fingerprint], [true, planFingerprint(checkOf([READ, COUNT]))]);
    assert.deepStrictEqual((await store.getGoal(item.id))?.approvedDefinition, checkOf([READ, COUNT]), 'the check is kept as approved');

    const at = (h) => new Date(`2026-11-2${h}T09:00:00Z`);
    await store.recordResult(item.id, { runId: 'r1', met: 40, total: 50, period: 'this week', ok: true, error: null, measuredAt: at(1) });
    await store.recordResult(item.id, { runId: 'r2', met: 46, total: 49, period: 'this week', ok: true, error: null, measuredAt: at(2) });
    await store.recordResult(item.id, { runId: 'r3', met: null, total: null, period: null, ok: false, error: 'The check did not finish (error)', measuredAt: at(3) });
    const shown = (await goalOf(item, deps)).goal;
    assert.deepStrictEqual(shown?.count, { met: 46, total: 49, percent: 94, period: 'this week', measuredAt: at(2).toISOString() });
    assert.strictEqual(shown?.trend, 'up');
    assert.deepStrictEqual(shown?.results.map((r) => [r.runId, r.ok]), [['r3', false], ['r2', true], ['r1', true]]);
});

test('a check with a change, a send or an AI step is refused at approval, and nothing is approved', async () => {
    const steps = [
        { id: 'draft', type: 'integration_action', label: 'Draft replies', tool: 'outlook_create_draft', inputs: {} },
        { id: 'send', type: 'integration_action', label: 'Mail the boss', tool: 'outlook_compose', inputs: { to: lit('boss@example.com') } },
        { id: 'judge', type: 'ai_step', label: 'Judge the answers', prompt: 'Were they good?' },
        { id: 'tell', type: 'notification', label: 'Tell me', title: 'x', body: 'y' },
    ];
    for (const step of steps) {
        const definition = checkOf([READ, step, COUNT]);
        const { item, deps } = await world(definition);
        await saveGoal({ item, sentence: SENTENCE, targetPercent: 100 }, deps);
        const { goal } = await draftCheck({ item }, deps);
        assert.strictEqual(goal?.check?.readsOnly, false, step.id);
        await assert.rejects(approveCheck({ item, fingerprint: planFingerprint(definition) }, deps), (e) => e.status === 422 && e.code === 'cowork_goal_check_not_allowed' && /A goal's check/.test(e.message), step.id);
        assert.strictEqual((await store.getGoal(item.id))?.approvedDefinition, null, `${step.id}: nothing approved`);
    }
});

test('approving a check that changed since it was read, or with no check, or for an owner the runner refuses, is refused', async () => {
    const { item, deps, automations } = await world();
    await saveGoal({ item, sentence: SENTENCE, targetPercent: 100 }, deps);
    await assert.rejects(approveCheck({ item, fingerprint: 'a'.repeat(64) }, deps), (e) => e.status === 409 && e.code === 'cowork_goal_refused');
    const { goal } = await draftCheck({ item }, deps);
    automations.set('auto-check', { ...automations.get('auto-check'), definition: checkOf([{ ...READ, label: 'Read more' }, COUNT]) });
    await assert.rejects(approveCheck({ item, fingerprint: goal?.check?.fingerprint }, deps), (e) => e.status === 409 && e.code === 'cowork_goal_check_changed');

    const refused = await world(checkOf([READ, COUNT]), { refusal: 'not_entitled' });
    await saveGoal({ item: refused.item, sentence: SENTENCE, targetPercent: 100 }, refused.deps);
    const drafted = await draftCheck({ item: refused.item }, refused.deps);
    await assert.rejects(approveCheck({ item: refused.item, fingerprint: drafted.goal?.check?.fingerprint }, refused.deps), (e) => e.status === 403);

    const other = await world();
    other.automations.set('auto-check', { ...other.automations.get('auto-check'), userId: 'someone-else' });
    await saveGoal({ item: other.item, sentence: SENTENCE, targetPercent: 100 }, other.deps);
    const seen = await draftCheck({ item: other.item }, other.deps);
    assert.strictEqual(seen.goal?.check, null, 'an automation of someone else is no check');
});

test('drafting needs a goal; taking the goal off leaves nothing', async () => {
    const { item, deps, drafted } = await world();
    await assert.rejects(draftCheck({ item }, deps), (e) => e.status === 409);
    assert.deepStrictEqual(drafted, []);
    await saveGoal({ item, sentence: SENTENCE, targetPercent: 100 }, deps);
    assert.deepStrictEqual(await removeGoal({ item }, deps), { goal: null });
    assert.deepStrictEqual(await goalOf(item, deps), { goal: null });
});
