/**
 * SSRF rejection — based on server/routes/securityScans.ssrf.test.js.
 *
 * In the built-in the predicate lives in utils/isPrivateTarget; in the module it
 * is the HOST's `net.isPrivateTarget`. So this test verifies the module's
 * WIRING: the worker's isPrivateTarget delegates to host.net.isPrivateTarget and
 * blocks internal-network targets while allowing public ones, and POST /scans
 * rejects a private target with 400 unsafe_target. The hostMock predicate
 * mirrors the product's literal-host intent (loopback / RFC1918 / non-http(s));
 * the exhaustive numeric canonicalizer is the real host's job.
 */

const test = require('node:test');
const assert = require('node:assert');

const { makeWorker } = require('../server/src/worker');
const scanRunnerSvc = require('../server/src/scanRunner.service');
const { mountSecurityRoutes } = require('../server/src/routes');
const { makeHostMock } = require('./hostMock');
const { serve } = require('./httpHarness');

function buildWorker(host) {
    const store = {};
    const driver = { runAgentScan: async () => ({ status: 'completed' }) };
    return makeWorker({ store, scanRunner: scanRunnerSvc, driver, host });
}

// Representative subset of the built-in blocklist table the hostMock predicate
// reliably covers. [url, expected_block]
const TABLE = [
    ['http://localhost', true],
    ['http://127.0.0.1:3000', true],
    ['http://192.168.1.42', true],
    ['http://10.1.1.1', true],
    ['http://172.20.0.1', true],
    // NB: http://[::1] and numeric-obfuscated IPs (169.254.169.254, decimal/hex
    // forms) are caught by the real host's numeric canonicalizer, NOT by the
    // simplified hostMock predicate — see the product isPrivateTarget tests.
    ['file:///etc/passwd', true],
    ['javascript:alert(1)', true],
    ['https://example.com', false],
    ['https://172.32.0.1', false],   // outside the 172.16-31 private block
    ['http://1.2.3.4', false],
];

test('worker.isPrivateTarget delegates to host.net.isPrivateTarget and blocks internal targets', () => {
    const host = makeHostMock();
    const worker = buildWorker(host);
    for (const [url, expected] of TABLE) {
        assert.strictEqual(worker.isPrivateTarget(url), expected, `SSRF check for ${url}: expected ${expected}`);
    }
});

test('worker.isPrivateTarget forwards the exact url to the host seam', () => {
    const seen = [];
    const host = makeHostMock({ net: { isPrivateTarget: (u) => { seen.push(u); return u.includes('blocked'); } } });
    const worker = buildWorker(host);
    assert.strictEqual(worker.isPrivateTarget('https://blocked.example'), true);
    assert.strictEqual(worker.isPrivateTarget('https://ok.example'), false);
    assert.deepStrictEqual(seen, ['https://blocked.example', 'https://ok.example']);
});

test('POST /scans rejects an unsafe (private) target with 400 unsafe_target', async () => {
    const host = makeHostMock();
    let createCalled = false;
    const store = { createScan: async () => { createCalled = true; return 'nope'; } };
    const worker = buildWorker(host);
    const router = host.express.Router();
    mountSecurityRoutes(router, { store, scanRunnerSvc, worker, host });

    const { base, close } = await serve(router, { session: { user: { id: 'u1' } } });
    try {
        const res = await fetch(`${base}/scans`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ targetUrl: 'http://127.0.0.1', authorized: true }),
        });
        assert.strictEqual(res.status, 400);
        const body = await res.json();
        assert.strictEqual(body.error, 'unsafe_target');
        assert.strictEqual(createCalled, false, 'createScan must never run for a blocked target');
    } finally {
        await close();
    }
});

test('POST /scans requires authentication (401 without a session user)', async () => {
    const host = makeHostMock();
    const worker = buildWorker(host);
    const router = host.express.Router();
    mountSecurityRoutes(router, { store: {}, scanRunnerSvc, worker, host });

    const { base, close } = await serve(router, { session: {} });
    try {
        const res = await fetch(`${base}/scans`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ targetUrl: 'https://example.com', authorized: true }),
        });
        assert.strictEqual(res.status, 401);
    } finally {
        await close();
    }
});
