// @typecheck
/**
 * The rules of a task's set-up (./taskSetup.mts): when a task waits for its owner, what its owner chose to send to as
 * the last line of the brief, an address by plain string checks, and the class of what ended a set-up.
 *
 * Run: cd server && node --test core/cowork/taskSetup.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { heldForSetup, setupProblemOf, isAddress, sendsToOf, recipientsLine, briefWithRecipients, causeOf, SETUP_GRACE_MS } = require('./taskSetup.mts');

const NOW = new Date('2026-11-24T12:00:00.000Z');
const ago = (/** @type {number} */ ms) => new Date(NOW.getTime() - ms).toISOString();

test('a task that was to get steps waits until a plan of it is approved, or its owner chose the AI', () => {
    assert.strictEqual(heldForSetup({ setup: { steps: 'wanted', cause: null, since: null } }), true);
    assert.strictEqual(heldForSetup({ setup: { steps: 'failed', cause: 'timeout', since: null } }), true);
    assert.strictEqual(heldForSetup({ setup: { steps: 'wanted', cause: null, since: null }, planAutomationId: 'auto-1' }), true, 'steps that wait for approval do not run yet');
    assert.strictEqual(heldForSetup({ setup: { steps: 'wanted', cause: null, since: null }, planAutomationId: 'auto-1', planId: 'plan-1' }), false, 'approved');
    assert.strictEqual(heldForSetup({ setup: { steps: 'ai', cause: null, since: null } }), false, 'its owner let the AI work it out');
    assert.strictEqual(heldForSetup({ setup: null }), false, 'a task nobody set up this way runs as it always did');
    assert.strictEqual(heldForSetup({}), false);
});

test('why a waiting task has no steps to look at: it failed, or it never ended; not while it is on the go or a plan waits', () => {
    assert.strictEqual(setupProblemOf({ setup: { steps: 'failed', cause: 'no_model', since: ago(1000) } }, NOW), 'no_model');
    assert.strictEqual(setupProblemOf({ setup: { steps: 'failed', cause: null, since: null } }, NOW), 'failed');
    assert.strictEqual(setupProblemOf({ setup: { steps: 'wanted', cause: null, since: ago(5_000) } }, NOW), null, 'the set-up is on the go');
    assert.strictEqual(setupProblemOf({ setup: { steps: 'wanted', cause: null, since: ago(SETUP_GRACE_MS + 1) } }, NOW), 'left', 'it never ended');
    assert.strictEqual(setupProblemOf({ setup: { steps: 'wanted', cause: null, since: null } }, NOW), 'left');
    assert.strictEqual(setupProblemOf({ setup: { steps: 'failed', cause: 'timeout', since: null }, planAutomationId: 'auto-1' }, NOW), null, 'its plan card asks for it');
    assert.strictEqual(setupProblemOf({ setup: { steps: 'ai', cause: null, since: null } }, NOW), null);
});

test('an address is checked with plain string rules', () => {
    for (const ok of ['sam@example.com', ' sam.de.vries@mail.example.nl ', 'a@b.co']) assert.strictEqual(isAddress(ok), true, ok);
    for (const bad of ['', 'sam', 'sam@', '@example.com', 'sam@example', 'sam@@example.com', 'sam @example.com', 'sam@example..com', 'sam@example.com,jo@example.com', 'sam@.com', 'sam@example.']) {
        assert.strictEqual(isAddress(bad), false, bad);
    }
    assert.strictEqual(isAddress(`${'a'.repeat(320)}@example.com`), false, 'too long');
});

test('who a task sends to: "me" apart, each address once, anything else left out', () => {
    assert.deepStrictEqual(sendsToOf(['me', 'sam@example.com', 'SAM@example.com', 'not an address']), { me: true, others: ['sam@example.com'] });
    assert.deepStrictEqual(sendsToOf(['sam@example.com']), { me: false, others: ['sam@example.com'] }, 'its owner took themselves off');
    assert.deepStrictEqual(sendsToOf([]), { me: false, others: [] });
});

test('the recipients reach whoever does the work as the last line of the brief; the brief itself stays as written', () => {
    assert.strictEqual(recipientsLine({ me: true, others: ['sam@example.com'] }), 'Send the result to: me, sam@example.com.');
    assert.strictEqual(recipientsLine({ me: true, others: [] }), 'Send the result to: me.');
    assert.strictEqual(recipientsLine({ me: false, others: [] }), 'Send the result to nobody: only write it.');
    assert.strictEqual(recipientsLine(null), null);
    assert.strictEqual(
        briefWithRecipients('Summarise last week’s meetings. ', { sendsTo: { me: true, others: ['sam@example.com'] } }),
        'Summarise last week’s meetings.\n\nSend the result to: me, sam@example.com.',
    );
    assert.strictEqual(briefWithRecipients('Summarise.', null), 'Summarise.', 'nothing chosen: nothing added');
    assert.strictEqual(briefWithRecipients('Summarise.', { sendsTo: null }), 'Summarise.');
});

test('what ended a set-up, as a class: the planner\'s own refusals by their code, a caller that left, else just failed', () => {
    assert.strictEqual(causeOf({ code: 'cowork_planner_no_model', status: 409 }), 'no_model');
    assert.strictEqual(causeOf({ code: 'cowork_planner_timeout', status: 504 }), 'timeout');
    assert.strictEqual(causeOf({ code: 'cowork_planner_empty', status: 422 }), 'unclear');
    assert.strictEqual(causeOf({ code: 'cowork_budget_used', status: 409 }), 'budget');
    assert.strictEqual(causeOf({ code: 'cowork_plan_refused', status: 403 }), 'not_available');
    assert.strictEqual(causeOf(new Error('connect ECONNREFUSED')), 'failed');
    assert.strictEqual(causeOf(Object.assign(new Error('stopped'), { name: 'AbortError' })), 'left');
    assert.strictEqual(causeOf(new Error('anything'), true), 'left');
    assert.strictEqual(causeOf(null), 'failed');
});
