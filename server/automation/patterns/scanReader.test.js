'use strict';

/**
 * The scan reader: every read a scan makes passes the Shield's block lists,
 * runs in its own capture context, lands on the egress ledger under the
 * scan's audit base, and stops when the scan or the source stops. All
 * collaborators injected.
 *
 * Run: cd server && node --test automation/patterns/scanReader.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { makeScanReader, asToolExecutor } = require('./scanReader');

function setup({ refuse = null, fail = null } = {}) {
    const fx = { calls: [], egress: [], guardrail: [], gateArgs: null };
    const deps = {
        toolLoopGate: (opts) => {
            fx.gateArgs = opts;
            return {
                refuse: async (name) => {
                    if (!refuse) return null;
                    await opts.audit({ action_taken: 'tool_blocked' }, name);
                    return { uiResult: 'refused', modelError: `${name} was not called` };
                },
                forModel: async (c) => c,
            };
        },
        logGuardrailEvent: async (row) => { fx.guardrail.push(row); },
        captureCall: async (fn) => { try { return { ok: true, value: await fn(), probe: { peer: 'x' } }; } catch (e) { return { ok: false, error: e, probe: null }; } },
        executeTool: async (name, args, ctx) => {
            fx.calls.push({ name, args, ctx });
            if (fail) throw fail;
            return { results: [1, 2] };
        },
        logEgress: async (row) => { fx.egress.push(row); },
    };
    return { fx, deps };
}

const ctx = (over = {}) => ({
    userId: 'u1', orgId: 'org-1', session: { user: { id: 'u1' } },
    policy: { shield: { enabled: true } }, auditBase: { source: 'pattern_scan', user_id: 'u1' }, ...over,
});

test('a read runs as the user and is written to the ledger under the scan\'s audit base', async () => {
    const { fx, deps } = setup();
    const reader = makeScanReader(ctx(), deps);
    const r = await reader.read('gmail_search', { query: 'newer_than:90d' });
    assert.deepStrictEqual(r, { ok: true, value: { results: [1, 2] } });
    assert.strictEqual(fx.calls[0].ctx.userId, 'u1');
    assert.strictEqual(fx.calls[0].ctx.orgId, 'org-1');
    assert.strictEqual(fx.egress.length, 1);
    assert.strictEqual(fx.egress[0].auditBase.source, 'pattern_scan');
    assert.strictEqual(fx.egress[0].mode, 'live');
    assert.deepStrictEqual(fx.egress[0].probe, { peer: 'x' });
    assert.deepStrictEqual(fx.gateArgs.shield, { enabled: true });
});

test('a read the Shield refuses is never made, and the refusal is filed with the scan\'s attribution', async () => {
    const { fx, deps } = setup({ refuse: true });
    const reader = makeScanReader(ctx(), deps);
    const r = await reader.read('kb_search', { query: 'someone@example.test' });
    assert.strictEqual(r.ok, false);
    assert.match(r.refusal.modelError, /was not called/);
    assert.deepStrictEqual(fx.calls, []);
    assert.deepStrictEqual(fx.guardrail, [{ source: 'pattern_scan', user_id: 'u1', action_taken: 'tool_blocked' }]);
    await assert.rejects(asToolExecutor(reader)('kb_search', {}), (err) => {
        assert.match(err.message, /refused by the Privacy Shield/);
        assert.strictEqual(err.code, 'shield', 'the scan shows it as blocked by the Shield, not as a failed read');
        return true;
    });
});

test('a failed read is on the ledger with its error, and the executor throws it', async () => {
    const { fx, deps } = setup({ fail: new Error('401 unauthorized') });
    const reader = makeScanReader(ctx(), deps);
    const r = await reader.read('gmail_search', {});
    assert.strictEqual(r.ok, false);
    assert.match(fx.egress[0].error.message, /401/);
    await assert.rejects(asToolExecutor(reader)('gmail_search', {}), /401 unauthorized/);
});

test('a stopped scan or a stopped source reads nothing more; the source\'s signal reaches the tool', async () => {
    const scan = new AbortController();
    const { fx, deps } = setup();
    const reader = makeScanReader(ctx({ signal: scan.signal }), deps);
    const source = new AbortController();
    await asToolExecutor(reader)('gmail_search', {}, { signal: source.signal });
    const passed = fx.calls[0].ctx.signal;
    assert.strictEqual(passed.aborted, false);
    source.abort();
    assert.strictEqual(passed.aborted, true, 'the tool sees the source being cut');

    await assert.rejects(asToolExecutor(reader)('gmail_search', {}, { signal: source.signal }), /scan stopped/);
    scan.abort();
    const r = await reader.read('gmail_search', {});
    assert.strictEqual(r.ok, false);
    assert.strictEqual(fx.calls.length, 1);
});
