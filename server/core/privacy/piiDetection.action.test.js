/**
 * Action resolution must not depend on cache state, and must not log PII.
 *
 * Three defects pinned here:
 *
 *  1. `piiDetectionAction: 'warn'` is accepted and persisted by
 *     routes/orgPrivacyShield.js:252, but the enforcement path knew only
 *     tokenize/redact/allow and fell through to `// Default: block`. An admin
 *     who chose the softest-sounding option got the strictest behaviour.
 *
 *  2. The cache-HIT branch tested `piiAction === 'tokenize'` while the
 *     cache-MISS branch tested `'tokenize' || 'redact'`. So for a 'redact' org
 *     the same message was masked or hard-blocked purely depending on whether
 *     an identical message was still in the 5-minute LRU. That is a coin flip
 *     wearing a config option.
 *
 *  3. Detected values were written to the server log — up to 20 characters of
 *     every entity, at warn level. The guard itself is careful never to do this
 *     (guard-service/app/routers/pii.py:96-99); the Node side undid it.
 *
 * Run: node --test server/core/piiDetection.action.test.js
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
stub('../aiAgent', {
    getAIConfig: async () => ({ piiDetectionEnabled: true, piiDetectionAction: 'block' }),
});
stub('../../stores/configStore', {
    getConfig: async () => null,
    getSecret: async () => '',
    getAllConfig: async () => ({}),
});

const SECRET = 'mark.devries@voorbeeld.nl';
const ENTITY = {
    text: SECRET,
    category: 'Email',
    label: 'Email Address',
    confidence: 0.91,
    offset: 0,
    length: SECRET.length,
};

let server;
let calls = 0;

before(async () => {
    server = http.createServer((req, res) => {
        req.on('data', () => {});
        req.on('end', () => {
            calls++;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ hasPii: true, entities: [ENTITY] }));
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    process.env.PII_SERVICE_URL = `http://127.0.0.1:${server.address().port}`;
    delete process.env.PII_SERVICE_API_KEY;
});

after(() => new Promise(resolve => server.close(resolve)));

const { validateInputForPii } = require('./piiDetection');

const shield = (action) => ({ enabled: true, piiDetectionAction: action });

for (const action of ['tokenize', 'redact', 'warn']) {
    test(`'${action}' masks on BOTH a cache miss and a cache hit`, async () => {
        // Distinct text per action so each starts from a cold cache entry.
        const messages = [{ role: 'user', content: `Voor ${action}: mail ${SECRET} graag` }];

        const before_ = calls;
        const miss = await validateInputForPii(messages, true, shield(action));
        assert.strictEqual(calls, before_ + 1, 'first call should reach the guard');
        assert.ok(miss && miss.tokenizedText, `${action} must mask on a cache miss`);
        assert.ok(!miss.tokenizedText.includes(SECRET), 'raw value survived masking');

        const hit = await validateInputForPii(messages, true, shield(action));
        assert.strictEqual(calls, before_ + 1, 'second call should be served from cache');
        assert.ok(hit && hit.tokenizedText,
            `${action} masked on a miss but not on a hit — the two branches disagree`);
        assert.deepStrictEqual(hit.tokenizedText, miss.tokenizedText,
            'cache hit and miss must produce the same masked text');
    });
}

test("'block' still blocks, on both paths", async () => {
    const messages = [{ role: 'user', content: `Blokkeer dit: ${SECRET} nu` }];
    for (const pass of ['miss', 'hit']) {
        await assert.rejects(
            () => validateInputForPii(messages, true, shield('block')),
            (err) => {
                assert.match(err.message, /PII Detected/);
                return true;
            },
            `block should throw on the cache ${pass}`,
        );
    }
});

test("'allow' short-circuits before any scan", async () => {
    const before_ = calls;
    const result = await validateInputForPii(
        [{ role: 'user', content: `Sla over: ${SECRET}` }],
        true,
        shield('allow'),
    );
    assert.strictEqual(result, null);
    assert.strictEqual(calls, before_, 'allow must not call the guard at all');
});

test('no detected value is ever written to the log', async () => {
    const seen = [];
    const orig = { log: console.log, warn: console.warn, error: console.error };
    for (const level of ['log', 'warn', 'error']) {
        console[level] = (...args) => { seen.push(args.map(String).join(' ')); };
    }
    try {
        await validateInputForPii(
            [{ role: 'user', content: `Logtest met ${SECRET} erin` }],
            true,
            shield('block'),
        ).catch(() => { /* the block is expected; we are here for the logs */ });
    } finally {
        Object.assign(console, orig);
    }

    const joined = seen.join('\n');
    assert.ok(!joined.includes(SECRET),
        `the detected value appeared in the log:\n${joined}`);
    // Even a prefix is a leak — the old line sliced to 20 chars.
    assert.ok(!joined.includes(SECRET.slice(0, 12)),
        `a truncated prefix of the detected value appeared in the log:\n${joined}`);
    // The diagnostic that line actually carried must survive.
    assert.ok(/Email Address@91%/.test(joined),
        `expected a category+confidence breakdown, got:\n${joined}`);
});
