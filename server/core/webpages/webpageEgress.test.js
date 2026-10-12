/**
 * A webpage api/ handler leaves through the Privacy Shield, like every other
 * way out of the platform.
 *
 * integrations/webpageApiRuntime.js runs author-written JavaScript in the SAME
 * isolated-vm sandbox the automation `code` step uses — and handed it
 * `fetchHttp: codeSandbox.defaultFetchHttp` raw plus an executeTool that
 * called the dispatcher directly. One sandbox, two callers, opposite postures:
 * a code step's calls are scanned and land in the outbound ledger, a webpage
 * handler's did neither, at 2-4x the limits, acting as the page's AUTHOR and
 * holding a `db` bridge no automation gets.
 *
 * These tests pin the CONTRACT rather than the wording: every route out calls
 * the guard, asks prepareForEgress what may leave, writes exactly one ledger
 * row, and files it as a webpage rather than as an automation.
 *
 * Run: cd server && node --test --test-force-exit core/webpages/webpageEgress.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// ── Stub safety.js, the module under contract ───────────────────────────────
// Everything this module decides comes from core/automationRunner/safety.js;
// what it owns is the ORDER and the ARGUMENTS. So the stub records calls and
// the assertions are about the sequence.

const calls = [];
require.resolve('../automationRunner/safety');

class FakeBlock extends Error {
    constructor(msg) { super(msg); this.guardrailBlocked = true; }
}

const safetyStub = {
    async resolveAutomationPolicy(ctx, opts) {
        calls.push({ fn: 'resolveAutomationPolicy', orgId: ctx.orgId, opts });
        return { action: 'off', piiEnabled: true, privacyScope: 'external', monitorIntegrations: true, confidence: 0.7 };
    },
    buildAuditBase(ctx, step, opts) {
        calls.push({ fn: 'buildAuditBase', stepId: step && step.id, opts, automationId: ctx.automationId });
        return { source: (opts && opts.source) || 'automation', organization_id: ctx.orgId, model: null };
    },
    async guardToolInput(payload, _p, _a, mode) {
        calls.push({ fn: 'guardToolInput', payload, mode });
        if (payload && JSON.stringify(payload).includes('BLOCKME')) throw new FakeBlock('refused by policy');
        return { value: payload };
    },
    prepareForEgress(value, _p, _ctx, { destination }) {
        calls.push({ fn: 'prepareForEgress', destination });
        return value;
    },
    async guardToolOutput(value) {
        calls.push({ fn: 'guardToolOutput', value });
        return { result: value };
    },
    async logEgress(row) {
        calls.push({ fn: 'logEgress', toolName: row.toolName, blocked: !!row.blocked, source: row.auditBase && row.auditBase.source });
    },
    restoreForRunState(v) { calls.push({ fn: 'restoreForRunState' }); return v; },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (parent && /webpageEgress\.js$/.test(parent.filename) && request === '../automationRunner/safety') {
        return safetyStub;
    }
    return originalLoad.call(this, request, parent, isMain);
};

const egress = require('./webpageEgress');
Module._load = originalLoad;

async function session() {
    calls.length = 0;
    return egress.resolveWebpagePolicy({ webpageId: 'wp_1', authorUserId: 'u1', authorOrgId: 'org1' });
}
const names = () => calls.map(c => c.fn);

// ── Policy identity ─────────────────────────────────────────────────────────

test('a webpage handler does NOT inherit the org opt-out named "Apply to automations"', async () => {
    // The switch's own label is exactly what it says. A handler inheriting it
    // would drop the shield on a surface the admin never agreed to exclude.
    await session();
    const resolve = calls.find(c => c.fn === 'resolveAutomationPolicy');
    assert.deepStrictEqual(resolve.opts, { honourAutomationOptOut: false });
});

test('its ledger rows are filed as a webpage, not as an automation', async () => {
    await session();
    const audit = calls.find(c => c.fn === 'buildAuditBase');
    assert.strictEqual(audit.opts.source, 'webpage_api');
    assert.strictEqual(egress.WEBPAGE_SOURCE, 'webpage_api');
    // Grouped per page the way an automation's rows group per automation.
    assert.strictEqual(audit.automationId, 'wp_1');
});

// ── ctx.integrations.<tool>() ───────────────────────────────────────────────

test('a granted tool call is scanned, prepared, dispatched, logged and scanned back', async () => {
    const s = await session();
    const grantByTool = new Map([['gmail_send', { tool: 'gmail_send', fixedArgs: { from: 'a@b.c' } }]]);
    const bridge = egress.makeToolBridge(s, { grantByTool, dispatch: async () => ({ ok: true }) });

    calls.length = 0;
    const out = await bridge('gmail_send', { to: 'x@y.z' });
    assert.deepStrictEqual(out, { ok: true });
    assert.deepStrictEqual(names(), [
        'guardToolInput', 'prepareForEgress', 'logEgress', 'guardToolOutput',
    ]);
    // fixedArgs still merged server-side, and the guard sees the merged payload.
    assert.deepStrictEqual(calls[0].payload, { to: 'x@y.z', from: 'a@b.c' });
});

test('an ungranted tool never reaches the guard or the ledger', async () => {
    const s = await session();
    const bridge = egress.makeToolBridge(s, { grantByTool: new Map(), dispatch: async () => ({ ok: true }) });
    calls.length = 0;
    const out = await bridge('gmail_send', {});
    assert.match(out.error, /not granted/);
    assert.deepStrictEqual(names(), []);
});

test('a blocked tool payload is logged once as blocked and never dispatched', async () => {
    const s = await session();
    let dispatched = false;
    const grantByTool = new Map([['gmail_send', { tool: 'gmail_send' }]]);
    const bridge = egress.makeToolBridge(s, {
        grantByTool,
        dispatch: async () => { dispatched = true; return {}; },
    });
    calls.length = 0;
    const out = await bridge('gmail_send', { body: 'BLOCKME' });
    assert.match(out.error, /refused by policy/);
    assert.strictEqual(dispatched, false, 'a blocked payload must not be dispatched');
    const logged = calls.filter(c => c.fn === 'logEgress');
    assert.strictEqual(logged.length, 1);
    assert.strictEqual(logged[0].blocked, true);
});

// ── ctx.http() ──────────────────────────────────────────────────────────────

test('a fetch guards url, body AND request headers, then the response', async () => {
    const s = await session();
    const seen = [];
    const bridge = egress.makeHttpBridge(s, {
        rawFetch: async (url, opts) => { seen.push({ url, opts }); return { status: 200, body: 'hi' }; },
    });
    calls.length = 0;
    await bridge('https://api.example.com/x', { body: 'b', headers: { 'x-token': 't' } });

    const guarded = calls.find(c => c.fn === 'guardToolInput');
    assert.deepStrictEqual(Object.keys(guarded.payload).sort(), ['body', 'headers', 'url']);
    assert.deepStrictEqual(names(), ['guardToolInput', 'prepareForEgress', 'logEgress', 'guardToolOutput']);
});

test('what travels is built from the GUARDED result, not the handler object', async () => {
    const s = await session();
    let sent = null;
    const bridge = egress.makeHttpBridge(s, {
        rawFetch: async (url, opts) => { sent = { url, opts }; return {}; },
    });
    // prepareForEgress is identity in the stub, so this pins the plumbing:
    // the outgoing options must be REBUILT, carrying the guarded body/headers.
    await bridge('https://api.example.com/x', { body: 'b', headers: { a: '1' }, method: 'POST' });
    assert.strictEqual(sent.opts.method, 'POST', 'unguarded options still pass through');
    assert.deepStrictEqual(sent.opts.headers, { a: '1' });
});

test('a blocked fetch returns the sandbox error shape rather than throwing', async () => {
    const s = await session();
    let fetched = false;
    const bridge = egress.makeHttpBridge(s, { rawFetch: async () => { fetched = true; return {}; } });
    const out = await bridge('https://api.example.com/x', { body: 'BLOCKME' });
    assert.match(out.error, /refused by policy/);
    assert.strictEqual(fetched, false);
});

// ── the return value ────────────────────────────────────────────────────────

test('the handler RESULT is scanned — the widest way out, and the one no bridge sees', async () => {
    // A handler that queried the page's own SQLite and returned the rows has
    // moved personal data to a browser without a tool call or a fetch.
    const s = await session();
    calls.length = 0;
    const out = await egress.guardWebpageResult(s, { rows: [{ email: 'a@b.c' }] });
    assert.deepStrictEqual(names(), ['guardToolOutput']);
    assert.deepStrictEqual(out, { rows: [{ email: 'a@b.c' }] });
});

test('values are never restored from a run vault — there is no next step, only a browser', async () => {
    const s = await session();
    const grantByTool = new Map([['t', { tool: 't' }]]);
    const bridge = egress.makeToolBridge(s, { grantByTool, dispatch: async () => ({ ok: 1 }) });
    calls.length = 0;
    await bridge('t', {});
    await egress.guardWebpageResult(s, { x: 1 });
    assert.ok(!names().includes('restoreForRunState'),
        'restoreForRunState puts real values back for a later STEP; a masked value must '
        + 'stay masked on its way to a browser');
});
