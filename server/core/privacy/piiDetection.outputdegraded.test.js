/**
 * The output path must not cache, or silently trust, a degraded scan.
 *
 * validateInputForPii has handled degraded detection since BFSF-269.
 * validateOutputForPii — the channel whose whole job is catching PII in the
 * MODEL's reply — ignored it entirely:
 *
 *   * it called `cacheSet(key, result)` unconditionally, unlike the input path
 *     (:697, which carries a comment explaining exactly why not to). So a guard
 *     outage poisoned the output cache with `{hasPii:false, degraded:true}` and
 *     kept serving that for the full 5-minute TTL AFTER the model recovered —
 *     the same reachable-but-wrong window BFSF-269 was filed about.
 *   * a degraded "clean" was treated as clean, with no log line and no policy.
 *
 * Run: node --test server/core/piiDetection.outputdegraded.test.js
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

// Mutable so a test can flip the global failure mode.
let AI_CONFIG = { piiDetectionEnabled: true };

stub('../aiAgent', { getAIConfig: async () => AI_CONFIG });
stub('../../stores/configStore', {
    getConfig: async () => null,
    getSecret: async () => '',
    getAllConfig: async () => ({}),
});

const LEAK = 'jan.jansen@voorbeeld.nl';

// The guard's behaviour is switched per test: first degraded (model warming),
// then healthy — the exact sequence that used to serve a stale "clean".
let mode = 'degraded';
let calls = 0;
let server;

before(async () => {
    server = http.createServer((req, res) => {
        req.on('data', () => {});
        req.on('end', () => {
            calls++;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            if (mode === 'degraded') {
                res.end(JSON.stringify({
                    hasPii: false,
                    entities: [],
                    degraded: true,
                    degraded_reason: 'model_not_ready:warming',
                }));
            } else {
                res.end(JSON.stringify({
                    hasPii: true,
                    entities: [{
                        text: LEAK, category: 'Email', label: 'Email Address',
                        confidence: 0.93, offset: 0, length: LEAK.length,
                    }],
                }));
            }
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    process.env.PII_SERVICE_URL = `http://127.0.0.1:${server.address().port}`;
    delete process.env.PII_SERVICE_API_KEY;
});

after(() => new Promise(resolve => server.close(resolve)));

const { validateOutputForPii } = require('./piiDetection');

test('a degraded output scan is never cached — recovery is not delayed by the TTL', async () => {
    AI_CONFIG = { piiDetectionEnabled: true };
    const reply = `Zijn adres is ${LEAK} volgens het dossier`;

    // 1. Guard degraded: allowed through (fail-open default), but must NOT be
    //    remembered as a clean verdict.
    mode = 'degraded';
    const before_ = calls;
    await validateOutputForPii(reply);
    assert.strictEqual(calls, before_ + 1);

    // 2. Guard recovers. If the degraded result had been cached, this identical
    //    reply would be served from the LRU and the leak would pass unnoticed
    //    for the rest of the 5-minute TTL.
    mode = 'healthy';
    await assert.rejects(
        () => validateOutputForPii(reply),
        (err) => {
            assert.match(err.message, /PII Detected/);
            return true;
        },
        'the degraded verdict was cached and served after recovery',
    );
    assert.strictEqual(calls, before_ + 2, 'second call must reach the guard, not the cache');
});

test('a healthy result IS still cached (the fix must not disable caching)', async () => {
    AI_CONFIG = { piiDetectionEnabled: true };
    mode = 'healthy';
    const reply = `Een andere zin met ${LEAK} erin`;

    const before_ = calls;
    await assert.rejects(() => validateOutputForPii(reply));
    assert.strictEqual(calls, before_ + 1);

    await assert.rejects(() => validateOutputForPii(reply));
    assert.strictEqual(calls, before_ + 1, 'identical clean-path input should hit the cache');
});

test('degradation is reported, not swallowed', async () => {
    AI_CONFIG = { piiDetectionEnabled: true };
    mode = 'degraded';
    const seen = [];
    const origWarn = console.warn;
    console.warn = (...a) => { seen.push(a.map(String).join(' ')); };
    try {
        await validateOutputForPii(`Weer een andere zin, nummer ${Date.now()}`);
    } finally {
        console.warn = origWarn;
    }
    const joined = seen.join('\n');
    assert.match(joined, /DEGRADED/, 'a degraded output scan must say so');
    assert.match(joined, /model_not_ready:warming/, 'the reason must be reported');
});

test('fail_closed suppresses the reply instead of trusting a degraded scan', async () => {
    AI_CONFIG = { piiDetectionEnabled: true, piiFailureMode: 'fail_closed' };
    mode = 'degraded';
    await assert.rejects(
        () => validateOutputForPii(`Fail-closed proef ${Date.now()}`),
        (err) => {
            assert.strictEqual(err.privacyUnavailable, true);
            assert.ok(!/PII Detected/.test(err.message),
                'should be the unavailable block, not the PII block');
            return true;
        },
    );
});

test('fail_open (the default) stays the default — availability is unchanged', async () => {
    AI_CONFIG = { piiDetectionEnabled: true };   // no piiFailureMode
    mode = 'degraded';
    await assert.doesNotReject(
        () => validateOutputForPii(`Fail-open proef ${Date.now()}`),
        'unset failure mode must preserve the pre-existing fail-open behaviour',
    );
});
