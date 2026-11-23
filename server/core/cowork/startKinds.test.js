// @typecheck
/**
 * A plan that starts on an event is checked as one whose trigger brings outside text (./startKinds.mts): what the
 * event sent may fill content, never a recipient.
 *
 * Run: cd server && node --test core/cowork/startKinds.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { asStartedBy, startsWithOutsideText } = require('./startKinds.mts');
const { checkPlan } = require('./plan/planChecks.mts');
const { fakeLookups, planOf, literal } = require('./plan/plan.testkit');

const lookups = fakeLookups();
/** Mail the address the trigger brought. */
const plan = planOf([{ id: 'send', type: 'integration_action', label: 'Mail it', tool: 'outlook_compose', inputs: { to: { kind: 'ref', path: 'trigger.output.body.email' }, body: literal('Thanks') } }]);

test('on the clock the trigger is Bee Flow\'s own; on any event its data is outside text and may not pick a recipient', () => {
    assert.ok(!checkPlan(asStartedBy(plan, { triggerKind: 'schedule' }), lookups).some((f) => /outside/i.test(f.code)), 'on the clock nothing outside reaches the recipient');
    for (const kind of ['webhook', 'after_cowork', 'row', 'file', 'app_event']) {
        assert.ok(startsWithOutsideText(kind), kind);
        const findings = checkPlan(asStartedBy(plan, { triggerKind: kind }), lookups);
        assert.ok(findings.length > 0, `refused when it starts on ${kind}`);
    }
    assert.strictEqual(asStartedBy(plan, { triggerKind: 'webhook' }).steps, plan.steps, 'the plan itself is not changed');
});
