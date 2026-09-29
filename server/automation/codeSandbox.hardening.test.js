'use strict';

/**
 * The sandbox as an attacker meets it.
 *
 * GHSA-864f-rcv7-6rh4 (isolated-vm, critical, 2026-08-07): a guest that holds
 * a single `ivm.Reference` can reach the ExternalCopy constructor and corrupt
 * host memory. Fixed in 6.2.0 / 7.0.1; this server ran 5.0.4 with four raw
 * References on the isolate's global. These tests pin both halves of the fix
 * (the version, and no isolated-vm object within the guest's reach), plus the
 * host-side caps that keep one step from exhausting the API process.
 *
 * Run: node --test automation/codeSandbox.hardening.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const sandbox = require('./codeSandbox');

const run = (code, extra = {}) => sandbox.runCode({ code, inputs: extra.inputs || {}, limits: extra.limits || {}, bridges: extra.bridges || {} });

function versionAtLeast(v, min) {
    const a = v.split('.').map(Number);
    const b = min.split('.').map(Number);
    for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
    return true;
}

test('isolated-vm is at a release with the GHSA-864f-rcv7-6rh4 fix', () => {
    const { version } = require('isolated-vm/package.json');
    const fixed = version.startsWith('6.') ? versionAtLeast(version, '6.2.0') : versionAtLeast(version, '7.0.1');
    assert.ok(fixed, `isolated-vm ${version} is vulnerable; the fix is in 6.2.0 and 7.0.1`);
});

test('no isolated-vm object or internal bridge is reachable from the guest', async () => {
    const { result } = await run(`
        const names = Object.getOwnPropertyNames(globalThis);
        return {
            internals: names.filter(n => n.startsWith('__host') || n.startsWith('__bf')),
            types: [typeof __hostHttp, typeof __hostCallTool, typeof __hostLog, typeof __hostDb, typeof __bfSettle, typeof __bfCtx],
            ctxKinds: Object.values(ctx).map(v => typeof v),
        };
    `, { bridges: { db: async () => ({ rows: [] }) } });
    assert.deepStrictEqual(result.internals, []);
    assert.deepStrictEqual(result.types, Array(6).fill('undefined'));
    // Everything on ctx is a plain function or a plain (frozen) object.
    for (const kind of result.ctxKinds) assert.ok(['function', 'object'].includes(kind));
});

test('ctx cannot be rewired by the guest', async () => {
    const { result } = await run(`
        ctx.http = () => 'hijacked';
        return { frozen: Object.isFrozen(ctx), still: ctx.http !== undefined && ctx.http.toString().includes('hijacked') === false };
    `);
    assert.deepStrictEqual(result, { frozen: true, still: true });
});

test('the bridges still work: http, integrations, log and db round-trip', async () => {
    const seen = [];
    const { result, logs } = await run(`
        async function main(inputs, ctx) {
            ctx.log('hello', { n: inputs.n });
            const r = await ctx.http('https://example.com/x', { method: 'POST', body: { a: 1 } });
            const t = await ctx.integrations.gmail_send({ to: 'x' });
            const d = await ctx.db.query('select 1', []);
            return { status: r.status, tool: t.ok, rows: d.rows.length };
        }
    `, {
        inputs: { n: 3 },
        bridges: {
            fetchHttp: async (url, opts) => { seen.push(['http', url, opts.method]); return { status: 201, body: '' }; },
            executeTool: async (name) => { seen.push(['tool', name]); return { ok: true }; },
            allowedTools: new Set(['gmail_send']),
            db: async (op) => { seen.push(['db', op]); return { rows: [{ one: 1 }] }; },
        },
    });
    assert.deepStrictEqual(result, { status: 201, tool: true, rows: 1 });
    assert.deepStrictEqual(seen, [['http', 'https://example.com/x', 'POST'], ['tool', 'gmail_send'], ['db', 'query']]);
    assert.deepStrictEqual(logs, ['hello {"n":3}']);
});

test('a host bridge that throws answers the guest with { error }, never hangs', async () => {
    const { result } = await run(`return await ctx.http('https://example.com');`, {
        bridges: { fetchHttp: async () => { throw new Error('boom'); } },
    });
    assert.deepStrictEqual(result, { error: 'boom' });
});

test('CPU burnt AFTER an await is still stopped by the CPU limit, not only the wall clock', async () => {
    // isolated-vm's own `timeout` covers the run up to the first yield only.
    const started = Date.now();
    await assert.rejects(
        run(`await null; while (true) {}`, { limits: { cpuMs: 200, wallMs: 10_000 } }),
        /exceeded CPU limit \(200ms\)/,
    );
    assert.ok(Date.now() - started < 5_000, 'stopped by the CPU watchdog, well before the 10 s wall clock');
});

test('a huge return value is refused inside the isolate, before it is copied out', async () => {
    await assert.rejects(
        run(`return 'x'.repeat(1100 * 1024);`, { limits: { memoryMb: 128 } }),
        /most a code step may return is 1024 KB/,
    );
});

test('log output is capped per line and per run', async () => {
    const { logs } = await run(`
        ctx.log('y'.repeat(10 * 1024));
        for (let i = 0; i < 200; i++) ctx.log('z'.repeat(1000));
        return true;
    `);
    const total = logs.reduce((n, l) => n + l.length, 0);
    assert.ok(logs[0].includes('line cut at 4096 characters'), 'a long line is cut');
    assert.ok(total <= 64 * 1024 + 200, `total log output stays near 64 KB (was ${total})`);
    assert.match(logs[logs.length - 1], /more log output was dropped/);
});

test('one oversized request, and a run that sends too much in total, are refused', async () => {
    const sent = [];
    const { result } = await run(`
        const big = await ctx.http('https://example.com', { method: 'POST', body: 'a'.repeat(300 * 1024) });
        const parts = [];
        for (let i = 0; i < 5; i++) parts.push(await ctx.http('https://example.com', { method: 'POST', body: 'b'.repeat(250 * 1024) }));
        return { big: big.error, last: parts[4].error || null, okCount: parts.filter(p => !p.error).length };
    `, {
        limits: { httpBudget: 20, memoryMb: 128 },
        bridges: { fetchHttp: async (url, opts) => { sent.push(opts.body.length); return { status: 200 }; } },
    });
    assert.match(result.big, /request too large/);
    assert.match(result.last, /most one run may send/);
    assert.strictEqual(result.okCount, 4, 'four requests of 250 KB fit in the 1 MB per run');
    assert.strictEqual(sent.length, 4, 'the refused ones never reached the bridge');
});
