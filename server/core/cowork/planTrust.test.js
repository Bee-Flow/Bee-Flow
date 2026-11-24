// @typecheck
/**
 * Trust per action and recipient (./planTrust.mts): the recipient a plan fixes, the steps a question is about, the
 * decisions that count, and the steps that go on their own only while the recipient and the ceiling still allow it.
 *
 * Run: cd server && node --test core/cowork/planTrust.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { recipientOf, sendsToOf, stepsUnder, trustedSteps, recordJourneyDecisions, ANY_RECIPIENT, OWNER_RECIPIENT } = require('./planTrust.mts');
const { fakeLookups, planOf, literal, supplierRadar } = require('./plan/plan.testkit');

const lookups = fakeLookups();
const send = { id: 'send', type: 'integration_action', label: 'Mail the supplier', tool: 'outlook_compose', inputs: { to: literal('Orders@Supplier.example'), body: literal('Hi') } };
const loop = { id: 'each', type: 'loop', items: '{{steps.mail.output.messages}}', body: [{ id: 'answer', type: 'integration_action', tool: 'outlook_reply_in_thread', inputs: { to: { kind: 'ref', path: 'loop.item.from' } } }] };
const plan = planOf([{ id: 'mail', type: 'integration_action', tool: 'outlook_search', inputs: {} }, send, loop]);

test('the recipient a plan fixes, or any recipient when the plan picks it from data', () => {
    assert.strictEqual(recipientOf(send), 'orders@supplier.example');
    assert.strictEqual(recipientOf(loop.body[0]), ANY_RECIPIENT);
    assert.deepStrictEqual(stepsUnder(plan, 'each', lookups).map((s) => s.id), ['answer']);
    assert.deepStrictEqual(stepsUnder(plan, 'send', lookups).map((s) => s.id), ['send']);
});

test('who each sending step reaches: a result its owner, a mail the address the plan fixes or any, and a step that sends nothing is left out', () => {
    assert.deepStrictEqual(sendsToOf(plan, lookups), { send: 'orders@supplier.example', answer: ANY_RECIPIENT });
    // The running example only drafts its replies (a change, not a send); its digest is a result for its owner.
    assert.deepStrictEqual(sendsToOf(supplierRadar(), lookups), { digest: OWNER_RECIPIENT });
    assert.deepStrictEqual(sendsToOf(null, lookups), {});
});

test('cc, bcc and attendees are recipients too: the key holds all of them, and one picked from data is any recipient', () => {
    const withCopies = { ...send, inputs: { ...send.inputs, cc: literal('Boss@Hoekstra.example'), bcc: literal('archive@hoekstra.example') } };
    assert.strictEqual(recipientOf(withCopies), 'archive@hoekstra.example,boss@hoekstra.example,orders@supplier.example');
    assert.strictEqual(recipientOf({ ...send, inputs: { ...send.inputs, cc: { kind: 'ref', path: 'steps.mail.output.from' } } }), ANY_RECIPIENT, 'a cc the plan picks from data');
    assert.strictEqual(recipientOf({ ...send, inputs: { ...send.inputs, bcc: '{{steps.mail.output.from}}' } }), ANY_RECIPIENT, 'a bcc that is no literal');
    const meeting = { id: 'meet', type: 'integration_action', tool: 'calendar_create_event', inputs: { title: literal('Review'), attendees: literal(['B@x.example', 'a@x.example']) } };
    assert.strictEqual(recipientOf(meeting), 'a@x.example,b@x.example');
    assert.strictEqual(recipientOf({ ...meeting, inputs: { attendees: { kind: 'ref', path: 'steps.mail.output.people' } } }), ANY_RECIPIENT);
    assert.strictEqual(recipientOf({ ...send, inputs: { ...send.inputs, cc: literal('') } }), 'orders@supplier.example', 'an empty cc names nobody');
    assert.strictEqual(recipientOf({ ...send, inputs: { body: literal('Hi') } }), ANY_RECIPIENT, 'no recipient field at all');
});

test('trust earned to one recipient does not carry over to a step that also copies someone in', () => {
    const rows = [{ stepId: 'send', recipient: 'orders@supplier.example', letThrough: 6, trusted: true }];
    const copied = planOf([{ ...send, inputs: { ...send.inputs, bcc: literal('someone-else@x.example') } }]);
    assert.deepStrictEqual([...trustedSteps(copied, rows, 'on_its_own')], [], 'a bcc added later has earned nothing');
    const picked = planOf([{ ...send, inputs: { ...send.inputs, cc: { kind: 'ref', path: 'steps.mail.output.from' } } }]);
    assert.deepStrictEqual([...trustedSteps(picked, rows, 'on_its_own')], [], 'a cc picked from data is not the trusted recipient');
});

test('a trusted step goes on its own only to the same recipient, and only while the ceiling allows it', () => {
    const rows = [{ stepId: 'send', recipient: 'orders@supplier.example', letThrough: 6, trusted: true }, { stepId: 'answer', recipient: '*', letThrough: 2, trusted: false }];
    assert.deepStrictEqual([...trustedSteps(plan, rows, 'on_its_own')], ['send']);
    assert.deepStrictEqual([...trustedSteps(plan, rows, 'asks_before_sending')], [], 'below "on its own" nothing is trusted');
    const moved = planOf([{ ...send, inputs: { to: literal('someone-else@x.example') } }]);
    assert.deepStrictEqual([...trustedSteps(moved, rows, 'on_its_own')], [], 'a new recipient has earned nothing');
});

test('the decisions of a journey count per step and recipient; an expired question counts for nothing', async () => {
    /** @type {any[]} */
    const recorded = [];
    const deps = {
        decisionsOfJourney: async () => [
            { stepId: 'cowork_ask__send', status: 'approved' },
            { stepId: 'cowork_ask__each', status: 'rejected' },
            { stepId: 'cowork_ask__send', status: 'expired' },
        ],
        recordDecision: async (/** @type {any[]} */ ...a) => { recorded.push(a); },
        lookups,
    };
    assert.strictEqual(await recordJourneyDecisions({ scheduleId: 'w1', definition: plan }, 'journey-1', deps), 2);
    assert.deepStrictEqual(recorded, [['w1', 'send', 'orders@supplier.example', true], ['w1', 'answer', '*', false]]);
});
