'use strict';

/**
 * When a playbook's model call fails (playbooks/modelFailure.js): the person
 * gets a fixed sentence and an id, the operator's log gets the error under
 * that id. The three callers (composeRecipe, designPhase, accessPlan) pin the
 * sentence each of them answers; this file pins the shape they share.
 *
 * Run: cd server && node --test playbooks/modelFailure.test.js
 */

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runWithRequestId } = require('../telemetry/log');
const { modelUnreachable, modelLookupFailed, UNREACHABLE_TEXT, LOOKUP_TEXT } = require('./modelFailure');

function quietly(fn) {
    const lines = [];
    const orig = console.error;
    console.error = (...a) => lines.push(a.map((x) => (x instanceof Error ? x.message : String(x))).join(' '));
    try { return { out: fn(), lines }; } finally { console.error = orig; }
}

test('an unreachable model: the refusal carries the sentence and the request\'s id, the log the error under it', () => {
    const { out, lines } = quietly(() => runWithRequestId('req-1', () => modelUnreachable({ what: 'design', code: 'design_failed', modelId: 'm1', err: new Error('connect ECONNREFUSED 10.1.2.3:80') })));
    assert.deepEqual(out, { ok: false, code: 'design_failed', error: UNREACHABLE_TEXT, correlationId: 'req-1' });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\[Playbooks\] design: the model could not be reached \(model=m1\) correlationId=req-1/);
    assert.match(lines[0], /ECONNREFUSED 10\.1\.2\.3:80/);
});

test('a status is carried only when the caller names one', () => {
    const { out } = quietly(() => modelUnreachable({ what: 'compose', code: 'compose_failed', status: 502, modelId: 'm1', err: new Error('x') }));
    assert.equal(out.status, 502);
    assert.match(out.correlationId, /^[0-9a-f-]{36}$/, 'outside a request there is still an id to quote');
});

test('a config that could not be read is model_unavailable, in a sentence of its own', () => {
    const { out, lines } = quietly(() => runWithRequestId('req-2', () => modelLookupFailed({ what: 'access plan', err: new Error('password authentication failed for user "beeflow"') })));
    assert.deepEqual(out, { ok: false, code: 'model_unavailable', error: LOOKUP_TEXT, correlationId: 'req-2' });
    assert.match(lines[0], /access plan: the model for this tier could not be looked up correlationId=req-2/);
    assert.match(lines[0], /password authentication failed/);
});
