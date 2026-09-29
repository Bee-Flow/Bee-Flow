/**
 * Rate-limit regressions for the webpages-preview bridge tiers.
 *
 * Exercises the real express-rate-limit middleware over real HTTP against a
 * minimal mounted route (not the full webpagesPreview.js router, which pulls
 * in live DB/secret-dependent stores at require time) so the per-token
 * keying and 429 behavior are verified end-to-end.
 *
 * Run: node --test routes/webpagesPreviewRateLimits.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const { llmBridgeLimiter, sideEffectBridgeLimiter, integrationBridgeLimiter, previewTokenKey } = require('./webpagesPreviewRateLimits');

// Mounts a limiter behind a fake requirePreviewToken stand-in (sets
// req.previewClaims from a header so each test controls the token identity)
// and returns { url, close }.
function startServer(limiter) {
    const app = express();
    app.use((req, res, next) => {
        const userId = req.headers['x-test-user'];
        const webpageId = req.headers['x-test-webpage'];
        if (userId && webpageId) req.previewClaims = { userId, webpageId };
        next();
    });
    app.get('/probe', limiter, (req, res) => res.json({ ok: true }));
    const server = http.createServer(app);
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({
                url: `http://127.0.0.1:${port}/probe`,
                close: () => new Promise((r) => server.close(r)),
            });
        });
    });
}

test('previewTokenKey keys by userId:webpageId, falls back to "anon"', () => {
    assert.strictEqual(previewTokenKey({ previewClaims: { userId: 'u1', webpageId: 'w1' } }), 'u1:w1');
    assert.strictEqual(previewTokenKey({}), 'anon');
});

test('llmBridgeLimiter returns 429 after the per-token cap, and a different token is unaffected', async () => {
    const { url, close } = await startServer(llmBridgeLimiter);
    try {
        const headers = { 'x-test-user': 'alice', 'x-test-webpage': 'wp1' };
        let lastStatus = 200;
        for (let i = 0; i < 21; i++) {
            const res = await fetch(url, { headers });
            lastStatus = res.status;
        }
        assert.strictEqual(lastStatus, 429, 'the 21st request in the window should be throttled');

        // A different token has its own bucket and is unaffected.
        const otherRes = await fetch(url, { headers: { 'x-test-user': 'bob', 'x-test-webpage': 'wp1' } });
        assert.strictEqual(otherRes.status, 200);
    } finally {
        await close();
    }
});

// ── integrationBridgeLimiter: the tier is picked per tool ────────────────────
// A read-only dashboard page fires several integration reads on every load; on
// the 10/min side-effect tier that made the page unusable after one refresh.
// Reads get the 60/min bucket, writes keep the strict one, unknown tools are
// treated as writes (sideEffectMap is fail-closed).
function startBodyServer(limiter) {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        const userId = req.headers['x-test-user'];
        const webpageId = req.headers['x-test-webpage'];
        if (userId && webpageId) req.previewClaims = { userId, webpageId };
        next();
    });
    app.post('/probe', limiter, (req, res) => res.json({ ok: true }));
    const server = http.createServer(app);
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({
                url: `http://127.0.0.1:${port}/probe`,
                close: () => new Promise((r) => server.close(r)),
            });
        });
    });
}

async function post(url, user, webpage, tool) {
    return fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-user': user, 'x-test-webpage': webpage },
        body: JSON.stringify(tool === undefined ? {} : { tool }),
    });
}

test('integrationBridgeLimiter: read-only tools get the 60/min tier, not the 10/min one', async () => {
    const { url, close } = await startBodyServer(integrationBridgeLimiter);
    try {
        // 11 reads would already be throttled on the side-effect tier.
        let lastStatus = 200;
        for (let i = 0; i < 30; i++) {
            lastStatus = (await post(url, 'dave', 'wp-read', 'vplan_list_cards')).status;
        }
        assert.strictEqual(lastStatus, 200, 'a read-only tool must survive well past 10 requests/min');
    } finally {
        await close();
    }
});

test('integrationBridgeLimiter: side-effecting and unknown tools keep the strict tier', async () => {
    const { url, close } = await startBodyServer(integrationBridgeLimiter);
    try {
        let lastStatus = 200;
        for (let i = 0; i < 11; i++) {
            lastStatus = (await post(url, 'erin', 'wp-write', 'gmail_send_email')).status;
        }
        assert.strictEqual(lastStatus, 429, 'a side-effecting tool is throttled at 10/min');

        // Fail-closed: a tool nobody classified, and a missing tool field, are
        // treated as side-effecting — they share the strict bucket above.
        assert.strictEqual((await post(url, 'erin', 'wp-write', 'totally_made_up_tool')).status, 429);
        assert.strictEqual((await post(url, 'erin', 'wp-write', undefined)).status, 429);
    } finally {
        await close();
    }
});

test('integrationBridgeLimiter: read and write buckets are separate', async () => {
    const { url, close } = await startBodyServer(integrationBridgeLimiter);
    try {
        // Drain the write bucket for this token.
        for (let i = 0; i < 11; i++) await post(url, 'frank', 'wp-mix', 'gmail_send_email');
        assert.strictEqual((await post(url, 'frank', 'wp-mix', 'gmail_send_email')).status, 429);
        // Reads still work — a burst of writes must not spend the read budget.
        assert.strictEqual((await post(url, 'frank', 'wp-mix', 'vplan_whoami')).status, 200);
    } finally {
        await close();
    }
});

test('sideEffectBridgeLimiter has a tighter cap than the LLM tier', async () => {
    const { url, close } = await startServer(sideEffectBridgeLimiter);
    try {
        const headers = { 'x-test-user': 'carol', 'x-test-webpage': 'wp2' };
        let lastStatus = 200;
        for (let i = 0; i < 11; i++) {
            const res = await fetch(url, { headers });
            lastStatus = res.status;
        }
        assert.strictEqual(lastStatus, 429, 'the 11th request in the window should be throttled');
    } finally {
        await close();
    }
});
