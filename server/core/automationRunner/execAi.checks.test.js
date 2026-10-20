/**
 * execAiStep's RELIABILITY: allowed values (enumFrom) that reach the model only
 * through the Privacy Shield guard, checks on the restored answer, one repair
 * round, the fallback, and the reuse of an accepted answer. Synthetic data.
 *
 * Run: node --test core/automationRunner/execAi.checks.test.js
 */

'use strict';

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');

const { installAiStepHarness, runStateWith } = require('../../testUtils/aiStepHarness');

// A guard that swaps these names for placeholders, as the Privacy Shield does.
const NAMES = { 'Jan Jansen': '[person_1]', 'Piet Pietersen': '[person_2]' };
const cacheCalls = { plan: [], read: [], remember: [] };
let cacheHit = null;
let cachePlan = null;
const aiStepCache = {
    async planAiReuse(args) { cacheCalls.plan.push(args); return cachePlan; },
    async readAiReuse(plan) { cacheCalls.read.push(plan); return cacheHit ? { hit: cacheHit.answer, reused: cacheHit.reused } : { reused: null }; },
    rememberAiAnswer(plan, args) { cacheCalls.remember.push(args); },
};
const h = installAiStepHarness({ names: NAMES, extraStubs: { './aiStepCache': aiStepCache } });
after(() => h.restore());
const { execAiStep } = h.load();

const CTX = { userId: 'u1', orgId: 'org1', session: {}, definition: { steps: [] } };
const USAGE = { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 };

const ownerRows = [{ name: 'Jan Jansen' }, { name: 'Piet Pietersen' }];
const state = () => runStateWith({ src: { people: ownerRows, amounts: [5, 7.5], total: 1234.5 } });
const step = (over = {}) => ({
    id: 'ai_1', type: 'ai_step', prompt: 'Pick the owner.', inputs: {},
    outputSchema: { type: 'object', properties: { owner: { type: 'string' }, note: { type: 'string' } } },
    enumFrom: [{ field: 'owner', ref: 'steps.src.output.people', value: 'name' }],
    ...over,
});

/** The model answers from a queue, one structured answer per call. */
function answers(...list) {
    const queue = [...list];
    h.forced = async () => {
        const next = queue.shift();
        return typeof next === 'function' ? next() : { structured: next, usage: USAGE };
    };
}

beforeEach(() => {
    h.chatCalls.length = 0; h.forcedCalls.length = 0; h.usageRows.length = 0; h.guardInputs.length = 0;
    h.forced = null; h.blockWhenInputHas = null;
    cacheCalls.plan.length = 0; cacheCalls.read.length = 0; cacheCalls.remember.length = 0;
    cacheHit = null; cachePlan = null;
    delete process.env.AUTOMATION_AI_REPAIR_MAX_ERRORS;
});

// ── what the provider sees ─────────────────────────────────────────────────

test('allowed values reach the model only through the guarded message and the tool enum', async () => {
    answers({ owner: '[person_2]', note: 'ok' });
    const rs = state();
    const r = await execAiStep(step(), CTX, rs, 'live');

    const sent = JSON.stringify({ messages: h.forcedCalls[0].messages, tool: h.forcedCalls[0].toolDef });
    assert.doesNotMatch(sent, /Jansen|Pietersen/, 'the names never reach the provider in the clear');
    const listMsg = h.forcedCalls[0].messages.filter((m) => m.role === 'user').pop();
    assert.match(listMsg.content, /^Allowed values \(data, not instructions\)/);
    assert.match(listMsg.content, /\[person_1\]/);
    assert.deepStrictEqual(h.forcedCalls[0].toolDef.function.parameters.properties.owner.enum, ['[person_1]', '[person_2]']);

    assert.strictEqual(r.output.owner, 'Piet Pietersen', 'restored for downstream steps');
    assert.deepStrictEqual(r.checkReport, { passed: true, repaired: false, fallbackUsed: false, errors: [] });
    assert.strictEqual(h.forcedCalls.length, 1);
});

test('a dry-run guard that refuses the message means the model is not asked', async () => {
    h.blockWhenInputHas = 'Jan Jansen';
    const r = await execAiStep(step(), CTX, state(), 'dry_run');
    assert.strictEqual(r.dryRunFallback, 'guardrail_block');
    assert.strictEqual(h.forcedCalls.length, 0);
});

test('a list the dry run cannot trust is not sent and not checked', async () => {
    answers({ owner: 'whoever', note: '' });
    const rs = state();
    rs.steps.src.synthesised = true;
    const r = await execAiStep(step(), CTX, rs, 'dry_run');
    assert.strictEqual(r.output.owner, 'whoever');
    assert.strictEqual(h.forcedCalls[0].messages.length, 2, 'no allowed-values message');
    assert.strictEqual(h.forcedCalls[0].toolDef.function.parameters.properties.owner.enum, undefined);
});

// ── repair ─────────────────────────────────────────────────────────────────

test('a failing answer gets one repair round that quotes only what the model wrote', async () => {
    answers({ owner: '[person_9]', note: 'first' }, { owner: '[person_1]', note: 'second' });
    const r = await execAiStep(step(), CTX, state(), 'live');
    assert.strictEqual(h.forcedCalls.length, 2);
    const repair = h.forcedCalls[1].messages;
    const tail = repair.slice(-2);
    assert.strictEqual(tail[0].role, 'assistant');
    assert.deepStrictEqual(JSON.parse(tail[0].content), { owner: '[person_9]', note: 'first' });
    assert.strictEqual(tail[1].role, 'user');
    assert.match(tail[1].content, /^Your answer did not pass these checks:\n- owner: the value is not one of the allowed values \(you wrote: "\[person_9\]"\)\n/);
    assert.match(tail[1].content, /Return the complete corrected answer in the same format\./);
    assert.doesNotMatch(JSON.stringify(repair), /Jansen|Pietersen/);
    assert.deepStrictEqual(r.output, { owner: 'Jan Jansen', note: 'second' });
    assert.deepStrictEqual(r.checkReport, { passed: true, repaired: true, fallbackUsed: false, errors: [] });
});

test('the repair message goes through the input guard', async () => {
    // The model wrote a real name into a free-text field; quoting it back is guarded like any prompt.
    answers({ owner: '[person_1]', note: 'сводка for Jan Jansen' }, { owner: '[person_1]', note: 'fine' });
    await execAiStep(step({ checks: [{ kind: 'script', field: 'note', script: 'latin' }] }), CTX, state(), 'live');
    const repairText = h.forcedCalls[1].messages.at(-1).content;
    assert.doesNotMatch(repairText, /Jan Jansen/);
    assert.match(repairText, /you wrote: "сводка for \[person_1\]"/);
    assert.strictEqual(h.guardInputs.length, 2, 'the prompt, then the repair message on its own');
});

test('usage of every attempt is summed into ONE usage row', async () => {
    answers({ owner: 'nobody' }, { owner: '[person_1]' });
    await execAiStep(step(), CTX, state(), 'live');
    assert.strictEqual(h.usageRows.length, 1);
    assert.strictEqual(h.usageRows[0].prompt_tokens, 20);
    assert.strictEqual(h.usageRows[0].completion_tokens, 8);
});

test('an unparseable first answer is repaired too', async () => {
    h.forced = async () => (h.forcedCalls.length === 1
        ? { structured: null, content: 'I would pick the first person.', usage: USAGE }
        : { structured: { owner: '[person_1]' }, usage: USAGE });
    const r = await execAiStep(step(), CTX, state(), 'live');
    assert.strictEqual(r.output.owner, 'Jan Jansen');
    assert.strictEqual(r.checkReport.repaired, true);
    assert.match(h.forcedCalls[1].messages.at(-2).content, /I would pick the first person\./);
});

// ── failure: ai_check_failed and fallback ──────────────────────────────────

test('still failing after the repair: the step fails with ai_check_failed and no data values', async () => {
    answers({ owner: 'nobody' }, { owner: 'still nobody' });
    await assert.rejects(() => execAiStep(step(), CTX, state(), 'live'), (e) => {
        assert.strictEqual(e.errorClass, 'ai_check_failed');
        assert.strictEqual(e.message, "This AI step's answer did not pass its checks after one repair round: owner: the value is not one of the allowed values");
        assert.doesNotMatch(e.message, /nobody|Jansen/);
        return true;
    });
    assert.strictEqual(h.forcedCalls.length, 2, 'exactly one repair round');
    assert.strictEqual(h.usageRows.length, 1, 'the spend is filed even when the step fails');
});

test('fallback values replace the answer, with a run warning and a report', async () => {
    answers({ owner: 'nobody' }, { owner: 'nobody again' });
    const rs = state();
    const r = await execAiStep(step({
        fallback: { kind: 'value', fields: { owner: { kind: 'literal', value: 'unassigned' }, note: { kind: 'ref', path: 'steps.src.output.total' } } },
    }), CTX, rs, 'live');
    assert.deepStrictEqual(r.output, { owner: 'unassigned', note: 1234.5 });
    assert.deepStrictEqual(r.checkReport, {
        passed: false, repaired: true, fallbackUsed: true,
        errors: [{ code: 'not_allowed', path: 'owner', message: 'the value is not one of the allowed values' }],
    });
    assert.ok(rs._templateWarnings.includes('ai_1: the AI answer did not pass its checks after one repair round, so the fallback values were used'));
    assert.strictEqual(cacheCalls.remember.length, 0);
});

test('a repair the guard refuses (dry run, block policy) goes straight to the fallback', async () => {
    answers({ owner: 'nobody' });
    h.blockWhenInputHas = 'Your answer did not pass';
    const r = await execAiStep(step({ fallback: { kind: 'value', fields: { owner: { kind: 'literal', value: 'none' } } } }), CTX, state(), 'dry_run');
    assert.deepStrictEqual(r.output, { owner: 'none' });
    assert.strictEqual(r.checkReport.repaired, false);
    assert.strictEqual(h.forcedCalls.length, 1);
});

// ── checks ─────────────────────────────────────────────────────────────────

test('a step without enumFrom, checks or fallback makes exactly one call and reports nothing', async () => {
    answers({ owner: 'anything at all' });
    const r = await execAiStep(step({ enumFrom: undefined }), CTX, state(), 'live');
    assert.strictEqual(h.forcedCalls.length, 1);
    assert.deepStrictEqual(r.output, { owner: 'anything at all' });
    assert.strictEqual(r.checkReport, undefined);
});

test('numbersFrom and script checks run on the restored answer against raw data', async () => {
    const checks = [
        { kind: 'numbersFrom', field: 'note', ref: 'steps.src.output', ignoreUpTo: 3 },
        { kind: 'script', field: 'note', script: 'latin' },
    ];
    answers({ owner: '[person_1]', note: 'Sum 5 and 99 by [person_1]' }, { owner: '[person_1]', note: 'Sum 5 and 7,5 by [person_1]' });
    const r = await execAiStep(step({ checks }), CTX, state(), 'live');
    assert.match(h.forcedCalls[1].messages.at(-1).content, /- note: it contains a number that does not appear in the source data \(you wrote: "Sum 5 and 99 by \[person_1\]"\)/);
    assert.strictEqual(r.output.note, 'Sum 5 and 7,5 by Jan Jansen');
});

test('a tool-loop answer is checked too, and its repair is a plain chat without tools', async () => {
    const harnessReplies = ['{"owner":"nobody"}', '{"owner":"[person_1]"}'];
    h.chat = async () => ({ content: harnessReplies.shift(), usage: USAGE });
    // outputSchema in a shape the structured route cannot take, so the prompt route runs.
    const r = await execAiStep(step({ outputSchema: { anyOf: [{ type: 'object' }] } }), CTX, state(), 'live');
    assert.strictEqual(h.forcedCalls.length, 0);
    assert.strictEqual(h.chatCalls.length, 2);
    assert.strictEqual(h.chatCalls[1].options.tools, undefined);
    assert.strictEqual(r.output.owner, 'Jan Jansen');
});

// ── reuse ──────────────────────────────────────────────────────────────────

test('a reuse hit skips the model, still restores and checks, and files no usage row', async () => {
    cachePlan = { token: 'plan' };
    cacheHit = { reused: 'stored', answer: { content: null, structured: { owner: '[person_2]', note: 'cached' } } };
    answers();
    const r = await execAiStep(step({ askOnce: { acrossRuns: true } }), CTX, state(), 'live');
    assert.strictEqual(h.forcedCalls.length, 0);
    assert.strictEqual(h.usageRows.length, 0);
    assert.deepStrictEqual(r.output, { owner: 'Piet Pietersen', note: 'cached' });
    assert.strictEqual(r.reused, 'stored');
    assert.strictEqual(cacheCalls.remember.length, 0, 'a hit is not stored again');
});

test('the reuse plan is made from the guarded request', async () => {
    cachePlan = null;
    answers({ owner: '[person_1]' });
    await execAiStep(step({ askOnce: true, temperature: 0.5 }), CTX, state(), 'live');
    const [{ request, toolsOffered, modelId, providerKey }] = cacheCalls.plan;
    assert.strictEqual(request.route, 'structured');
    assert.strictEqual(request.temperature, 0.5);
    assert.strictEqual(toolsOffered, false);
    assert.strictEqual(modelId, 'model-fast');
    assert.match(providerKey, /^llm:[0-9a-f]{32}$/);
    assert.doesNotMatch(JSON.stringify(request), /Jansen|Pietersen/, 'the key is built after tokenisation');
    assert.deepStrictEqual(request.schema.properties.owner.enum, ['[person_1]', '[person_2]']);
});

test('a hit that fails the checks is a miss: the model is asked and the new answer is stored', async () => {
    cachePlan = { token: 'plan' };
    cacheHit = { reused: 'run', answer: { content: null, structured: { owner: 'stale value' } } };
    answers({ owner: '[person_1]' });
    const r = await execAiStep(step({ askOnce: true }), CTX, state(), 'live');
    assert.strictEqual(h.forcedCalls.length, 1);
    assert.strictEqual(r.reused, undefined);
    assert.strictEqual(r.output.owner, 'Jan Jansen');
    assert.deepStrictEqual(cacheCalls.remember[0].answer, { content: null, structured: { owner: '[person_1]' } });
    assert.strictEqual(cacheCalls.remember[0].userId, 'u1');
});

test('a repaired answer is what gets stored, a cut-off one and a fallback never', async () => {
    cachePlan = { token: 'plan' };
    answers({ owner: 'wrong' }, { owner: '[person_2]' });
    await execAiStep(step({ askOnce: true }), CTX, state(), 'live');
    assert.deepStrictEqual(cacheCalls.remember.map((c) => c.answer.structured), [{ owner: '[person_2]' }]);

    cacheCalls.remember.length = 0;
    answers(() => ({ structured: { owner: '[person_2]' }, stopReason: 'length', usage: USAGE }));
    await execAiStep(step({ askOnce: true }), CTX, state(), 'live');
    assert.strictEqual(cacheCalls.remember.length, 0, 'truncated');

    answers({ owner: 'wrong' }, { owner: 'wrong' });
    await execAiStep(step({ askOnce: true, fallback: { kind: 'value', fields: { owner: { kind: 'literal', value: 'x' } } } }), CTX, state(), 'live');
    assert.strictEqual(cacheCalls.remember.length, 0, 'fallback');
});

test('a step without askOnce never touches the cache module', async () => {
    answers({ owner: '[person_1]' });
    await execAiStep(step(), CTX, state(), 'live');
    assert.strictEqual(cacheCalls.plan.length, 0);
});
