/**
 * Egress logging through the shared logger — the automation half.
 *
 * Pins the four behaviours the producer refactor introduced:
 *  1. logEgress DETACHES: it resolves before the insert lands (monitoring is
 *     off the critical path of every automation step), and flushEgressLogs()
 *     drains the stragglers.
 *  2. Routine rows carry agent_id = NULL + automation_id (the automation id
 *     used to be stuffed into agent_id, polluting every 'agent' breakdown).
 *  3. Failed/blocked calls produce rows with status 'error'/'blocked'.
 *  4. monitorIntegrations OFF still writes the metadata row (owner decision:
 *     the toggle gates content scanning only) — with pii_scan_level 'none'
 *     and no categories.
 *
 * Hermetic: the activity store is stubbed; policy.piiEnabled=false keeps
 * GLiNER out entirely.
 *
 * Run: node --test server/core/automationRunner/safety.egress.test.js
 */

const assert = require('node:assert');
const { test } = require('node:test');
const path = require('path');
const Module = require('module');

// ── Stub the activity store (required from core/integrations/integrationLogging.js) ─
const inserted = [];
let releaseInsert = null;
const storeStub = {
    async logIntegrationActivity(event) {
        if (releaseInsert) await releaseInsert; // lets the detachment test hold the insert open
        inserted.push(event);
    },
};
const CORE_DIR = path.sep + 'core' + path.sep;
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && parent.filename && parent.filename.includes(CORE_DIR)
        && request === '../../stores/integrationActivityStore') {
        return path.join(__dirname, '__stub_store_egress__.js');
    }
    return origResolve.call(this, request, parent, ...rest);
};
{
    const full = path.join(__dirname, '__stub_store_egress__.js');
    require.cache[full] = { id: full, filename: full, loaded: true, exports: storeStub };
}

const safety = require('./safety');
const { flushEgressLogs } = require('../integrations/integrationLogging');

const policy = (over = {}) => ({
    monitorIntegrations: true,
    piiEnabled: false, // keep GLiNER out of the tests
    confidence: 0.7,
    ...over,
});
const auditBase = {
    organization_id: 'org1',
    user_id: 'u1',
    agent_name: 'Weekly digest',
    conversation_id: 'auto-1',
    automation_id: 'auto-1',
    run_id: 'run-9',
    step_id: 's3',
    source: 'routine',
    model: null,
    nextcloudUrl: null,
};

test('logEgress detaches — resolves before the insert lands; flush drains it', async () => {
    let release;
    releaseInsert = new Promise(r => { release = r; });
    const t0 = Date.now();
    await safety.logEgress({
        toolName: 'gmail_send_email',
        toolArgs: { to: 'x@y.z' },
        result: { ok: true },
        probe: null,
        policy: policy(),
        auditBase,
        mode: 'live',
        durationMs: 42,
    });
    assert.ok(Date.now() - t0 < 200, 'logEgress must not wait for the insert');
    assert.strictEqual(inserted.length, 0, 'insert must still be pending');
    release();
    releaseInsert = null;
    await flushEgressLogs();
    assert.strictEqual(inserted.length, 1, 'flushEgressLogs must drain the pending row');
});

test('routine rows: agent_id NULL, automation attribution intact, duration carried', async () => {
    const row = inserted[0];
    assert.strictEqual(row.agent_id, null, 'routines are not agents');
    assert.strictEqual(row.automation_id, 'auto-1');
    assert.strictEqual(row.run_id, 'run-9');
    assert.strictEqual(row.step_id, 's3');
    assert.strictEqual(row.source, 'routine');
    assert.strictEqual(row.status, 'success');
    assert.strictEqual(row.duration_ms, 42);
    assert.strictEqual(row.pii_scan_level, 'basic', 'monitor on + no GLiNER = basic sniff');
});

test('a failed call writes a status=error row', async () => {
    inserted.length = 0;
    await safety.logEgress({
        toolName: 'gmail_send_email',
        toolArgs: {},
        error: new Error('SMTP 550 mailbox unavailable'),
        policy: policy(),
        auditBase,
        mode: 'live',
    });
    await flushEgressLogs();
    assert.strictEqual(inserted.length, 1);
    assert.strictEqual(inserted[0].status, 'error');
    assert.match(inserted[0].error_message, /550/);
});

test('a guardrail-blocked call writes a status=blocked row', async () => {
    inserted.length = 0;
    await safety.logEgress({
        toolName: 'gmail_send_email',
        toolArgs: {},
        blocked: true,
        policy: policy(),
        auditBase,
        mode: 'live',
    });
    await flushEgressLogs();
    assert.strictEqual(inserted[0].status, 'blocked');
});

test('monitorIntegrations OFF: metadata row still written, content never scanned', async () => {
    inserted.length = 0;
    await safety.logEgress({
        toolName: 'gmail_send_email',
        toolArgs: { body: 'mail piet@acme.nl' }, // would trip the sniff if scanned
        result: 'ok',
        policy: policy({ monitorIntegrations: false }),
        auditBase,
        mode: 'live',
    });
    await flushEgressLogs();
    assert.strictEqual(inserted.length, 1, 'the audit row must not depend on the toggle');
    assert.strictEqual(inserted[0].pii_scan_level, 'none');
    assert.strictEqual(inserted[0].pii_categories_detected, null, 'no scan may have run');
});

test('dry runs are flagged, internal tools produce no row', async () => {
    inserted.length = 0;
    await safety.logEgress({
        toolName: 'gmail_search', toolArgs: {}, result: [], policy: policy(), auditBase, mode: 'dry_run',
    });
    await safety.logEgress({
        toolName: 'set_reminder', toolArgs: {}, result: 'ok', policy: policy(), auditBase, mode: 'live',
    });
    await flushEgressLogs();
    assert.strictEqual(inserted.length, 1, 'internal tool must not produce a row');
    assert.strictEqual(inserted[0].is_dry_run, true);
});

test.after(() => { Module._resolveFilename = origResolve; });
