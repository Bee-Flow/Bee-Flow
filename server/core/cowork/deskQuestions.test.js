// @typecheck
/**
 * The questions of an item on a desk (./deskQuestions.mts): they go to the holder of the item's role, to the stand-in
 * while the holder is away, move to the stand-in after one working day and say so; at the decision only the current
 * holder or stand-in (besides the owner) may decide, a former holder not (./planQuestionDecider.mts). Every part is
 * handed in.
 *
 * Run: cd server && node --test core/cowork/deskQuestions.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { questionRouteOf, routeForRole, workingDayHours, deskDecidersOf } = require('./deskQuestions.mts');
const { withAsks } = require('./plan/planIndependence.mts');
const { mayDecideQuestion } = require('./planQuestionDecider.mts');
const { fakeLookups, planOf, literal } = require('./plan/plan.testkit');

const TUESDAY = new Date('2026-11-24T09:00:00Z');
const FRIDAY = new Date('2026-11-27T09:00:00Z');
const ROLE = { deskId: 'd1', role: 'invoices', holderId: 'holder', standInId: 'stand-in', awayUntil: null };

test('one working day: 24 hours, or until Monday over a weekend', () => {
    assert.strictEqual(workingDayHours(TUESDAY), 24);
    assert.strictEqual(workingDayHours(FRIDAY), 72);
    assert.strictEqual(workingDayHours(new Date('2026-11-28T09:00:00Z')), 48, 'asked on a Saturday: Monday');
});

test('the holder is asked; unanswered within a working day it moves to the stand-in, and the question says so', () => {
    const route = routeForRole(ROLE, FRIDAY);
    assert.deepStrictEqual([route?.userId, route?.escalateTo, route?.escalateAfterHours], ['holder', 'stand-in', 72]);
    assert.match(String(route?.note), /within a working day, it moves to their stand-in/);
});

test('while the holder is away the stand-in is asked, and the question says why', () => {
    const route = routeForRole({ ...ROLE, awayUntil: '2026-12-01T00:00:00.000Z' }, TUESDAY);
    assert.deepStrictEqual([route?.userId, route?.escalateTo], ['stand-in', undefined]);
    assert.match(String(route?.note), /away until 2026-12-01, so this question went to their stand-in/);
    assert.strictEqual(routeForRole({ ...ROLE, awayUntil: '2026-11-01T00:00:00.000Z' }, TUESDAY)?.userId, 'holder', 'an absence in the past changes nothing');
    assert.strictEqual(routeForRole({ ...ROLE, holderId: null, standInId: null }, TUESDAY), null, 'a role nobody counts on asks nobody');
});

test('without a desk role, the colleague the item is shared with decides; without either, the owner', async () => {
    const deps = (/** @type {any} */ role, /** @type {string | null} */ approver) => ({ questionRoleOf: async () => role, approverOf: async () => approver, now: () => TUESDAY });
    assert.strictEqual((await questionRouteOf('w1', deps(ROLE, 'colleague')))?.userId, 'holder', 'the role comes first');
    assert.deepStrictEqual(await questionRouteOf('w1', deps(null, 'colleague')), { userId: 'colleague' });
    assert.strictEqual(await questionRouteOf('w1', deps(null, null)), null);
    assert.deepStrictEqual(await deskDecidersOf('w1', { questionRoleOf: async () => ROLE }), ['holder', 'stand-in']);
});

test('the question in front of a step carries the role\'s route: who is asked, where it moves, after how long', () => {
    const definition = planOf([{ id: 'send', type: 'integration_action', label: 'Mail the supplier', tool: 'outlook_compose', inputs: { to: literal('a@b.example'), subject: literal('S'), body: literal('B') } }]);
    const lookups = fakeLookups();
    const asked = withAsks(/** @type {any} */ (definition), 'asks_before_sending', lookups, new Set(), /** @type {any} */ (routeForRole(ROLE, TUESDAY)));
    const question = /** @type {any[]} */ (asked.steps).find((s) => s.id === 'cowork_ask__send');
    assert.ok(question, 'the question stands in front of the mail');
    assert.deepStrictEqual(question.approval, { assignee: { userId: 'holder' }, escalateTo: { userId: 'stand-in' }, escalateAfterHours: 24 });
    assert.match(question.prompt, /moves to their stand-in/);
    const plain = /** @type {any[]} */ (withAsks(/** @type {any} */ (definition), 'asks_before_sending', lookups, new Set(), 'colleague').steps).find((s) => s.id === 'cowork_ask__send');
    assert.deepStrictEqual(plain.approval, { assignee: { userId: 'colleague' } }, 'a colleague\'s id still works as before');
});

test('at the decision: the current holder and stand-in decide; a former holder does not', async () => {
    const approval = { stepId: 'cowork_ask__send', runId: 'ar1', ownerId: 'owner' };
    let current = ROLE;
    const deps = {
        getPlanOfAutomationRun: async () => ({ userId: 'owner', scheduleId: 'w1' }),
        approverOf: async () => null,
        deskDecidersOf: (/** @type {string} */ id) => deskDecidersOf(id, { questionRoleOf: async () => current }),
    };
    assert.strictEqual(await mayDecideQuestion(approval, 'holder', deps), true);
    assert.strictEqual(await mayDecideQuestion(approval, 'stand-in', deps), true);
    current = { ...ROLE, holderId: 'new-holder' };
    assert.strictEqual(await mayDecideQuestion(approval, 'holder', deps), false, 'the former holder is refused');
    assert.strictEqual(await mayDecideQuestion(approval, 'owner', deps), true, 'the owner always decides');
});
