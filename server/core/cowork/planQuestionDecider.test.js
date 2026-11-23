// @typecheck
/**
 * Who may decide a question a Cowork plan run asks (./planQuestionDecider.mts): the item's owner, or the colleague
 * who decides the item's questions NOW. The assignee the approval row was given when the run started decides nothing
 * by itself. The plan lookup and the shares are handed in.
 *
 * Run: cd server && node --test core/cowork/planQuestionDecider.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { mayDecideQuestion } = require('./planQuestionDecider.mts');

const QUESTION = { stepId: 'cowork_ask__send', runId: 'leg-2', rootRunId: 'leg-1', ownerId: 'owner', assigneeUserId: 'former' };

/** @param {{ plan?: { userId: string, scheduleId?: string } | null, approver?: string | null }} [p] */
function deps({ plan = { userId: 'owner', scheduleId: 'item-1' }, approver = 'current' } = {}) {
    /** @type {Array<[string, string]>} */
    const asked = [];
    return {
        asked,
        getPlanOfAutomationRun: async (/** @type {string} */ id) => { asked.push(['plan', id]); return plan; },
        approverOf: async (/** @type {string} */ id) => { asked.push(['approver', id]); return approver; },
    };
}

test('the owner and the current approver decide; a former approver, like anyone else, does not', async () => {
    const d = deps();
    assert.strictEqual(await mayDecideQuestion(QUESTION, 'owner', d), true);
    assert.strictEqual(await mayDecideQuestion(QUESTION, 'current', d), true);
    assert.strictEqual(await mayDecideQuestion(QUESTION, 'former', d), false, 'the row\'s assignee is no longer the approver');
    assert.strictEqual(await mayDecideQuestion(QUESTION, 'stranger', d), false);
    assert.deepStrictEqual(d.asked.slice(0, 1), [['plan', 'leg-1']], 'asked by the journey, not by the leg');
    assert.ok(d.asked.some(([what, id]) => what === 'approver' && id === 'item-1'), 'the shares of the item, as they are now');
});

test('an item nobody decides for any more: only its owner decides', async () => {
    assert.strictEqual(await mayDecideQuestion(QUESTION, 'former', deps({ approver: null })), false);
    assert.strictEqual(await mayDecideQuestion(QUESTION, 'owner', deps({ approver: null })), true);
});

test('a question whose run no Cowork run started any more is decided by the automation\'s owner alone', async () => {
    assert.strictEqual(await mayDecideQuestion(QUESTION, 'owner', deps({ plan: null })), true);
    assert.strictEqual(await mayDecideQuestion(QUESTION, 'former', deps({ plan: null })), false);
    assert.strictEqual(await mayDecideQuestion({ ...QUESTION, rootRunId: null, runId: null }, 'former', deps()), false);
});

test('an approval that is no Cowork question is none of Cowork\'s business: the rulebook decides', async () => {
    const d = deps();
    assert.strictEqual(await mayDecideQuestion({ ...QUESTION, stepId: 'ask' }, 'anyone', d), true);
    assert.strictEqual(await mayDecideQuestion({ ...QUESTION, stepId: null }, 'anyone', d), true);
    assert.deepStrictEqual(d.asked, [], 'nothing is read for it');
});
