'use strict';

/**
 * Run data of a run on the starter's own connections is the starter's alone.
 *
 * Run: node --test core/automationModel/callerRunVisibility.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const {
    isCallerRun, canReadRunData, assertCanReadRunData, redactRunForViewer, redactStepsForViewer, redactChainStepsForViewer, redactRunRowForViewer,
} = require('./callerRunVisibility');

const CALLER_RUN = { id: 'r1', status: 'error', startedAt: 't0', connectionsMode: 'caller', startedByUserId: 'starter', triggerPayload: { a: 1 }, summary: 's', error: 'e', errorClass: 'x', outcome: { code: 'c', params: { file: 'f' }, text: 'T' }, lastOutput: { v: 1 } };
const OWN_RUN = { ...CALLER_RUN, connectionsMode: null };

test('only the starter reads a caller-mode run; every ordinary run is readable as before', () => {
    assert.strictEqual(isCallerRun(CALLER_RUN), true);
    assert.strictEqual(canReadRunData(CALLER_RUN, 'starter'), true);
    for (const viewer of ['owner', 'other', null, undefined, '']) assert.strictEqual(canReadRunData(CALLER_RUN, viewer), false, String(viewer));
    assert.strictEqual(canReadRunData(OWN_RUN, 'owner'), true);
    assert.strictEqual(canReadRunData(OWN_RUN, null), true);
    // A caller-mode run with no recorded starter is readable by nobody.
    assert.strictEqual(canReadRunData({ ...CALLER_RUN, startedByUserId: null }, null), false);
});

test('redactRunForViewer is an allow-list: status and timing stay, every other key (today\'s and next year\'s) goes', () => {
    const r = redactRunForViewer({ ...CALLER_RUN, brandNewColumn: 'secret', nested: { v: 1 } }, 'owner');
    assert.deepStrictEqual([r.status, r.startedAt, r.errorClass, r.dataHidden], ['error', 't0', 'x', true]);
    for (const k of ['triggerPayload', 'summary', 'error', 'lastOutput', 'brandNewColumn', 'nested']) assert.ok(!(k in r), `${k} must not travel`);
    assert.deepStrictEqual(r.outcome, { code: 'c', params: {}, text: null });
    assert.strictEqual(redactRunForViewer(CALLER_RUN, 'starter'), CALLER_RUN);
    assert.strictEqual(redactRunForViewer(OWN_RUN, 'owner'), OWN_RUN);
    assert.ok(!('summary' in redactRunRowForViewer(CALLER_RUN, 'owner')));
});

test('redactStepsForViewer keeps name, type, status and timing only (allow-list)', () => {
    const steps = [{ runId: 'r1', stepId: 's', stepType: 'x', attempts: 1, status: 'success', startedAt: 'a', finishedAt: 'b', input: { q: 1 }, output: { o: 1 }, error: 'e', errorInfo: { t: 1 }, bindingWarnings: [1], identityUserId: 'starter', futureField: 'v' }];
    const hidden = redactStepsForViewer(CALLER_RUN, steps, 'owner')[0];
    assert.deepStrictEqual([hidden.stepId, hidden.stepType, hidden.status, hidden.startedAt, hidden.finishedAt], ['s', 'x', 'success', 'a', 'b']);
    for (const k of ['input', 'output', 'error', 'errorInfo', 'bindingWarnings', 'identityUserId', 'futureField']) assert.ok(!(k in hidden), k);
    assert.strictEqual(redactStepsForViewer(CALLER_RUN, steps, 'starter'), steps);
    assert.strictEqual(redactStepsForViewer(OWN_RUN, steps, 'owner'), steps);
});

test('a journey is redacted leg by leg, each by the mode it ran in', () => {
    const legCaller = { id: 'leg2', connectionsMode: 'caller', startedByUserId: 'starter' };
    const legOwner = { id: 'leg1', connectionsMode: null, startedByUserId: 'owner' };
    const steps = [{ runId: 'leg1', stepId: 'a', output: 1 }, { runId: 'leg2', stepId: 'b', output: 2 }];
    // The head is an ordinary run; only the second leg (started in caller mode after a policy switch) is private.
    const out = redactChainStepsForViewer(legOwner, [legOwner, legCaller], steps, 'owner');
    assert.strictEqual(out[0].output, 1);
    assert.ok(!('output' in out[1]));
    assert.strictEqual(redactChainStepsForViewer(legOwner, [legOwner, legCaller], steps, 'starter')[1].output, 2);
    // The legs could not be read: only the head's own steps stay; a row of an unknown leg is hidden for the owner too.
    const unknown = redactChainStepsForViewer(legOwner, [], steps, 'owner');
    assert.strictEqual(unknown[0].output, 1);
    assert.ok(!('output' in unknown[1]));
});

test('assertCanReadRunData throws the 403 caller_run_private, for the verb the route names', () => {
    assert.throws(() => assertCanReadRunData(CALLER_RUN, 'owner', 'run it again'), (e) => e.status === 403 && e.code === 'caller_run_private' && /run it again/.test(e.message));
    assert.doesNotThrow(() => assertCanReadRunData(CALLER_RUN, 'starter'));
    assert.doesNotThrow(() => assertCanReadRunData(OWN_RUN, 'owner'));
});
