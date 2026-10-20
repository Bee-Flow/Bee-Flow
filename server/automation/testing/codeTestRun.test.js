'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { runCodeOnce } = require('./codeTestRun');

const ADD = `/**
 * Adds two numbers.
 * @param {number} a - First
 * @param {number} [b=1] - Second
 */
async function main(inputs, ctx) { return { sum: inputs.a + inputs.b }; }`;

function fakeSandbox({ available = true, out, throws } = {}) {
    const calls = [];
    return {
        calls,
        isAvailable: () => available,
        async runCode(args) {
            calls.push(args);
            if (throws) throw new Error(throws);
            return out;
        },
    };
}

test('a syntax error is refused with its position and never reaches the sandbox', async () => {
    const sandbox = fakeSandbox();
    const r = await runCodeOnce({ code: 'return {;' }, { sandbox });
    assert.strictEqual(r.refusal.status, 422);
    assert.strictEqual(r.refusal.code, 'code_syntax_error');
    assert.strictEqual(r.refusal.details.syntaxError.line, 1);
    assert.strictEqual(sandbox.calls.length, 0);
});

test('a BLOCK finding is refused', async () => {
    const sandbox = fakeSandbox();
    const r = await runCodeOnce({ code: 'return eval("1+1");' }, { sandbox });
    assert.strictEqual(r.refusal.code, 'code_blocked');
    assert.strictEqual(r.refusal.details.findings[0].ruleId, 'dynamic-code');
    assert.strictEqual(sandbox.calls.length, 0);
});

test('a missing required parameter is refused in a plain sentence', async () => {
    const sandbox = fakeSandbox();
    const r = await runCodeOnce({ code: ADD, inputs: {} }, { sandbox });
    assert.strictEqual(r.refusal.status, 422);
    assert.strictEqual(r.refusal.code, 'code_param_invalid');
    assert.match(r.refusal.message, /A/);
    assert.ok(r.refusal.details.param);
    assert.strictEqual(sandbox.calls.length, 0);
});

test('a missing sandbox answers 503', async () => {
    const r = await runCodeOnce({ code: 'return 1;' }, { sandbox: fakeSandbox({ available: false }) });
    assert.strictEqual(r.refusal.status, 503);
    assert.strictEqual(r.refusal.code, 'code_sandbox_missing');
});

test('code that throws is an outcome, not a refusal', async () => {
    let t = 100;
    const r = await runCodeOnce({ code: 'return 1;' }, { sandbox: fakeSandbox({ throws: 'nope' }), now: () => (t += 5) });
    assert.deepStrictEqual(r, { ok: false, error: 'nope', logs: [], calls: [], durationMs: 5 });
});

test('a good run: TEST mode, defaults applied, allowed tools passed, result normalised', async () => {
    const sandbox = fakeSandbox({ out: { result: { sum: 3 }, logs: ['hi'], calls: [{ kind: 'http', name: 'x' }] } });
    const r = await runCodeOnce({
        code: ADD, inputs: { a: '2' }, allowedTools: ['gmail_send'], limits: { wallMs: 1000 }, concurrencyKey: 'org1',
    }, { sandbox });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.result, { sum: 3 });
    assert.deepStrictEqual(r.logs, ['hi']);
    assert.strictEqual(r.calls.length, 1);
    const sent = sandbox.calls[0];
    assert.strictEqual(sent.mode, 'test');
    assert.deepStrictEqual(sent.inputs, { a: 2, b: 1 });
    assert.deepStrictEqual([...sent.bridges.allowedTools], ['gmail_send']);
    assert.deepStrictEqual(sent.limits, { wallMs: 1000 });
    assert.strictEqual(sent.concurrencyKey, 'org1');
});

test('an undefined result becomes null; missing logs and calls become empty lists', async () => {
    const r = await runCodeOnce({ code: 'return 1;' }, { sandbox: fakeSandbox({ out: {} }) });
    assert.deepStrictEqual({ ok: r.ok, result: r.result, logs: r.logs, calls: r.calls }, { ok: true, result: null, logs: [], calls: [] });
});

test('getSandbox is only asked once the code passed the checks', async () => {
    let asked = 0;
    const getSandbox = () => { asked++; return fakeSandbox({ out: { result: 1 } }); };
    await runCodeOnce({ code: 'return {;' }, { getSandbox });
    assert.strictEqual(asked, 0);
    await runCodeOnce({ code: 'return 1;' }, { getSandbox });
    assert.strictEqual(asked, 1);
});
