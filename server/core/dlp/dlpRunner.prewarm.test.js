/**
 * preWarmPiiScan — overlapping the DLP guard scan with memory retrieval.
 *
 * The chat path used to pay two strictly sequential guard round trips before
 * the first LLM token: the memory-context scrub, then the DLP scan of the user
 * message. preWarmPiiScan starts the second scan early; the real scan joins it
 * through piiDetection's single-flight table (same cache key), so the pair
 * overlaps instead of queueing.
 *
 * What is pinned here:
 *   * a pre-warmed scan and the real scan share ONE guard request — the
 *     argument derivation in preWarmPiiScan and scan() must not drift apart;
 *   * a guardrail rewrite between pre-warm and scan changes the cache key, so
 *     the pre-warm is DISCARDED (fresh scan of the new text), never misapplied
 *     to text it did not scan;
 *   * pre-warming never runs for shields/providers scan() would skip.
 *
 * Run: node --test server/core/dlp/dlpRunner.prewarm.test.js
 */

const assert = require('assert');
const { test, before, after, beforeEach } = require('node:test');
const http = require('http');

process.env.NODE_ENV = 'test';

function stub(id, exports) {
    const resolved = require.resolve(id);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
    return resolved;
}

stub('../aiAgent', { getAIConfig: async () => ({ piiDetectionEnabled: true }) });
stub('../../stores/configStore', {
    getConfig: async () => null,
    getSecret: async () => '',
    getAllConfig: async () => ({}),
});

let requests = [];
let server;

before(async () => {
    server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', async () => {
            const parsed = JSON.parse(body);
            requests.push(parsed.text);
            // Hold briefly so a pre-warm is still in flight when scan() joins.
            await new Promise(r => setTimeout(r, 30));
            const marker = 'jan@voorbeeld.nl';
            const idx = parsed.text.indexOf(marker);
            const entities = idx === -1 ? [] : [{
                text: marker, category: 'Email', confidence: 0.95,
                offset: idx, length: marker.length, label: 'Email Address',
            }];
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ hasPii: entities.length > 0, entities, degraded: false, degraded_reason: null }));
        });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    process.env.PII_SERVICE_URL = `http://127.0.0.1:${server.address().port}`;
});

after(() => server && server.close());

const pii = require('../privacy/piiDetection');
const dlpRunner = require('./dlpRunner');

const SHIELD = {
    enabled: true,
    dlpEnabled: true,
    dlpScope: 'all',            // provider-independent, so the test needs no external URL
    dlpMode: 'auto_allow',      // resolve without an interactive decision
    piiFailureMode: 'fail_open',
    piiDetectionCategories: ['Email'],
    piiDetectionConfidenceThreshold: 0.7,
};
const PROVIDER = { providerType: 'openai', url: 'https://api.openai.com/v1', displayName: 'OpenAI' };

beforeEach(() => {
    requests = [];
    pii._resetGuardCircuit();
    pii.invalidateGuardEndpointCache();
});

test('the real scan joins a pre-warmed scan — one guard request total', async () => {
    const messages = [{ role: 'user', content: 'mail mij op jan@voorbeeld.nl' }];
    dlpRunner.preWarmPiiScan({ messages, orgShieldConfig: SHIELD, providerConfig: PROVIDER });
    const result = await dlpRunner.scan({
        messages, orgShieldConfig: SHIELD, orgId: 'o1', conversationId: 'c1', providerConfig: PROVIDER,
    });
    assert.strictEqual(requests.length, 1,
        'pre-warm and scan derived different detectPii arguments — the two derivations drifted');
    assert.ok(result.findings.some(f => f.category === 'Email'), 'the joined result must carry the findings');
});

test('a guardrail rewrite discards the pre-warm instead of misapplying it', async () => {
    const messages = [{ role: 'user', content: 'mail mij op jan@voorbeeld.nl' }];
    dlpRunner.preWarmPiiScan({ messages, orgShieldConfig: SHIELD, providerConfig: PROVIDER });
    // Guardrails rewrite the message before the DLP preflight runs.
    messages[0].content = 'volledig andere tekst zonder adres';
    const result = await dlpRunner.scan({
        messages, orgShieldConfig: SHIELD, orgId: 'o1', conversationId: 'c2', providerConfig: PROVIDER,
    });
    assert.strictEqual(requests.length, 2, 'the rewritten text needs its own scan');
    assert.strictEqual(requests[1], 'volledig andere tekst zonder adres',
        'the real scan must cover the text that is actually being sent');
    assert.ok(!result.findings.length, 'findings from the OLD text must not leak onto the new one');
});

test('pre-warming skips everything scan() would skip', async () => {
    // DLP off, shield off, and scope external + internal provider: no request.
    dlpRunner.preWarmPiiScan({
        messages: [{ role: 'user', content: 'mail mij op jan@voorbeeld.nl' }],
        orgShieldConfig: { ...SHIELD, dlpEnabled: false },
        providerConfig: PROVIDER,
    });
    dlpRunner.preWarmPiiScan({
        messages: [{ role: 'user', content: 'mail mij op jan@voorbeeld.nl' }],
        orgShieldConfig: { ...SHIELD, enabled: false },
        providerConfig: PROVIDER,
    });
    dlpRunner.preWarmPiiScan({
        messages: [{ role: 'user', content: 'mail mij op jan@voorbeeld.nl' }],
        orgShieldConfig: { ...SHIELD, dlpScope: 'external' },
        providerConfig: { providerType: 'ollama', url: 'http://localhost:11434', displayName: 'Local' },
    });
    // Give any (incorrect) fire-and-forget call a beat to land.
    await new Promise(r => setTimeout(r, 80));
    assert.strictEqual(requests.length, 0, 'pre-warm scanned something scan() would never scan');
});

test('an oversize message is not pre-warmed (windowed scans are too expensive to risk discarding)', async () => {
    const big = 'x'.repeat(pii.MAX_REQUEST_CHARS + 100);
    dlpRunner.preWarmPiiScan({
        messages: [{ role: 'user', content: big }],
        orgShieldConfig: SHIELD,
        providerConfig: PROVIDER,
    });
    await new Promise(r => setTimeout(r, 80));
    assert.strictEqual(requests.length, 0);
});
