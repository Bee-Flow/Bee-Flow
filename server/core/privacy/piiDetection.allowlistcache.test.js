'use strict';

/**
 * The never-redact allowlist must be applied on BOTH the cache-hit and the
 * cache-miss path of validateInputForPii.
 *
 * The cache deliberately stores the detector's honest, unfiltered answer so two
 * orgs sharing an entry cannot inherit each other's policy. That is only sound
 * if the reading org's allowlist is applied on the way OUT — and the cache-HIT
 * branch used to skip it entirely. So an org with `piiAllowTerms: ['Acme BV']`
 * saw "Please invoice Acme BV" go through on the first send and get hard-blocked
 * on an identical send seconds later, purely on LRU state. Same coin flip with
 * action 'tokenize' (not tokenised, then tokenised), and it also hit orgs that
 * configured nothing at all, because the shipped public-organisation list is on
 * by default.
 *
 * Run: node --test server/core/privacy/piiDetection.allowlistcache.test.js
 */

const assert = require('assert');
const { test, before, after } = require('node:test');
const http = require('http');

process.env.NODE_ENV = 'test';

function stub(id, exports) {
    const resolved = require.resolve(id);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}
stub('../aiAgent', {
    getAIConfig: async () => ({ piiDetectionEnabled: true, piiDetectionAction: 'block' }),
});
stub('../../stores/configStore', {
    getConfig: async () => null,
    getSecret: async () => '',
    getAllConfig: async () => ({}),
});

let server;
let calls = 0;
/** Spans the fake guard reports for the next request. */
let nextEntities = [];

before(async () => {
    server = http.createServer((req, res) => {
        req.on('data', () => {});
        req.on('end', () => {
            calls++;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ hasPii: nextEntities.length > 0, entities: nextEntities }));
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    process.env.PII_SERVICE_URL = `http://127.0.0.1:${server.address().port}`;
    delete process.env.PII_SERVICE_API_KEY;
});

after(() => new Promise(resolve => server.close(resolve)));

const { validateInputForPii } = require('./piiDetection');

function orgSpan(text, inText, category = 'Organization', label = 'Organization') {
    return {
        text: inText, category, label, confidence: 0.93,
        offset: text.indexOf(inText), length: inText.length,
    };
}

/** Run validateInputForPii, reporting throw-vs-return instead of propagating. */
async function attempt(messages, shield) {
    try {
        return { outcome: 'allowed', value: await validateInputForPii(messages, true, shield) };
    } catch (err) {
        return { outcome: 'blocked', message: err.message };
    }
}

test("an org allow-term is honoured on the cache HIT too ('block')", async () => {
    const text = 'Please invoice Acme BV for the migration';
    nextEntities = [orgSpan(text, 'Acme BV')];
    const shield = { enabled: true, piiDetectionAction: 'block', piiAllowTerms: ['Acme BV'] };
    const messages = [{ role: 'user', content: text }];

    const before_ = calls;
    const miss = await attempt(messages, shield);
    assert.strictEqual(calls, before_ + 1, 'first send must reach the guard');
    assert.strictEqual(miss.outcome, 'allowed', 'allowlisted span must not block on a miss');

    const hit = await attempt(messages, shield);
    assert.strictEqual(calls, before_ + 1, 'second send must be served from the cache');
    assert.strictEqual(hit.outcome, 'allowed',
        `allowed on a cache miss but ${hit.outcome} on a cache hit — the allowlist is dropped on the hit path (${hit.message})`);
});

test("an org allow-term is honoured on the cache HIT too ('tokenize')", async () => {
    const text = 'Stuur de offerte naar Acme BV zoals besproken';
    nextEntities = [orgSpan(text, 'Acme BV')];
    const shield = { enabled: true, piiDetectionAction: 'tokenize', piiAllowTerms: ['Acme BV'] };
    const messages = [{ role: 'user', content: text }];

    const miss = await validateInputForPii(messages, true, shield);
    assert.strictEqual(miss, null, 'nothing left to mask once the only span is allowlisted');
    const hit = await validateInputForPii(messages, true, shield);
    assert.strictEqual(hit, null,
        'cache hit tokenised a span the fresh path let through — enforcement decided by the LRU');
});

test('the shipped public-organisation list survives a cache hit (no config at all)', async () => {
    // piiAllowPublicOrgs defaults ON, so an org that configured nothing is
    // affected by this bug too.
    const text = 'We migrate the tenant to Microsoft next quarter';
    nextEntities = [orgSpan(text, 'Microsoft')];
    const shield = { enabled: true, piiDetectionAction: 'block' };
    const messages = [{ role: 'user', content: text }];

    assert.strictEqual((await attempt(messages, shield)).outcome, 'allowed');
    assert.strictEqual((await attempt(messages, shield)).outcome, 'allowed',
        'a public organisation was blocked on the cache hit');
});

test('a NON-allowlisted span still blocks on both paths', async () => {
    // The fix must not turn into "the cache-hit path stopped enforcing".
    const text = 'Klant is Obscure Regio Advies BV, graag opvolgen';
    nextEntities = [orgSpan(text, 'Obscure Regio Advies BV')];
    const shield = { enabled: true, piiDetectionAction: 'block', piiAllowTerms: ['Acme BV'] };
    const messages = [{ role: 'user', content: text }];

    const miss = await attempt(messages, shield);
    assert.strictEqual(miss.outcome, 'blocked', 'a non-allowlisted org must block');
    const hit = await attempt(messages, shield);
    assert.strictEqual(hit.outcome, 'blocked', 'a non-allowlisted org must block on the cache hit too');
    assert.strictEqual(hit.message, miss.message, 'both paths must produce the same error');
});

test('only the allowlisted span is dropped; the rest still enforces on a hit', async () => {
    const text = 'Acme BV factureren, contact mark.devries@voorbeeld.nl';
    nextEntities = [
        orgSpan(text, 'Acme BV'),
        orgSpan(text, 'mark.devries@voorbeeld.nl', 'Email', 'Email Address'),
    ];
    const shield = { enabled: true, piiDetectionAction: 'tokenize', piiAllowTerms: ['Acme BV'] };
    const messages = [{ role: 'user', content: text }];

    const miss = await validateInputForPii(messages, true, shield);
    const hit = await validateInputForPii(messages, true, shield);
    for (const [name, r] of [['miss', miss], ['hit', hit]]) {
        assert.ok(r && r.tokenizedText, `${name}: the email must still be masked`);
        assert.ok(!r.tokenizedText.includes('mark.devries@voorbeeld.nl'), `${name}: raw email survived`);
        assert.ok(r.tokenizedText.includes('Acme BV'), `${name}: allowlisted org must stay in the clear`);
        assert.strictEqual(r.entities.length, 1, `${name}: only the email should remain a finding`);
    }
    assert.strictEqual(hit.tokenizedText, miss.tokenizedText,
        'cache hit and miss must produce the same masked text');
});
