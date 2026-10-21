/**
 * The ai_step answer cache under the dry-run test harness: a golden replay or a
 * form-scenario dry run may ask to reuse stored answers (aiAnswers 'cache'),
 * and then it only READS. It never fills the durable tier. Every other dry run
 * has no plan at all, exactly as before.
 *
 * Run: node --test core/automationRunner/aiStepCache.harness.test.js
 */

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const { installAiAnswerCacheKit } = require('../../testUtils/aiAnswerCacheKit');

const kit = installAiAnswerCacheKit();
const { durableGets, durablePuts, flush, ANSWER, makeCtx, makeArgs } = kit;
after(kit.restore);

const { planAiReuse, readAiReuse, rememberAiAnswer } = require('./aiStepCache');

const harness = (aiAnswers) => Object.freeze({ source: { kind: 'golden', id: 'g1' }, formAnswers: null, aiAnswers });

beforeEach(kit.reset);

test('a dry run without a harness has no plan', async () => {
    assert.strictEqual(await planAiReuse(makeArgs({ mode: 'dry_run' })), null);
});

test("a dry run whose harness says 'live' has no plan", async () => {
    assert.strictEqual(await planAiReuse(makeArgs({ mode: 'dry_run', ctx: makeCtx({ testHarness: harness('live') }) })), null);
});

test("the harness is ignored outside a dry run: a live plan is not read-only", async () => {
    const plan = await planAiReuse(makeArgs({ ctx: makeCtx({ testHarness: harness('cache') }) }));
    assert.ok(plan);
    assert.strictEqual(plan.readOnly, false);
});

test("a dry run with aiAnswers 'cache' gets a read-only plan with the durable tier", async () => {
    const plan = await planAiReuse(makeArgs({ mode: 'dry_run', ctx: makeCtx({ testHarness: harness('cache') }) }));
    assert.ok(plan);
    assert.strictEqual(plan.readOnly, true);
    assert.ok(plan.durable, 'the durable tier is there to read');
});

test('a stored answer is served to the dry run, and the durable read is used', async () => {
    // A live run stores the answer first.
    rememberAiAnswer(await planAiReuse(makeArgs()), { answer: ANSWER, userId: 'u1' });
    await flush();
    assert.strictEqual(durablePuts.length, 1);

    const plan = await planAiReuse(makeArgs({ mode: 'dry_run', ctx: makeCtx({ testHarness: harness('cache') }) }));
    const read = await readAiReuse(plan);
    assert.strictEqual(read.reused, 'stored');
    assert.deepStrictEqual(read.hit, ANSWER);
    assert.ok(durableGets.length >= 1);
});

test('a read-only plan never writes the durable tier, but remembers inside the run', async () => {
    const plan = await planAiReuse(makeArgs({ mode: 'dry_run', ctx: makeCtx({ testHarness: harness('cache') }) }));
    rememberAiAnswer(plan, { answer: ANSWER, userId: 'u1' });
    await flush();
    assert.deepStrictEqual(durablePuts, [], 'no durable put');
    const again = await readAiReuse(plan);
    assert.strictEqual(again.reused, 'run');
    assert.deepStrictEqual(again.hit, ANSWER);
});

test('the operator switch and a missing askOnce still win over the harness', async () => {
    const ctx = makeCtx({ testHarness: harness('cache') });
    assert.strictEqual(await planAiReuse(makeArgs({ mode: 'dry_run', ctx, step: { id: 's1', type: 'ai_step' } })), null);
    assert.strictEqual(await planAiReuse(makeArgs({ mode: 'dry_run', ctx, toolsOffered: true })), null);
    process.env.AUTOMATION_ASK_ONCE_DISABLED = '1';
    assert.strictEqual(await planAiReuse(makeArgs({ mode: 'dry_run', ctx })), null);
});
