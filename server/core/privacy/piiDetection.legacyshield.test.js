/**
 * The legacy shield fallback must not guess which tenant it is scanning for.
 *
 * When a caller doesn't pass `orgShieldConfig`, validateInputForPii used to do
 *
 *     Object.keys(allConfigs).find(k => k.startsWith('org_privacy_shield_'))
 *
 * — the FIRST key of an unordered object. On a single-org install that happens
 * to be the right shield; on a multi-tenant install it applies an ARBITRARY
 * org's categories and confidence threshold to a different org's scan.
 *
 * Narrowing org B's scan to org A's category list is silent under-detection in
 * a privacy control, and nothing in the logs shows it: the line that reports
 * the resolved scope prints a perfectly plausible category count either way.
 *
 * The fix is the guard directChat.js already applies at :1528 and :2126 — use
 * the fallback only when there is exactly ONE shield, so single-tenant
 * self-host behaviour is preserved and the ambiguous case refuses to guess.
 *
 * Run: node --test server/core/piiDetection.legacyshield.test.js
 */

const assert = require('assert');
const { test, before, after } = require('node:test');
const http = require('http');

process.env.NODE_ENV = 'test';

function stub(id, exports) {
    const resolved = require.resolve(id);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
    return resolved;
}

// Mutable so each test can present a different store shape.
let ALL_CONFIG = {};

stub('../aiAgent', {
    getAIConfig: async () => ({
        piiDetectionEnabled: true,
        piiDetectionAction: 'tokenize',
        // Deliberately no piiDetectionCategories: we want to observe the
        // "all categories" default, not an AI-config narrowing.
    }),
});
stub('../../stores/configStore', {
    getConfig: async () => null,
    getSecret: async () => '',
    getAllConfig: async () => ALL_CONFIG,
});

// ── A stand-in guard that records what scope it was asked for ──────────
const received = [];
let server;

before(async () => {
    server = http.createServer((req, res) => {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
            try { received.push(JSON.parse(body)); } catch { received.push(null); }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ hasPii: false, entities: [] }));
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    process.env.PII_SERVICE_URL = `http://127.0.0.1:${server.address().port}`;
    delete process.env.PII_SERVICE_API_KEY;
});

after(() => new Promise(resolve => server.close(resolve)));

const { validateInputForPii, ALL_PII_CATEGORY_IDS } = require('./piiDetection');

const ORG_A = {
    enabled: true,
    piiDetectionCategories: ['Email'],
    piiDetectionConfidenceThreshold: 0.95,
};
const ORG_B = {
    enabled: true,
    piiDetectionCategories: ['CreditCardNumber'],
    piiDetectionConfidenceThreshold: 0.15,
};

/** Unique text per test — the in-process LRU keys on the text hash. */
let n = 0;
const msg = () => [{ role: 'user', content: `Scope probe number ${++n} met wat tekst erin` }];

test('two stored shields and no caller-supplied scope → refuses to guess, scans everything', async () => {
    ALL_CONFIG = { org_privacy_shield_A: ORG_A, org_privacy_shield_B: ORG_B };
    received.length = 0;

    await validateInputForPii(msg(), true, null);

    assert.strictEqual(received.length, 1, 'expected exactly one guard call');
    const sent = received[0];

    // The actual bug: org A's single-category scope silently applied to a scan
    // that may belong to org B. Either org's list would be wrong here.
    assert.notDeepStrictEqual(sent.enabled_categories, ORG_A.piiDetectionCategories,
        "adopted org A's categories for an unattributed scan");
    assert.notDeepStrictEqual(sent.enabled_categories, ORG_B.piiDetectionCategories,
        "adopted org B's categories for an unattributed scan");

    assert.strictEqual(sent.enabled_categories.length, ALL_PII_CATEGORY_IDS.length,
        'ambiguous scope must fall back to ALL categories, never a narrowed guess');

    // Same for the threshold — inheriting 0.95 from an unrelated org would
    // suppress almost every detection for short prompts.
    assert.strictEqual(sent.confidence_threshold, 0.7);
});

test('exactly one stored shield → still used (single-tenant self-host is unaffected)', async () => {
    ALL_CONFIG = { org_privacy_shield_A: ORG_A };
    received.length = 0;

    await validateInputForPii(msg(), true, null);

    assert.strictEqual(received.length, 1);
    assert.deepStrictEqual(received[0].enabled_categories, ['Email']);
    assert.strictEqual(received[0].confidence_threshold, 0.95);
});

test('no stored shield → all categories', async () => {
    ALL_CONFIG = {};
    received.length = 0;

    await validateInputForPii(msg(), true, null);

    assert.strictEqual(received.length, 1);
    assert.strictEqual(received[0].enabled_categories.length, ALL_PII_CATEGORY_IDS.length);
});

test('an explicitly passed shield always wins over anything in the store', async () => {
    ALL_CONFIG = { org_privacy_shield_A: ORG_A, org_privacy_shield_B: ORG_B };
    received.length = 0;

    await validateInputForPii(msg(), true, {
        enabled: true,
        piiDetectionCategories: ['PhoneNumber'],
        piiDetectionConfidenceThreshold: 0.42,
    });

    assert.strictEqual(received.length, 1);
    assert.deepStrictEqual(received[0].enabled_categories, ['PhoneNumber']);
    assert.strictEqual(received[0].confidence_threshold, 0.42);
});
