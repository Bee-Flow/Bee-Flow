// @typecheck
/**
 * Cowork's closed list of step types (./coworkStepList.mts), held against the automation engine's own list: every
 * type the engine can run is either allowed in a plan, refused with a reason a person can read, or an annotation. A
 * new engine step type fails here until someone decides which of the three it is.
 *
 * Run: cd server && node --test core/cowork/plan/coworkStepList.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { kindOfStepType, refusalOfStepType, isAnnotation, planStepTypes, refusedStepTypes, PLAN_TRIGGER_KINDS } = require('./coworkStepList.mts');
const { VALID_STEP_TYPES, AI_STEP_TYPES } = require('../../automationModel/constants');

test('every step type the engine runs is allowed, refused with a reason, or an annotation: none is undecided', () => {
    const undecided = [...VALID_STEP_TYPES].filter((type) => kindOfStepType(type) === null && !refusedStepTypes().includes(type) && !isAnnotation(type));
    assert.deepStrictEqual(undecided, [], `decide in coworkStepList.mts whether a plan may hold: ${undecided.join(', ')}`);
});

test('no type is on two lists, and every listed type is one the engine knows', () => {
    const allowed = planStepTypes();
    const refused = refusedStepTypes();
    assert.deepStrictEqual(allowed.filter((type) => refused.includes(type) || isAnnotation(type)), []);
    const unknown = [...allowed, ...refused].filter((type) => !VALID_STEP_TYPES.has(type) && !AI_STEP_TYPES.includes(type));
    assert.deepStrictEqual(unknown, [], 'a type that is no engine type does not belong on either list');
});

test('a person reads four kinds of step', () => {
    assert.strictEqual(kindOfStepType('integration_action'), 'fixed');
    assert.strictEqual(kindOfStepType('datatable'), 'fixed');
    assert.strictEqual(kindOfStepType('ai_step'), 'ai');
    assert.strictEqual(kindOfStepType('data_extraction'), 'ai');
    assert.strictEqual(kindOfStepType('approval'), 'ask');
    assert.strictEqual(kindOfStepType('notification'), 'deliver');
});

test('every step type that calls a model reads as AI, or is refused', () => {
    for (const type of AI_STEP_TYPES) {
        assert.ok(kindOfStepType(type) === 'ai' || refusedStepTypes().includes(type), `${type} is a model call`);
    }
});

test('what the engine can do beyond a plan is refused with a sentence: a free web address, sub-flows', () => {
    for (const type of ['http_request', 'call_block', 'call_layer', 'parallel', 'form_page']) {
        assert.strictEqual(kindOfStepType(type), null, type);
        assert.match(refusalOfStepType(type), /^A plan /, type);
    }
});

test('a type nobody knows, or no type at all, is refused too, never allowed by default', () => {
    assert.strictEqual(kindOfStepType('teleport'), null);
    assert.match(refusalOfStepType('teleport'), /"teleport"/);
    assert.strictEqual(kindOfStepType(undefined), null);
    assert.match(refusalOfStepType(undefined), /without a type/);
    // A name that happens to be a property of every object is not a step type.
    assert.strictEqual(kindOfStepType('constructor'), null);
    assert.strictEqual(kindOfStepType('toString'), null);
});

test('a canvas note and the trigger node are annotations, skipped rather than refused', () => {
    assert.strictEqual(isAnnotation('note'), true);
    assert.strictEqual(isAnnotation('trigger'), true);
    assert.strictEqual(isAnnotation('code'), false);
});

test('a plan starts on the clock, by its owner, or on an app event', () => {
    assert.deepStrictEqual([...PLAN_TRIGGER_KINDS], ['schedule', 'manual', 'app_event']);
});

test('a script is on the list: it runs outside the API process with no network, no apps and no secrets', () => {
    assert.strictEqual(kindOfStepType('code'), 'fixed');
});
