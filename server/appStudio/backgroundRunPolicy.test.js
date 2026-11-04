/**
 * backgroundRunPolicy.mts: lock keys, progress text, the env knobs, the builder repair.
 *
 * Run: cd server && node --test appStudio/backgroundRunPolicy.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const P = require('./backgroundRunPolicy.mts');
const { repairAction } = require('./builderTools/actionNormalise');

test('normaliseLockKey: trimmed text, empty is no lock, objects are no lock, long keys hashed', () => {
    assert.equal(P.normaliseLockKey('  order:7 '), 'order:7');
    assert.equal(P.normaliseLockKey(42), '42');
    assert.equal(P.normaliseLockKey(''), null);
    assert.equal(P.normaliseLockKey('   '), null);
    assert.equal(P.normaliseLockKey(null), null);
    assert.equal(P.normaliseLockKey({ a: 1 }), null);
    const long = P.normaliseLockKey('x'.repeat(201));
    assert.match(long, /^h:[0-9a-f]{64}$/);
    assert.equal(P.normaliseLockKey('x'.repeat(201)), long, 'stable');
});

test('progressText: one line, capped at 200 characters', () => {
    assert.equal(P.progressText('Reading\n document 2'), 'Reading document 2');
    assert.equal(P.progressText(null), '');
    assert.equal(P.progressText('y'.repeat(500)).length, 200);
    assert.equal(P.progressText({ n: 2 }), '{"n":2}');
});

test('leadingConfirmCount counts the confirms that open the sequence', () => {
    assert.equal(P.leadingConfirmCount([{ kind: 'confirm' }, { kind: 'confirm' }, { kind: 'toast' }, { kind: 'confirm' }]), 2);
    assert.equal(P.leadingConfirmCount([]), 0);
});

test('backgroundLimits: defaults, an override, 0 = unlimited, a bad value keeps the default', () => {
    const d = P.backgroundLimits({});
    assert.deepEqual(d, { maxRunMs: 1_800_000, maxSteps: 5000, perUser: 3, perApp: 20, staleMs: 90_000, resultMaxBytes: 262_144 });
    const o = P.backgroundLimits({ STUDIO_APP_BACKGROUND_MAX_RUN_MS: '0', STUDIO_APP_BACKGROUND_PER_USER: '5', STUDIO_APP_BACKGROUND_PER_APP: 'x', STUDIO_APP_BACKGROUND_STALE_MS: '0' });
    assert.equal(o.maxRunMs, 0);
    assert.equal(o.perUser, 5);
    assert.equal(o.perApp, 20);
    assert.equal(o.staleMs, 90_000, 'a stale window of 0 would reclaim every lock');
    assert.equal(P.limitLabel(o, 'perUser'), 'STUDIO_APP_BACKGROUND_PER_USER=5');
});

test('app_set_action repair: "true" read as true, a string lockKey as a formula, a bare step wrapped', () => {
    const notes = [];
    const action = P.repairRunOptions({ kind: 'ai_generate', prompt: 'Hi', background: 'true', lockKey: "'doc:' + form.id" }, notes);
    assert.equal(action.kind, 'sequence');
    assert.equal(action.background, true);
    assert.deepEqual(action.lockKey, { kind: 'formula', expr: "'doc:' + form.id" });
    assert.deepEqual(action.steps, [{ kind: 'ai_generate', prompt: 'Hi' }]);
    assert.equal(notes.length, 3, notes.join('\n'));
    // Then the regular repair still runs over the wrapped step.
    const { refusal } = repairAction(action);
    assert.equal(refusal, null);
    const plainNotes = [];
    const plain = { kind: 'sequence', steps: [{ kind: 'toast', message: 'x' }] };
    assert.equal(P.repairRunOptions(plain, plainNotes), plain);
    assert.deepEqual(plainNotes, []);
});
