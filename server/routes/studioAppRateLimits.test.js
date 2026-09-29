/**
 * Rate-limit regressions for the App Studio action-run bridge.
 *
 * Exercises the real perUserRateLimit middleware over real HTTP against a
 * minimal mounted route (not the full studioAppsRun.js router, which pulls in
 * store modules) so the per-(user, app) keying and 429 behavior are verified
 * end-to-end. Mirrors webpagesPreviewRateLimits.test.js.
 *
 * Run: node --test routes/studioAppRateLimits.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const { actionRunLimiter, stepLimiter, actionRunKey, ACTION_RUN_RPM, STEP_RPM } = require('./studioAppRateLimits');

// Mounts the limiter behind a fake requireAuth stand-in (sets req.session.user
// from a header so each test controls the caller identity) and returns
// { url, close }. The :id route param supplies the app half of the key.
function startServer(limiter) {
    const app = express();
    app.use((req, res, next) => {
        const userId = req.headers['x-test-user'];
        if (userId) req.session = { user: { id: userId } };
        next();
    });
    app.post('/probe/:id', limiter, (req, res) => res.json({ ok: true }));
    const server = http.createServer(app);
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({
                url: (appId) => `http://127.0.0.1:${port}/probe/${appId}`,
                close: () => new Promise((r) => server.close(r)),
            });
        });
    });
}

test('actionRunKey keys by userId:appId, with anon/unknown fallbacks', () => {
    assert.strictEqual(actionRunKey({ session: { user: { id: 'u1' } }, params: { id: 'app1' } }), 'u1:app1');
    assert.strictEqual(actionRunKey({ params: { id: 'app1' } }), 'anon:app1');
    assert.strictEqual(actionRunKey({}), 'anon:unknown');
});

test('default cap is the side-effect tier (10/min)', () => {
    assert.strictEqual(ACTION_RUN_RPM, 10);
});

test('the step tier is looser than the run tier (a multi-step sequence must not eat the run budget)', () => {
    assert.strictEqual(STEP_RPM, 60);
    assert.ok(STEP_RPM > ACTION_RUN_RPM, 'step cap sits above the run cap');
});

test('stepLimiter allows STEP_RPM hits then 429s, keyed per-(user, app) like the run limiter', async () => {
    const { url, close } = await startServer(stepLimiter);
    try {
        const headers = { 'x-test-user': 'stepper' };
        let last = null;
        for (let i = 0; i < STEP_RPM; i++) {
            last = await fetch(url('app-s'), { method: 'POST', headers });
            assert.strictEqual(last.status, 200, `hit ${i + 1} within the cap should pass`);
        }
        // One past the cap in the same window is throttled.
        last = await fetch(url('app-s'), { method: 'POST', headers });
        assert.strictEqual(last.status, 429, `hit ${STEP_RPM + 1} should be throttled`);
        assert.ok(parseInt(last.headers.get('retry-after'), 10) >= 1, 'Retry-After header set');

        // Same user, different app → its own bucket (a sequence on another app
        // is unaffected).
        const otherApp = await fetch(url('app-t'), { method: 'POST', headers });
        assert.strictEqual(otherApp.status, 200);
    } finally {
        await close();
    }
});

test('actionRunLimiter returns 429 after the per-(user, app) cap, with Retry-After', async () => {
    const { url, close } = await startServer(actionRunLimiter);
    try {
        const headers = { 'x-test-user': 'alice' };
        let last = null;
        for (let i = 0; i < ACTION_RUN_RPM + 1; i++) {
            last = await fetch(url('app-a'), { method: 'POST', headers });
        }
        assert.strictEqual(last.status, 429, `request ${ACTION_RUN_RPM + 1} in the window should be throttled`);
        assert.ok(parseInt(last.headers.get('retry-after'), 10) >= 1, 'Retry-After header set');

        // The same user on a DIFFERENT app has its own bucket.
        const otherApp = await fetch(url('app-b'), { method: 'POST', headers });
        assert.strictEqual(otherApp.status, 200);

        // A different user on the throttled app is unaffected.
        const otherUser = await fetch(url('app-a'), { method: 'POST', headers: { 'x-test-user': 'bob' } });
        assert.strictEqual(otherUser.status, 200);
    } finally {
        await close();
    }
});

// A per-document loop is one user action, not N of them. Charging model calls
// to the /run bucket meant a nine-drawing order died mid-flight at "limit is 10
// per 60s", after paying for the calls that had already landed.
test('model-call steps get their own bucket, well clear of the run bucket', () => {
    const limits = require('./studioAppRateLimits');
    assert.equal(typeof limits.aiStepLimiter, 'function');
    assert.ok(
        limits.AI_STEP_RPM > limits.ACTION_RUN_RPM,
        'an action looping one model call per document must not be capped at the one-click run rate',
    );
    // Sized for one full order in flight: MAX_FILES_PER_INTAKE (25) documents
    // plus the classification and purchase-order reads around the loop.
    assert.ok(limits.AI_STEP_RPM >= 27, `AI_STEP_RPM ${limits.AI_STEP_RPM} cannot carry a full 25-document intake`);
    // ...but still a real ceiling, not the generic step bucket.
    assert.ok(limits.AI_STEP_RPM < limits.STEP_RPM, 'model calls must stay tighter than plain data steps');
});
