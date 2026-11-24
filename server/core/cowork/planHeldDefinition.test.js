/**
 * The definition a plan's journey keeps across a pause (./planHeldDefinition.mts): the plan as approved, with the
 * run's notifications held to the owner, and only for a journey a Cowork run started, and only while the organisation's
 * Cowork policy still lets it go on. The store read and the policy are handed in.
 *
 * Run: cd server && node --test core/cowork/planHeldDefinition.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { heldPlanDefinition } = require('./planHeldDefinition.mts');
const { planFingerprint } = require('./plan/planPermissions.mts');
const { OWNER_ONLY_NOTIFICATIONS } = require('./plan/planRunCopy.mts');
const { supplierRadar, fakeLookups, withVerdicts } = require('./plan/plan.testkit');
const { OPEN_POLICY } = require('../entitlements/coworkPolicy.mts');

const plan = (over = {}) => ({ automationId: 'auto-1', userId: 'owner-1', definition: supplierRadar(), fingerprint: planFingerprint(supplierRadar()), ...over });

function deps(answer, policy = OPEN_POLICY) {
    const asked = [];
    const policyAsked = [];
    return {
        asked, policyAsked, lookups: fakeLookups(),
        getPlanOfAutomationRun: async (id) => { asked.push(id); return answer; },
        policyOf: async (userId) => { policyAsked.push(userId); return policy; },
    };
}

test('a journey a plan run started continues on the approved copy, with its notifications held to the owner', async () => {
    const d = deps(plan());
    const held = await heldPlanDefinition({ id: 'leg-2', rootRunId: 'leg-1', automationId: 'auto-1' }, d);
    const { notificationSettings, ...steps } = held;
    assert.deepStrictEqual(steps, withVerdicts(supplierRadar()), 'the approved copy, its AI steps asked for their verdict');
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

test('a run continues only while the organisation\'s policy still lets it: asked again for the owner on every continuation', async () => {
    const d = deps(plan());
    assert.ok(await heldPlanDefinition({ id: 'leg-1', automationId: 'auto-1' }, d));
    assert.deepStrictEqual(d.policyAsked, ['owner-1']);
    const readOnly = deps(plan(), { ...OPEN_POLICY, readOnly: true });
    await assert.rejects(heldPlanDefinition({ id: 'leg-1', automationId: 'auto-1' }, readOnly), { name: 'ContinuationRefused', message: /made Cowork read-only/ }, 'a refusal in words for the owner');
    const unreadable = deps(plan(), { ...OPEN_POLICY, unreadable: true });
    await assert.rejects(heldPlanDefinition({ id: 'leg-1', automationId: 'auto-1' }, unreadable), /policy could not be read/);
});

test('an app the organisation took off the unattended list while the run waited stops the continuation, with the reason', async () => {
    const fenced = deps(plan(), { ...OPEN_POLICY, unattendedApps: ['datatables'] });
    await assert.rejects(heldPlanDefinition({ id: 'leg-1', automationId: 'auto-1' }, fenced), /does not let outlook run while nobody watches, so this run does not continue/);
    const allowed = deps(plan(), { ...OPEN_POLICY, unattendedApps: ['outlook', 'datatables'] });
    assert.ok(await heldPlanDefinition({ id: 'leg-1', automationId: 'auto-1' }, allowed));
});
