// @typecheck strict
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { experimentWarnings } = require('./experiments');

const codes = (/** @type {unknown} */ content) => experimentWarnings({ content }, 'c').map(w => w.code);

test('a block without experiment fields has no warnings', () => {
    assert.deepEqual(codes({ title: 'Hello' }), []);
    assert.deepEqual(experimentWarnings(null, 'c'), []);
    assert.deepEqual(experimentWarnings({ content: 'text' }, 'c'), []);
});

test('a complete experiment passes', () => {
    assert.deepEqual(codes({ abKey: 'hero-title', abAlt: { title: 'B' }, abShare: 30, abGoal: 'signup' }), []);
    assert.deepEqual(codes({ abKey: 'hero-title', abAlt: { title: 'B' } }), []);
});

test('a bad key, a missing alternative, a bad share and a bad goal are each reported', () => {
    assert.deepEqual(codes({ abKey: 'Hero Title', abAlt: { a: 1 } }), ['bad_experiment_key']);
    assert.deepEqual(codes({ abKey: 'k' }), ['bad_experiment_alt']);
    assert.deepEqual(codes({ abKey: 'k', abAlt: {} }), ['bad_experiment_alt']);
    assert.deepEqual(codes({ abKey: 'k', abAlt: { a: 1 }, abShare: 100 }), ['bad_experiment_share']);
    assert.deepEqual(codes({ abKey: 'k', abAlt: { a: 1 }, abShare: '50' }), ['bad_experiment_share']);
    assert.deepEqual(codes({ abKey: 'k', abAlt: { a: 1 }, abGoal: 'Sign up!' }), ['bad_experiment_goal']);
});

test('warning paths point into the block content', () => {
    const [w] = experimentWarnings({ content: { abKey: 'k' } }, 'pages.p1.blocks[2].content');
    assert.equal(w.path, 'pages.p1.blocks[2].content.abAlt');
});

test('an alternative that changes consent, fields or the automation is flagged on any block', () => {
    const w = experimentWarnings({ type: 'hero', content: { abKey: 'k', abAlt: { consent: { text: 'x' }, automationId: 'a', title: 'B' } } }, 'c');
    assert.deepEqual(w.map(x => x.code), ['experiment_alt_forbidden', 'experiment_alt_forbidden']);
    assert.deepEqual(w.map(x => x.path), ['c.abAlt.consent', 'c.abAlt.automationId']);
});

test('fields are also forbidden in the alternative of a form, and a form or support block runs no test', () => {
    const alt = { fields: [] };
    assert.deepEqual(codes({ abKey: 'k', abAlt: alt }), []);
    const form = experimentWarnings({ type: 'form', content: { abKey: 'k', abAlt: alt } }, 'c').map(x => x.code);
    assert.deepEqual(form, ['experiment_on_submission_block', 'experiment_alt_forbidden']);
    const support = experimentWarnings({ type: 'customer-support', content: { abKey: 'k', abAlt: { title: 'B' } } }, 'c').map(x => x.code);
    assert.deepEqual(support, ['experiment_on_submission_block']);
});
