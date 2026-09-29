/**
 * Degraded scoping — fail closed only for categories the caller actually asked for.
 *
 * Background. The guard degrades the WHOLE response when any one label group's
 * inference calls all fail. That was tolerable while the regex tier ran: under
 * GUARD_PII_REGEX_TIER=on the guard runs 4 label groups, and an org scoped to
 * regex-complete categories (Email, PhoneNumber, …) never touched the model at
 * all, so it could never fail closed. Under model-only it runs 7 groups — more
 * chances per request for a transient ORT error — and every one of them can
 * block that org for a category it never asked about.
 *
 * The guard already computed which categories lost coverage and then threw it
 * away into a boolean. It now reports `degraded_categories`, and these tests pin
 * how the Node side must read it:
 *
 *   - degradation that misses the requested scope  → continue with the result
 *   - degradation that hits the requested scope    → fail closed as before
 *   - no degraded_categories at all (older guard)  → fail closed as before
 *   - a degraded result is NEVER cached, including on the new continue path
 *
 * Isolated from the DB: aiAgent + configStore are stubbed in the require cache,
 * and a real local HTTP server plays the guard so the full detectPii path runs.
 *
 * Run: node --test server/core/piiDetection.degradedscope.test.js
 */

const assert = require('assert');
const http = require('http');
const { test, before, after } = require('node:test');

process.env.NODE_ENV = 'test';

function stub(id, exports) {
    const resolved = require.resolve(id);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
    return resolved;
}
stub('../aiAgent', { getAIConfig: async () => ({ piiDetectionEnabled: false, piiDetectionAction: 'block' }) });
stub('../../stores/configStore', {
    getConfig: async () => null,
    getSecret: async () => '',
    getAllConfig: async () => ({}),
});

// What the fake guard returns next, and what it was asked for.
let nextResponse = null;
let requests = [];
let server;

before(async () => {
    server = http.createServer((req, res) => {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
            requests.push(JSON.parse(body || '{}'));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(nextResponse));
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    process.env.PII_SERVICE_URL = `http://127.0.0.1:${server.address().port}`;
    delete process.env.PII_SERVICE_API_KEY;
});

after(() => new Promise(resolve => server.close(resolve)));

const { validateInputForPii, detectPii } = require('./piiDetection');

// Distinct text per test — the LRU cache keys on a sha256 of the input, and a
// shared string would let one test's result answer another's scan.
let n = 0;
const msg = (extra = '') => [{
    role: 'user',
    content: `Beste Mark, mail mij op a${n++}@example.nl ${extra}`,
}];

const SHIELD = {
    enabled: true,
    piiDetectionAction: 'tokenize',
    piiFailureMode: 'fail_closed',
    piiDetectionCategories: ['Email', 'PhoneNumber'],
};

const degradedWith = (categories) => ({
    hasPii: false,
    entities: [],
    degraded: true,
    degraded_reason: 'gliner_group_failed:' + (categories || []).join(','),
    ...(categories ? { degraded_categories: categories } : {}),
    tier_mode: 'off',
});

test('degradation OUTSIDE the requested scope does not block', async () => {
    // The government-id label group died. This org asked for Email+PhoneNumber.
    nextResponse = degradedWith(['PassportNumber', 'NationalIdentificationNumber',
                                 'USSocialSecurityNumber']);
    const result = await validateInputForPii(msg(), true, SHIELD);
    // No PII in the (empty) entity list → nothing to tokenize → null, but
    // crucially NOT a privacyUnavailable throw.
    assert.strictEqual(result, null);
});

test('degradation INSIDE the requested scope still fails closed', async () => {
    nextResponse = degradedWith(['Email', 'URL', 'IPAddress']);
    await assert.rejects(
        () => validateInputForPii(msg(), true, SHIELD),
        (err) => {
            assert.strictEqual(err.privacyUnavailable, true);
            assert.deepStrictEqual(err.degradedCategories, ['Email', 'URL', 'IPAddress']);
            return true;
        },
    );
});

test('an older guard (no degraded_categories) still fails closed — unknown means all', async () => {
    // This is the compatibility guarantee: absent scoping must never be read as
    // "nothing was affected", which would turn a rollback into a silent leak.
    nextResponse = { hasPii: false, entities: [], degraded: true,
                     degraded_reason: 'model_not_ready: loading' };
    await assert.rejects(
        () => validateInputForPii(msg(), true, SHIELD),
        (err) => err.privacyUnavailable === true,
    );
});

test('an EMPTY degraded_categories list means all, not none', async () => {
    // The guard sends [] for a partial scan of oversize input: the unscanned
    // tail can hide any category, so nothing may be exempted.
    nextResponse = { hasPii: false, entities: [], degraded: true,
                     degraded_reason: 'input_too_large_partial',
                     degraded_categories: [] };
    await assert.rejects(
        () => validateInputForPii(msg(), true, SHIELD),
        (err) => err.privacyUnavailable === true,
    );
});

test('an all-categories scope is never exempted by scoping', async () => {
    // No piiDetectionCategories → every category is requested, so any
    // degradation is in scope by definition.
    nextResponse = degradedWith(['PassportNumber']);
    await assert.rejects(
        () => validateInputForPii(msg(), true, { ...SHIELD, piiDetectionCategories: [] }),
        (err) => err.privacyUnavailable === true,
    );
});

test('a degraded result is never cached, including on the continue path', async () => {
    const text = msg('vaste tekst voor de cachetest');
    nextResponse = degradedWith(['PassportNumber']);
    await validateInputForPii(text, true, SHIELD);
    const firstCount = requests.length;

    // Same input again. If the degraded result had been cached, the guard would
    // not be called a second time — and an incomplete entity set would be
    // served for the whole TTL after the model recovered (BFSF-269).
    nextResponse = degradedWith(['PassportNumber']);
    await validateInputForPii(text, true, SHIELD);
    assert.strictEqual(requests.length, firstCount + 1,
        'degraded result was cached — the guard was not re-queried');
});

test('detectPii surfaces degradedCategories to direct callers', async () => {
    nextResponse = degradedWith(['MedicalCondition', 'Medication']);
    const r = await detectPii('Beste Mark, dit is een test met wat tekst', ['MedicalCondition']);
    assert.strictEqual(r.degraded, true);
    assert.deepStrictEqual(r.degradedCategories, ['MedicalCondition', 'Medication']);
});

test('detectPii normalises an absent list to null, not []', async () => {
    nextResponse = { hasPii: false, entities: [], degraded: true, degraded_reason: 'x' };
    const r = await detectPii('Beste Mark, nog een test met wat tekst', ['Email']);
    assert.strictEqual(r.degradedCategories, null);
});
