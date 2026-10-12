'use strict';

/**
 * POST /code/analyze and POST /code/test, through a real Express app with the
 * real analyser and the real sandbox; the automation store and the access check
 * are injected (no database).
 *
 * Run: node --test routes/automation/codeTools.test.js
 */

const { test, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { makeCodeToolsRouter } = require('./codeTools');

const automations = { r1: { id: 'r1', userId: 'owner', organizationId: 'org1' } };
const roles = { owner: 'owner', viewer: 'view' };
const access = {
    guard: async (req, res, a, need) => {
        const role = roles[req.session.user.id] || null;
        const ok = role === 'owner' || (need === 'view' && role === 'view');
        if (!ok) { res.status(403).json({ error: 'Forbidden' }); return null; }
        return { role };
    },
};

function appFor(userId) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.session = { user: { id: userId, organizationId: 'org1' } }; next(); });
    app.use(makeCodeToolsRouter({
        store: { getAutomation: async (id) => automations[id] || null },
        access,
        limiter: (_req, _res, next) => next(),
    }));
    return app;
}

const servers = [];
async function post(userId, path, body) {
    const server = appFor(userId).listen(0);
    servers.push(server);
    const { port } = server.address();
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const text = await r.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (_) { parsed = { raw: text }; }
    return { status: r.status, body: parsed };
}
after(() => servers.forEach((s) => s.close()));

const VAT = `/**
 * Adds VAT to an amount.
 * @param {number} amount - The amount without VAT
 * @param {number} [vatRate=21] - VAT percentage
 */
async function main(inputs, ctx) {
    await ctx.http('https://api.example.com/log', { method: 'POST', body: { amount: inputs.amount } });
    return { total: Math.round(inputs.amount * (100 + inputs.vatRate)) / 100 };
}`;

test('analyze answers parameters, findings and capabilities, and stores nothing', async () => {
    const r = await post('owner', '/code/analyze', { code: VAT });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.description, 'Adds VAT to an amount.');
    assert.deepStrictEqual(r.body.params.map((p) => p.name), ['amount', 'vatRate']);
    assert.deepStrictEqual(r.body.capabilities.hosts, ['api.example.com']);
    assert.deepStrictEqual(r.body.findings, []);
});

test('try it: runs with defaults applied and coerced values, and sends nothing for real', async () => {
    const r = await post('owner', '/code/test', { code: VAT, inputs: { amount: '100' } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(r.body.result, { total: 121 });
    assert.deepStrictEqual(r.body.calls.map((c) => [c.kind, c.name]), [['http', 'https://api.example.com/log']]);
    assert.strictEqual(typeof r.body.durationMs, 'number');
});

test('try it: a missing required parameter is named in a plain sentence', async () => {
    const r = await post('owner', '/code/test', { code: VAT, inputs: {} });
    assert.strictEqual(r.status, 422);
    assert.strictEqual(r.body.code, 'code_param_invalid');
    assert.match(r.body.error, /Amount/);
});

test('try it: code with a BLOCK finding never runs', async () => {
    const r = await post('owner', '/code/test', { code: 'return eval("1+1");' });
    assert.strictEqual(r.status, 422);
    assert.strictEqual(r.body.code, 'code_blocked');
    assert.strictEqual(r.body.findings[0].ruleId, 'dynamic-code');
});

test('try it: a syntax error comes back with its position', async () => {
    const r = await post('owner', '/code/test', { code: 'return {;' });
    assert.strictEqual(r.status, 422);
    assert.strictEqual(r.body.code, 'code_syntax_error');
    assert.strictEqual(r.body.syntaxError.line, 1);
});

test('try it: code that throws is an answer, not a server error', async () => {
    const r = await post('owner', '/code/test', { code: 'throw new Error("nope");' });
    assert.strictEqual(r.status, 200);
    assert.match(r.body.error, /nope/);
});

test('a named automation needs edit to test and view to analyze', async () => {
    assert.strictEqual((await post('viewer', '/code/analyze', { code: 'return 1;', automationId: 'r1' })).status, 200);
    assert.strictEqual((await post('viewer', '/code/test', { code: 'return 1;', automationId: 'r1' })).status, 403);
    assert.strictEqual((await post('stranger', '/code/analyze', { code: 'return 1;', automationId: 'r1' })).status, 403);
    assert.strictEqual((await post('owner', '/code/test', { code: 'return 1;', automationId: 'missing' })).status, 404);
});

test('unknown body fields are refused', async () => {
    const r = await post('owner', '/code/analyze', { code: 'return 1;', evil: true });
    assert.strictEqual(r.status, 400);
});
