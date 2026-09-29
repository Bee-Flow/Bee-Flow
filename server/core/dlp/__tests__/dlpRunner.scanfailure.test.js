/**
 * "No detector" must never be reported as "no PII".
 *
 * dlpRunner.scan() called detectPii() and inspected only `piiResult?.degraded`.
 * detectPii returns `null` — not a degraded object — when the guard service is
 * not installed at all, so that branch left `piiFailed` false and the scan
 * returned `{ action: 'allow', scanStatus: 'ok' }`. An organisation with the
 * Privacy Shield enabled, DLP enabled and `fail_closed` set therefore shipped
 * every message unmasked, while the audit row said the scan succeeded.
 *
 * The custom-terms scan had the same shape of hole one level down: its `catch`
 * assigned an empty findings array, which downstream is indistinguishable from
 * "nothing matched". Custom terms are now the org's own data types, run
 * inside detectPii; a type it could not cover comes back as a degraded result
 * naming that type, and "no guard" can come back as `guardAbsent` carrying
 * the matches the Node side did find.
 *
 * Run: node --test server/core/dlp/__tests__/dlpRunner.scanfailure.test.js
 */

const assert = require('assert');
const { test } = require('node:test');

process.env.NODE_ENV = 'test';

// ── Swap detectPii before dlpRunner captures it by destructuring ────────
const piiDetection = require('../../privacy/piiDetection');
let piiMode = 'not_installed';      // 'not_installed' | 'degraded' | 'clean'

const TYPE_ID = 'cdt_0123456789';
piiDetection.detectPii = async (text) => {
    if (piiMode === 'not_installed') return null;                     // guard absent
    if (piiMode === 'degraded') {
        return { hasPii: false, entities: [], degraded: true, degradedReason: 'model_not_ready: test' };
    }
    if (piiMode === 'custom_partial') {
        return { hasPii: false, entities: [], degraded: true, degradedReason: 'custom_scan_partial', degradedCategories: [TYPE_ID] };
    }
    if (piiMode === 'guard_absent') {
        const at = String(text).indexOf('Aurora');
        const entities = at < 0 ? [] : [{ text: 'Aurora', category: TYPE_ID, label: 'Codename', offset: at, length: 6, confidence: 1 }];
        return { hasPii: entities.length > 0, entities, degraded: false, guardAbsent: true };
    }
    return { hasPii: false, entities: [] };
};

// classifyProvider decides external-vs-internal; keep every scan in scope.
const classification = require('../../providers/classification');
classification.classifyProvider = () => 'external';

const dlpRunner = require('../dlpRunner');

const baseShield = {
    enabled: true,
    dlpEnabled: true,
    dlpScope: 'all',
    dlpMode: 'auto_redact',
    customSensitiveTerms: [],
};

function scan(shieldOverrides = {}, text = 'Gewoon een bericht zonder bijzonderheden') {
    return dlpRunner.scan({
        messages: [{ role: 'user', content: text }],
        orgShieldConfig: { ...baseShield, ...shieldOverrides },
        orgId: 'org-test',
        conversationId: `conv-${Math.random().toString(36).slice(2)}`,
        providerConfig: { provider: 'openai' },
    });
}

test('guard not installed + fail_closed → blocks, and says why', async () => {
    piiMode = 'not_installed';
    const result = await scan({ piiFailureMode: 'fail_closed' });

    assert.strictEqual(result.action, 'block',
        'a fail_closed org shipped the message because the guard was merely absent');
    assert.strictEqual(result.scanStatus, 'failed');
    assert.strictEqual(result.reason, 'guard_not_installed',
        'the operator must be able to tell "not installed" from "unreachable"');
});

test('guard not installed + fail_open → allowed, but marked as failed', async () => {
    piiMode = 'not_installed';
    const result = await scan({ piiFailureMode: 'fail_open' });

    assert.strictEqual(result.action, 'allow');
    assert.strictEqual(result.scanStatus, 'failed',
        'fail_open may send the message but must not claim the scan succeeded');
});

test('a degraded guard still blocks under fail_closed (unchanged)', async () => {
    piiMode = 'degraded';
    const result = await scan({ piiFailureMode: 'fail_closed' });
    assert.strictEqual(result.action, 'block');
    assert.strictEqual(result.reason, 'pii_unavailable');
});

test('a healthy clean scan still allows and reports ok', async () => {
    piiMode = 'clean';
    const result = await scan({ piiFailureMode: 'fail_closed' });
    assert.strictEqual(result.action, 'allow');
    assert.strictEqual(result.scanStatus, 'ok');
});

test('shield disabled → the guard is not consulted and absence is not a failure', async () => {
    piiMode = 'not_installed';
    const result = await scan({ enabled: false, piiFailureMode: 'fail_closed' });
    assert.strictEqual(result.action, 'allow',
        'an org that never enabled PII scanning must not be blocked by its absence');
    assert.strictEqual(result.scanStatus, 'ok');
});

test('an org data type the scan could not cover is a coverage gap, not a clean result', async () => {
    piiMode = 'custom_partial';
    const blocked = await scan({ piiFailureMode: 'fail_closed', piiDetectionCategories: ['Email', TYPE_ID] });
    assert.strictEqual(blocked.action, 'block');
    assert.strictEqual(blocked.reason, 'pii_unavailable');

    // A scope that does not include the type is not affected by its gap.
    const allowed = await scan({ piiFailureMode: 'fail_closed', piiDetectionCategories: ['Email'] });
    assert.strictEqual(allowed.action, 'allow',
        'a gap in a data type the org does not scan for blocked the message');
});

test('no guard but the org\'s own words matched: a failure for the policy, and still redacted when it fails open', async () => {
    piiMode = 'guard_absent';
    const text = 'Status van project Aurora graag';
    const closed = await scan({ piiFailureMode: 'fail_closed', piiDetectionCategories: [TYPE_ID] }, text);
    assert.strictEqual(closed.action, 'block');
    assert.strictEqual(closed.reason, 'guard_not_installed');

    const open = await scan({ piiFailureMode: 'fail_open', piiDetectionCategories: [TYPE_ID] }, text);
    assert.strictEqual(open.action, 'redact');
    assert.ok(!open.redactedText.includes('Aurora'), 'the org\'s own word reached the model');
    assert.deepStrictEqual(open.findings.map(f => [f.category, f.source]), [[TYPE_ID, 'custom']]);
});
