/**
 * Rate limiting on the PUBLIC automation trigger endpoints (WS5.1).
 *
 * Exercises the real Express router + the real perUserRateLimit middleware
 * with stubbed req/res objects — no HTTP listener, no DB (store/config/auth
 * modules are stubbed via the require-cache trick, same as tests.ssrf.test.js).
 * body-parser 2.x skips stream reads when there's no content-length /
 * transfer-encoding header, so plain-object requests flow through the full
 * middleware chain.
 *
 * Run: cd server && node routes/automation.ratelimit.test.js
 */

const assert = require('assert');

// Env knobs must be set before the router module is loaded — the limits are
// read into module constants. Small values keep the flood loops cheap.
process.env.AUTOMATION_WEBHOOK_RPM_PER_SLUG = '3';
process.env.AUTOMATION_WEBHOOK_RPM_PER_IP = '5';
process.env.AUTOMATION_EVENTS_RPM_PER_IP = '4';

// ── Stub every module-level dependency of routes/automation.js ────────────
function stub(path, exports) {
    const filename = require.resolve(path);
    // loaded:true avoids Node's bogus "circular dependency" access warnings.
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

stub('../stores/automationStore', {
    getWebhook: async () => null, // → handler answers 404 "Unknown webhook"
});
stub('../stores/configStore', {
    getConfig: async () => null, // → /events/github answers 503 "not configured"
    getSecret: async () => null,
});
stub('../automation/cron', {});
stub('../automation/validate', {});
stub('../automation/summarise', {});
stub('../automation/deliverableEvents', {});
stub('../automation/toolRegistry', {});
stub('../automation/sideEffectMap', {});
stub('../automation/outputSchemas', {});
stub('../automation/triggerBus', { dispatchEvent: async () => {} });
stub('../core/integrations/integrationToolMap', {});
stub('../core/entitlements/betaFeatures', {
    requireBetaFeature: () => (req, res, next) => next(),
    userHasBetaFeature: async () => false,
});
stub('../auth', { requireActiveOrgForMutations: () => (req, res, next) => next() });
// automation/approvals.js builds its Enterprise `approvals` gate at module
// load, which would otherwise build the whole capability registry here (and
// read the stubbed betaFeatures above). These tests are about the PUBLIC
// trigger endpoints, which sit above it in the chain and never reach it.
stub('../core/entitlements/entitlements', {
    requireCapability: () => (req, res, next) => next(),
});

const router = require('./automation');

/**
 * Find a route layer by (method, path). routes/automation.js is a FACADE that
 * mounts sub-routers (§WS5 #4), so the routes are one level down — this used to
 * look only at `router.stack` and silently stopped finding anything after the
 * split.
 */
function findRouteLayer(stack, method, routePath) {
    for (const layer of stack) {
        if (layer.route?.path === routePath && layer.route.methods[method]) return layer;
        if (layer.name === 'router' && layer.handle?.stack) {
            const hit = findRouteLayer(layer.handle.stack, method, routePath);
            if (hit) return hit;
        }
    }
    return null;
}

// ── Tiny dispatch harness ──────────────────────────────────────────────────
function dispatch({ method = 'POST', url, ip = '203.0.113.1', query = {} }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, ip, query,
            headers: {},
            get(name) { return this.headers[String(name).toLowerCase()]; },
        };
        const res = {
            statusCode: 200,
            headers: {},
            body: undefined,
            set(k, v) { this.headers[String(k).toLowerCase()] = v; return this; },
            setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
            getHeader(k) { return this.headers[String(k).toLowerCase()]; },
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            end() { resolve(this); return this; },
        };
        router(req, res, (err) => reject(err || new Error(`fell through router: ${method} ${url}`)));
    });
}

(async () => {
    // 1. Middleware registration order on /webhook/:slug:
    //    [ipLimiter, slugLimiter, jsonParser, handler] — limiters before the
    //    body parser so floods don't pay JSON-parse cost.
    const webhookLayer = findRouteLayer(router.stack, 'post', '/webhook/:slug');
    assert.ok(webhookLayer, 'POST /webhook/:slug route registered');
    const whNames = webhookLayer.route.stack.map(l => l.name);
    assert.strictEqual(whNames[0], 'rateLimitMiddleware', `webhook stack[0] is a limiter (got ${whNames[0]})`);
    assert.strictEqual(whNames[1], 'rateLimitMiddleware', `webhook stack[1] is a limiter (got ${whNames[1]})`);
    assert.strictEqual(whNames[2], 'jsonParser', `webhook stack[2] is jsonParser (got ${whNames[2]})`);
    for (const path of ['/events/gmail', '/events/nextcloud', '/events/msgraph', '/events/github']) {
        const layer = findRouteLayer(router.stack, 'post', path);
        assert.ok(layer, `POST ${path} route registered`);
        const names = layer.route.stack.map(l => l.name);
        assert.strictEqual(names[0], 'rateLimitMiddleware', `${path} stack[0] is the events limiter (got ${names[0]})`);
        assert.ok(!names.slice(0, 1).includes('jsonParser'), `${path} limiter precedes body parsing`);
    }

    // 1b. The hosted form surface (`kind: 'form'`) is public too, so every one
    //     of its endpoints must sit behind BOTH limiter buckets before it does
    //     any work — an anonymous URL is the easiest thing on the server to
    //     flood. The upload route's second bucket is the per-token+IP one.
    for (const [method, path] of [
        ['get', '/form/:token'], ['post', '/form/:token'], ['post', '/form/:token/upload'],
        // Multi-page: the poll is deliberately chatty, so its own bucket is
        // wide — but it is still an anonymous endpoint behind two buckets.
        ['get', '/form/:token/s/:sid'], ['post', '/form/:token/s/:sid'],
    ]) {
        const layer = findRouteLayer(router.stack, method, path);
        assert.ok(layer, `${method.toUpperCase()} ${path} route registered`);
        const names = layer.route.stack.map(l => l.name);
        assert.strictEqual(names[0], 'rateLimitMiddleware', `${path} stack[0] is a limiter (got ${names[0]})`);
        assert.strictEqual(names[1], 'rateLimitMiddleware', `${path} stack[1] is a limiter (got ${names[1]})`);
    }

    // 2. Per-slug limit (3/min): distinct IPs so the IP limiter can't fire.
    for (let i = 0; i < 3; i++) {
        const r = await dispatch({ url: '/webhook/slug-a', ip: `198.51.100.${i}` });
        assert.strictEqual(r.statusCode, 404, `under slug limit, request ${i + 1} reaches the handler`);
        assert.strictEqual(r.body.error, 'Unknown webhook');
    }
    const slugBlocked = await dispatch({ url: '/webhook/slug-a', ip: '198.51.100.99' });
    assert.strictEqual(slugBlocked.statusCode, 429, '4th hit on the same slug is rate limited');
    assert.match(slugBlocked.body.error, /limit is 3 per 60s/);
    assert.ok(parseInt(slugBlocked.headers['retry-after'], 10) >= 1, 'Retry-After header set');
    // Other slugs from a fresh IP are unaffected (slug-keyed bucket).
    const otherSlug = await dispatch({ url: '/webhook/slug-b', ip: '198.51.100.100' });
    assert.strictEqual(otherSlug.statusCode, 404, 'different slug not affected by slug-a bucket');

    // 3. Per-IP limit (5/min) + ordering: hammer ONE slug from ONE IP.
    //    Requests 1-3 pass both limiters; 4-5 pass the IP limiter (which runs
    //    first and still counts them) but 429 on the slug limiter; request 6
    //    must be rejected by the IP limiter — proving ipLimiter runs first.
    const ip = '192.0.2.50';
    for (let i = 0; i < 3; i++) {
        const r = await dispatch({ url: '/webhook/slug-c', ip });
        assert.strictEqual(r.statusCode, 404);
    }
    for (let i = 0; i < 2; i++) {
        const r = await dispatch({ url: '/webhook/slug-c', ip });
        assert.strictEqual(r.statusCode, 429);
        assert.match(r.body.error, /limit is 3 per 60s/, 'requests 4-5 blocked by the slug limiter');
    }
    const ipBlocked = await dispatch({ url: '/webhook/slug-c', ip });
    assert.strictEqual(ipBlocked.statusCode, 429);
    assert.match(ipBlocked.body.error, /limit is 5 per 60s/, 'request 6 blocked by the IP limiter (runs first)');

    // 4. Events limiter (4/min/IP) is shared across all /events/* endpoints
    //    and the handlers behind it still work.
    const evIp = '192.0.2.77';
    const gmail = await dispatch({ url: '/events/gmail', ip: evIp });
    assert.strictEqual(gmail.statusCode, 204, 'gmail push without data acks 204');
    const msgraph = await dispatch({ url: '/events/msgraph?validationToken=tok123', ip: evIp, query: { validationToken: 'tok123' } });
    assert.strictEqual(msgraph.statusCode, 200, 'msgraph validation handshake answers 200');
    assert.strictEqual(msgraph.body, 'tok123', 'msgraph handshake echoes the token');
    const github = await dispatch({ url: '/events/github', ip: evIp });
    assert.strictEqual(github.statusCode, 503, 'github without configured secret answers 503');
    const nextcloud = await dispatch({ url: '/events/nextcloud', ip: evIp });
    assert.strictEqual(nextcloud.statusCode, 401, 'nextcloud without connector signature answers 401');
    const evBlocked = await dispatch({ url: '/events/gmail', ip: evIp });
    assert.strictEqual(evBlocked.statusCode, 429, '5th /events/* hit from the same IP is rate limited');
    assert.match(evBlocked.body.error, /limit is 4 per 60s/);
    assert.ok(parseInt(evBlocked.headers['retry-after'], 10) >= 1, 'Retry-After header set on events 429');
    // A different IP has its own bucket — providers on other source IPs keep working.
    const evOtherIp = await dispatch({ url: '/events/gmail', ip: '192.0.2.78' });
    assert.strictEqual(evOtherIp.statusCode, 204, 'different IP unaffected');

    console.log('✓ server/routes/automation.ratelimit.test.js — all assertions passed');
})().catch((e) => {
    console.error('✗ automation.ratelimit.test.js failed:', e);
    process.exit(1);
});
