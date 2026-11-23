/**
 * The definition a plan's journey keeps across a pause (./planHeldDefinition.mts): the plan as approved, with the
 * run's notifications held to the owner, and only for a journey a Cowork run started. The store read is handed in.
 *
 * Run: cd server && node --test core/cowork/planHeldDefinition.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { heldPlanDefinition } = require('./planHeldDefinition.mts');
const { planFingerprint } = require('./plan/planPermissions.mts');
const { OWNER_ONLY_NOTIFICATIONS } = require('./plan/planRunCopy.mts');
const { supplierRadar } = require('./plan/plan.testkit');

const plan = (over = {}) => ({ automationId: 'auto-1', definition: supplierRadar(), fingerprint: planFingerprint(supplierRadar()), ...over });

function deps(answer) {
    const asked = [];
    return { asked, getPlanOfAutomationRun: async (id) => { asked.push(id); return answer; } };
}

test('a journey a plan run started continues on the approved copy, with its notifications held to the owner', async () => {
    const d = deps(plan());
    const held = await heldPlanDefinition({ id: 'leg-2', rootRunId: 'leg-1', automationId: 'auto-1' }, d);
    const { notificationSettings, ...steps } = held;
    assert.deepStrictEqual(steps, supplierRadar());
    assert.strictEqual(notificationSettings, OWNER_ONLY_NOTIFICATIONS);
    assert.deepStrictEqual(d.asked, ['leg-1'], 'asked by the journey, not by the leg');
});

test('the first leg is its own journey', async () => {
    const d = deps(plan());
    await heldPlanDefinition({ id: 'leg-1', automationId: 'auto-1' }, d);
    assert.deepStrictEqual(d.asked, ['leg-1']);
});

test('a journey no Cowork run started is none of Cowork\'s business', async () => {
    assert.strictEqual(await heldPlanDefinition({ id: 'leg-1', automationId: 'auto-1' }, deps(null)), null);
    assert.strictEqual(await heldPlanDefinition({ automationId: 'auto-1' }, deps(plan())), null);
});

test('a copy changed behind the plan\'s back, or one of another automation, stops the journey', async () => {
    await assert.rejects(heldPlanDefinition({ id: 'leg-1', automationId: 'auto-1' }, deps(plan({ fingerprint: 'f'.repeat(64) }))), /not the one that was approved/);
    await assert.rejects(heldPlanDefinition({ id: 'leg-1', automationId: 'auto-2' }, deps(plan())), /another automation/);
});
