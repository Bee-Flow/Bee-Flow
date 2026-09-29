/**
 * BFSF-269 — fail-open / fail-closed policy when PII detection is degraded.
 *
 * The guard used to fail SILENTLY: an unreachable guard (or a not-ready GLiNER
 * model) returned no/partial detections and the message was sent unmasked with
 * a falsely-reassuring badge. These tests pin the new behaviour:
 *
 *   - detectPii() returns a `degraded` result (not bare null) when the guard is
 *     installed but unreachable, so callers can tell "clean" from "couldn't scan".
 *   - validateInputForPii() blocks (throws `privacyUnavailable`) under
 *     fail_closed, and allows (returns null) under fail_open.
 *   - dlpRunner.scan() blocks a degraded scan under fail_closed.
 *
 * Isolated from the DB: aiAgent + configStore are stubbed in the require cache,
 * and the guard endpoint is pointed at an unreachable port so the real
 * detectPii path exercises its error → degraded branch.
 *
 * Run: node --test server/core/piiDetection.failmode.test.js
 */

const assert = require('assert');
const { test } = require('node:test');

process.env.NODE_ENV = 'test';

// ── Stub heavy deps BEFORE requiring piiDetection ──────────────────────
function stub(id, exports) {
    const resolved = require.resolve(id);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
    return resolved;
}
// getAIConfig() lazily requires ./aiAgent — return a minimal config.
stub('../aiAgent', { getAIConfig: async () => ({ piiDetectionEnabled: false, piiDetectionAction: 'block' }) });
// configStore is required at module load and inside getGuardEndpoint.
stub('../../stores/configStore', {
    getConfig: async () => null,
    getSecret: async () => '',
    getAllConfig: async () => ({}),
});

// Point the guard at an unreachable port so detectPiiViaCpuModel throws →
// detectPii returns { degraded: true } (installed-but-unreachable path).
process.env.PII_SERVICE_URL = 'http://127.0.0.1:1';
delete process.env.PII_SERVICE_API_KEY;

const piiDetection = require('./piiDetection');
const { detectPii, validateInputForPii } = piiDetection;

const USER_MSG = [{ role: 'user', content: 'Beste Mark en Sanne, groet Eva Meijer' }];

test('detectPii returns a degraded result (not null) when the guard is unreachable', async () => {
    const result = await detectPii('Beste Mark en Sanne', ['Person']);
    assert.ok(result, 'expected an object, not null, when guard is installed-but-down');
    assert.strictEqual(result.degraded, true);
    assert.strictEqual(result.hasPii, false);
});

test('validateInputForPii fail_closed → throws privacyUnavailable on degraded detection', async () => {
    const shield = { enabled: true, piiDetectionAction: 'tokenize', piiFailureMode: 'fail_closed' };
    await assert.rejects(
        () => validateInputForPii(USER_MSG, true, shield),
        (err) => {
            assert.strictEqual(err.privacyUnavailable, true);
            assert.ok(!/PII Detected/.test(err.message), 'should be the unavailable block, not the PII block');
            return true;
        },
    );
});

test('validateInputForPii fail_open → returns null (sends) on degraded detection', async () => {
    const shield = { enabled: true, piiDetectionAction: 'tokenize', piiFailureMode: 'fail_open' };
    const result = await validateInputForPii(
        [{ role: 'user', content: 'Andere tekst met Mark en Sanne erin' }],
        true,
        shield,
    );
    assert.strictEqual(result, null);
});

test('validateInputForPii defaults to fail_closed when piiFailureMode is unset', async () => {
    const shield = { enabled: true, piiDetectionAction: 'tokenize' }; // no piiFailureMode
    await assert.rejects(
        () => validateInputForPii(
            [{ role: 'user', content: 'Weer andere tekst, Mark, Sanne, Eva' }],
            true,
            shield,
        ),
        (err) => err.privacyUnavailable === true,
    );
});

// ── dlpRunner.scan degraded → block under fail_closed ──────────────────
// dlpRunner captured detectPii by destructuring at require time, so patch the
// export and require it AFTER the patch (mirrors attachmentScanner.test.js).
piiDetection.detectPii = async () => ({ hasPii: false, entities: [], degraded: true, degradedReason: 'model_not_ready' });
delete require.cache[require.resolve('../dlp/dlpRunner')];
const dlpRunner = require('../dlp/dlpRunner');

test('dlpRunner.scan blocks a degraded scan under fail_closed', async () => {
    const res = await dlpRunner.scan({
        messages: [{ role: 'user', content: 'Stuur dit naar Mark en Sanne alsjeblieft' }],
        orgShieldConfig: {
            enabled: true,
            dlpEnabled: true,
            dlpScope: 'all',          // skip the external-provider gate
            piiFailureMode: 'fail_closed',
        },
        orgId: 'org-test',
        conversationId: 'conv-test',
        providerConfig: { providerType: 'openai', url: 'https://api.openai.com', displayName: 'OpenAI' },
    });
    assert.strictEqual(res.action, 'block');
    assert.strictEqual(res.reason, 'pii_unavailable');
    assert.strictEqual(res.scanStatus, 'failed');
});

test('dlpRunner.scan allows a degraded scan under fail_open', async () => {
    const res = await dlpRunner.scan({
        messages: [{ role: 'user', content: 'Stuur dit naar Mark en Sanne alsjeblieft' }],
        orgShieldConfig: {
            enabled: true,
            dlpEnabled: true,
            dlpScope: 'all',
            dlpMode: 'auto_allow',
            piiFailureMode: 'fail_open',
        },
        orgId: 'org-test',
        conversationId: 'conv-test-2',
        providerConfig: { providerType: 'openai', url: 'https://api.openai.com', displayName: 'OpenAI' },
    });
    assert.notStrictEqual(res.action, 'block');
});
