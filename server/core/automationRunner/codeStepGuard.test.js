'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { prepareCodeRun } = require('./codeStepGuard');

const quiet = { info() {} };
const step = (code, extra = {}) => ({ id: 's1', type: 'code', code, ...extra });

test('a BLOCK finding stops the run with the sentence the editor showed', () => {
    const g = prepareCodeRun(step('return eval("1");'), {}, { log: quiet });
    assert.match(g.refusal, /This code step was stopped: Code that writes and runs new code cannot be checked/);
    assert.match(g.refusal, /\(line 1\)/);
});

test('a syntax error stops the run with its position', () => {
    const g = prepareCodeRun(step('return {;'), {}, { log: quiet });
    assert.match(g.refusal, /syntax error at line 1/);
});

test('warnings never stop a run', () => {
    const g = prepareCodeRun(step('Object.prototype.x = 1; return 1;'), {}, { log: quiet });
    assert.strictEqual(g.refusal, null);
});

test('declared parameters: defaults, types and required', () => {
    const code = `/**
 * @param {number} amount - Amount
 * @param {number} [rate=21] - Rate
 */
function main(inputs) { return inputs.amount * inputs.rate; }`;
    const ok = prepareCodeRun(step(code), { amount: '100', other: 'x' }, { log: quiet });
    assert.strictEqual(ok.refusal, null);
    assert.deepStrictEqual(ok.inputs, { amount: 100, rate: 21, other: 'x' });
    const missing = prepareCodeRun(step(code), {}, { log: quiet });
    assert.match(missing.refusal, /Amount/);
});

test('host manifest: literal hosts are enforced, others refused', () => {
    const g = prepareCodeRun(step('return (await ctx.http("https://api.example.com/x")).status;'), {}, { log: quiet });
    assert.strictEqual(g.manifest.enforced, true);
    assert.strictEqual(g.refuseHost('api.example.com'), null);
    assert.match(g.refuseHost('evil.example.org'), /may only send data to api.example.com/);
});

test('host manifest: a run-time URL with a host list is enforced against the list', () => {
    const g = prepareCodeRun(step('return (await ctx.http(inputs.url)).status;', { allowedHosts: ['*.example.com'] }), {}, { log: quiet });
    assert.strictEqual(g.manifest.enforced, true);
    assert.strictEqual(g.refuseHost('a.example.com'), null);
    assert.ok(g.refuseHost('example.net'));
});

test('host manifest: a run-time URL without a list runs in audit mode, logged', () => {
    const logged = [];
    const g = prepareCodeRun(step('return (await ctx.http(inputs.url)).status;'), {}, { log: { info: (m) => logged.push(m) } });
    assert.strictEqual(g.manifest.enforced, false);
    assert.strictEqual(g.refuseHost('anywhere.example.org'), null);
    assert.match(logged[0], /audit: step s1 reached unlisted host anywhere.example.org/);
});
