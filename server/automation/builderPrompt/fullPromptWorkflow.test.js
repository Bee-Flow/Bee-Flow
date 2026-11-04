// @typecheck
/**
 * The plan-first loop in the builder's doctrine (fullPromptWorkflow.js): Plan
 * first asks before it plans and plans in plain words, every build ends with a
 * hand-over line read from the finalize result's `needs`, and batching stays
 * the way the other modes build.
 *
 * Run: cd server && node --test automation/builderPrompt/fullPromptWorkflow.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { FULL_PROMPT_WORKFLOW, LEAN_PLAN_FIRST_STEP, LEAN_HANDOVER_STEP } = require('./fullPromptWorkflow');

const flat = (/** @type {string} */ text) => text.replace(/\s+/g, ' ');

test('the full workflow has the Plan first loop: ask, plan, build, test, hand over', () => {
    const w = flat(FULL_PROMPT_WORKFLOW);
    assert.match(w, /## Plan first: ask, plan, build, test, hand over/);
    assert.match(w, /your first call is `builder_ask_questions`: at most 4 questions/);
    assert.match(w, /where it starts, where the data comes from, who is involved, what should exist at the end/);
    assert.match(w, /Its `prerequisites` are the "What is needed" list/);
    assert.match(w, /without step ids, tool names or paths/);
    assert.ok(!/Otherwise proceed/.test(w), 'nothing tells the model to skip the questions');
});

test('batching stays the way to build, and every build ends with "To use it:" from the finalize needs', () => {
    const w = flat(FULL_PROMPT_WORKFLOW);
    assert.match(w, /## Work in BATCHES/);
    assert.match(w, /This is how you BUILD\. In the Plan first work mode the questions and the written plan come first/);
    assert.match(w, /end with a line that starts with "To use it:" in the user's language/);
    for (const need of ['`activate`', '`share-form`', '`run-once`', '`connect:<app>`']) assert.ok(w.includes(need), need);
    assert.ok(w.indexOf('**Finalize**') < w.indexOf('**Hand over**'), 'the hand-over follows the finalize');
});

test('the lean sentences carry the same loop and hand-over without template markers', () => {
    for (const s of [LEAN_PLAN_FIRST_STEP, LEAN_HANDOVER_STEP]) {
        assert.equal(typeof s, 'string');
        assert.ok(!s.includes('${') && !s.includes('\n'), 'one plain line');
    }
    assert.match(LEAN_PLAN_FIRST_STEP, /first call `builder_ask_questions` \(at most 4 questions/);
    assert.match(LEAN_PLAN_FIRST_STEP, /"What is needed" list/);
    assert.match(LEAN_HANDOVER_STEP, /"To use it:"/);
    assert.match(LEAN_HANDOVER_STEP, /activate: switch it on; share-form: share the form link; run-once: run it once; connect:<app>: connect that app first/);
});
