/**
 * definition.runPolicy — the save-path sanitiser and the runner's resolver.
 *
 * Run: cd server && node --test core/automationRunner/runPolicy.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
    sanitizeRunPolicy, withSanitizedRunPolicy, resolveRunPolicy, stepRetryFor, runTimeoutMsFor,
} = require('./runPolicy');

test('a complete, valid policy passes through; unknown keys are dropped', () => {
    const { value, errors } = sanitizeRunPolicy({
        retry: { max: 2, then: 'stop_notify', extra: 1 }, maxDurationMin: 30, concurrency: 'parallel', retentionDays: 90, bogus: true,
    });
    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(value, { retry: { max: 2, then: 'stop_notify' }, maxDurationMin: 30, concurrency: 'parallel', retentionDays: 90 });
});

test('every out-of-range or mistyped field is an error naming it', () => {
    const { value, errors } = sanitizeRunPolicy({
        retry: { max: 6, then: 'retry_forever' }, maxDurationMin: 0, concurrency: 'many', retentionDays: 3,
    });
    assert.strictEqual(value, undefined);
    assert.deepStrictEqual(errors.map(e => e.path).sort(), [
        'runPolicy.concurrency', 'runPolicy.maxDurationMin', 'runPolicy.retentionDays', 'runPolicy.retry.max', 'runPolicy.retry.then',
    ]);
    assert.ok(errors.every(e => e.code === 'run_policy.invalid' && e.severity === 'error' && e.message));
    assert.strictEqual(sanitizeRunPolicy({ maxDurationMin: 61 }).errors.length, 1);
    assert.strictEqual(sanitizeRunPolicy({ maxDurationMin: 2.5 }).errors.length, 1, 'whole minutes only');
    assert.strictEqual(sanitizeRunPolicy({ retentionDays: 366 }).errors.length, 1);
    assert.strictEqual(sanitizeRunPolicy('fast').errors.length, 1);
    assert.strictEqual(sanitizeRunPolicy([]).errors.length, 1);
});

test('the bounds themselves are allowed', () => {
    for (const p of [{ retry: { max: 0 } }, { retry: { max: 5 } }, { maxDurationMin: 1 }, { maxDurationMin: 60 }, { retentionDays: 7 }, { retentionDays: 365 }]) {
        assert.deepStrictEqual(sanitizeRunPolicy(p).errors, [], JSON.stringify(p));
    }
});

test('no policy is no policy; nulls mean "default"', () => {
    assert.deepStrictEqual(sanitizeRunPolicy(undefined), { value: undefined, errors: [] });
    assert.deepStrictEqual(sanitizeRunPolicy(null), { value: undefined, errors: [] });
    assert.deepStrictEqual(sanitizeRunPolicy({ maxDurationMin: null, retry: null }).value, {});
});

test('withSanitizedRunPolicy cleans the definition and leaves others untouched', () => {
    const def = { steps: [], runPolicy: { concurrency: 'serial', junk: 1 } };
    const out = withSanitizedRunPolicy(def);
    assert.deepStrictEqual(out.definition.runPolicy, { concurrency: 'serial' });
    assert.notStrictEqual(out.definition, def);
    const plain = { steps: [] };
    assert.strictEqual(withSanitizedRunPolicy(plain).definition, plain);
    const bad = withSanitizedRunPolicy({ runPolicy: { retry: { max: 9 } } });
    assert.strictEqual(bad.errors.length, 1);
    assert.ok(!('runPolicy' in withSanitizedRunPolicy({ runPolicy: null }).definition));
});

test('resolveRunPolicy always hands the runner a complete, in-range policy', () => {
    assert.deepStrictEqual(resolveRunPolicy({}), { retry: { max: 0, then: 'stop_notify' }, maxDurationMin: null, concurrency: 'serial', retentionDays: null });
    assert.deepStrictEqual(resolveRunPolicy(null).concurrency, 'serial');
    const odd = resolveRunPolicy({ runPolicy: { retry: { max: 50, then: '?' }, maxDurationMin: 999, concurrency: 'x', retentionDays: 1 } });
    assert.deepStrictEqual(odd, { retry: { max: 5, then: 'stop_notify' }, maxDurationMin: 60, concurrency: 'serial', retentionDays: 7 });
});

test('a step\'s own retry wins over the routine default', () => {
    const policy = resolveRunPolicy({ runPolicy: { retry: { max: 2 } } });
    assert.deepStrictEqual(stepRetryFor({ id: 's' }, policy), { max: 2 });
    assert.deepStrictEqual(stepRetryFor({ id: 's', retry: { max: 1, backoffMs: 10 } }, policy), { max: 1, backoffMs: 10 });
    assert.strictEqual(stepRetryFor({ id: 's' }, resolveRunPolicy({})), null);
});

test('maxDurationMin becomes the run timeout in ms', () => {
    assert.strictEqual(runTimeoutMsFor(resolveRunPolicy({ runPolicy: { maxDurationMin: 30 } })), 1_800_000);
    assert.strictEqual(runTimeoutMsFor(resolveRunPolicy({})), null);
});
