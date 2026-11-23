// @typecheck
/**
 * Escape tests of the out-of-process sandbox (./codeSandboxProcess.js) that runs a Cowork plan's scripts: a script
 * finds nothing of Node or the API process to reach, the classic ways out of a V8 context give it nothing, a loop or a
 * memory bomb is stopped without touching the server, scripts do not share state, and the child process starts with
 * no secret in its environment.
 *
 * Run: cd server && node --test automation/codeSandboxProcess.escape.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { runCodeIsolated, childEnv } = require('./codeSandboxProcess');
const { isAvailable } = require('./codeSandbox');

const skip = !isAvailable() && 'isolated-vm is not installed here';
const run = (/** @type {string} */ code, /** @type {any} */ extra = {}) => runCodeIsolated({ code, inputs: { n: 41 }, ...extra });

test('a script computes on its inputs and returns the result', { skip }, async () => {
    assert.deepStrictEqual((await run('return { next: inputs.n + 1 }')).result, { next: 42 });
});

test('nothing of Node or the server is in reach: no process, require, module, fetch or global of the host', { skip }, async () => {
    const { result } = await run(`return {
        process: typeof process, require: typeof require, module: typeof module, fetch: typeof fetch,
        xhr: typeof XMLHttpRequest, buffer: typeof Buffer, importScripts: typeof importScripts,
        hostProcess: typeof globalThis.process,
    }`);
    assert.deepStrictEqual(result, { process: 'undefined', require: 'undefined', module: 'undefined', fetch: 'undefined', xhr: 'undefined', buffer: 'undefined', importScripts: 'undefined', hostProcess: 'undefined' });
});

test('the classic ways out of a V8 context give a script nothing of the host', { skip }, async () => {
    const { result } = await run(`
        const tries = {};
        const attempt = (name, fn) => { try { const v = fn(); tries[name] = v === undefined || v === null ? 'nothing' : typeof v; } catch (e) { tries[name] = 'refused'; } };
        attempt('constructor', () => this.constructor.constructor('return process')());
        attempt('function', () => Function('return this.process')());
        attempt('ctxConstructor', () => ctx.constructor.constructor('return process')());
        return tries;`);
    for (const [how, outcome] of Object.entries(/** @type {Record<string, string>} */ (result))) {
        assert.ok(outcome === 'nothing' || outcome === 'refused', `${how}: ${outcome}`);
    }
    await assert.rejects(run('return import("fs")'), 'a module import is not even compiled');
});

test('no network, no apps and no secrets: the bridges are not there, and nothing goes out', { skip }, async () => {
    assert.deepStrictEqual((await run('return await ctx.http("https://example.com")')).result, { error: 'no http bridge' });
    assert.deepStrictEqual((await run('return await ctx.integrations.gmail_compose({ to: "x@example.com" })')).result, { error: 'no executeTool bridge' });
    await assert.rejects(run('return ctx.secrets("stripe_key")'), /not wired/);
});

test('an endless loop and a memory bomb are stopped, and the server carries on', { skip }, async () => {
    await assert.rejects(run('while (true) {}', { limits: { cpuMs: 200, wallMs: 1000 } }), /CPU|longer|stopped/i);
    await assert.rejects(run('const a = []; while (true) a.push(new Array(1e6).fill(1));', { limits: { memoryMb: 16, cpuMs: 5000, wallMs: 5000 } }));
    assert.deepStrictEqual((await run('return inputs.n')).result, 41, 'the next script runs as before');
});

test('scripts share nothing: what one leaves on its global, the next does not see', { skip }, async () => {
    const [first, second] = await Promise.all([run('globalThis.left = "secret"; return 1'), run('return typeof globalThis.left')]);
    assert.strictEqual(first.result, 1);
    assert.strictEqual(second.result, 'undefined');
    assert.strictEqual((await run('return typeof globalThis.left')).result, 'undefined');
});

test('the child process starts with no secret in its environment', () => {
    const env = childEnv({ PATH: '/usr/bin', NODE_ENV: 'production', DATABASE_URL: 'postgres://u:p@db/x', MASTER_ENCRYPTION_KEY: 'k', ANTHROPIC_API_KEY: 'a', SESSION_SECRET: 's' });
    assert.deepStrictEqual(env, { PATH: '/usr/bin', NODE_ENV: 'production' });
});
