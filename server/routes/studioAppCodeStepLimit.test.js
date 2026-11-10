'use strict';

/**
 * The code step's own per-minute bucket (./studioAppCodeStepLimit.mts): STUDIO_APP_CODE_RPM with
 * 0 as no limit, charged for a code step instead of the /run bucket, and on a public page on top
 * of the ordinary step bucket.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildCodeLimiter, checkPublicCodeBudget, CODE_RPM_DEFAULT } = require('./studioAppCodeStepLimit.mts');
const { limitersForStep } = require('./studioAppStepBudget.mts');

const keyOf = (req) => `t:${req.params.id}`;

test('STUDIO_APP_CODE_RPM caps the runs per minute and 0 lets every run through', async () => {
    const two = buildCodeLimiter('test-code-two', keyOf, { STUDIO_APP_CODE_RPM: '2' });
    assert.equal(two.max, 2);
    assert.deepEqual(await two.take('k'), { ok: true });
    assert.deepEqual(await two.take('k'), { ok: true });
    assert.equal((await two.take('k')).ok, false);

    const open = buildCodeLimiter('test-code-open', keyOf, { STUDIO_APP_CODE_RPM: '0' });
    assert.equal(open.max, 0);
    for (let i = 0; i < 500; i += 1) assert.deepEqual(await open.take('k'), { ok: true });
    assert.equal(await open.check({ params: { id: 'a' } }, {}), true);

    assert.equal(buildCodeLimiter('test-code-default', keyOf, {}).max, CODE_RPM_DEFAULT);
    assert.equal(buildCodeLimiter('test-code-junk', keyOf, { STUDIO_APP_CODE_RPM: 'many' }).max, CODE_RPM_DEFAULT);
});

test('a code step is charged to the code bucket alone, never the /run bucket', () => {
    const limiters = { codeStepLimiter: { name: 'code' }, actionRunLimiter: { name: 'run' }, aiStepLimiter: { name: 'ai' } };
    const budgets = limitersForStep('code', limiters);
    assert.deepEqual(budgets.map((b) => [b.limiter, b.name, b.daily]), [[limiters.codeStepLimiter, 'STUDIO_APP_CODE_RPM', false]]);
    // The other kinds are as they were.
    assert.deepEqual(limitersForStep('run_automation', limiters).map((b) => b.name), ['STUDIO_APP_ACTION_RUN_RPM']);
    assert.deepEqual(limitersForStep('create_record', limiters), []);
});

test('the live code bucket is a real limiter when no map names one', () => {
    const [budget] = limitersForStep('code', {});
    assert.equal(typeof budget.limiter.check, 'function');
    assert.equal(typeof budget.limiter.take, 'function');
});

test('the public page charges only a code step to its code bucket', async () => {
    assert.equal(await checkPublicCodeBudget('create_record', {}, {}), true);
    const req = { params: { token: 'tok' }, ip: '203.0.113.9' };
    const res = { set() { return res; }, status() { return { json() { return undefined; } }; } };
    assert.equal(await checkPublicCodeBudget('code', req, res), true);
});
