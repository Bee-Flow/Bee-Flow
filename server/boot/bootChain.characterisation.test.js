'use strict';
/**
 * Characterisation of the boot chain that server/index.js wires: the HTTP
 * middleware, the session layers, the static mounts and the process lifecycle.
 *
 * index.js itself cannot be required from a test (it opens a listening socket,
 * a Postgres pool and the schedulers), so its pieces live in boot/ behind
 * injectable seams and this file pins what they did when they were still inline
 * in index.js: the ORDER of the layers (requestId before the security headers,
 * the cookie session before the client tag and the document-crypto session,
 * the bridge before the Microsoft identity recheck), the refuse-to-boot secret
 * checks, the cookie shape, the bridge's failure modes, and the startup and
 * shutdown sequences. A reordering here is a behaviour change, not a refactor.
 *
 * The CORS dispatcher has its own suite (index.errorHandler.test.js).
 *
 * Run: node --test boot/bootChain.characterisation.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const httpMiddleware = require('./httpMiddleware');
const sessionLayers = require('./session');
const staticAssets = require('./staticAssets');
const lifecycle = require('./lifecycle');

/** An app double that records every registration in order. */
function recordingApp() {
    const calls = [];
    return {
        calls,
        use: (...args) => { calls.push(['use', ...args]); },
        disable: (key) => { calls.push(['disable', key]); },
        set: (key, value) => { calls.push(['set', key, value]); },
    };
}

function quietLog() {
    const lines = { info: [], warn: [], error: [] };
    return {
        lines,
        info: (...a) => lines.info.push(a),
        warn: (...a) => lines.warn.push(a),
        error: (...a) => lines.error.push(a),
        debug: () => {},
    };
}

function withEnv(vars, fn) {
    const saved = {};
    for (const k of Object.keys(vars)) {
        saved[k] = process.env[k];
        if (vars[k] === undefined) delete process.env[k];
        else process.env[k] = vars[k];
    }
    try { return fn(); } finally {
        for (const k of Object.keys(saved)) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    }
}

// ── HTTP middleware ─────────────────────────────────────────────────────────

test('requestId is the first layer, then the security headers (helmet, permissions, no etag, API cache-control)', () => {
    const app = recordingApp();
    httpMiddleware.applyRequestIdAndSecurityHeaders(app);
    const { withRequestId } = require('../core/http/requestId');
    assert.equal(app.calls[0][0], 'use');
    assert.equal(app.calls[0][1], withRequestId, 'the request id must be set before anything can log');
    assert.deepEqual(app.calls.slice(1).map(c => c[0]), ['use', 'use', 'disable', 'use']);
    assert.deepEqual(app.calls.find(c => c[0] === 'disable'), ['disable', 'etag']);
});

test('the CORS dispatcher is ONE layer; the Stripe raw parser precedes the JSON parser', () => {
    const app = recordingApp();
    const api = httpMiddleware.applyCors(app, { log: quietLog() });
    assert.equal(app.calls.length, 1);
    assert.equal(typeof app.calls[0][1], 'function');
    assert.equal(typeof api.isAllowedOrigin, 'function');

    const parsers = recordingApp();
    httpMiddleware.applyBodyParsers(parsers);
    assert.equal(parsers.calls.length, 2);
    assert.equal(parsers.calls[0][1], '/api/stripe/webhook', 'the webhook verifies a signature over the RAW body');
    assert.equal(typeof parsers.calls[1][1], 'function', 'then the global JSON parser, pathless');
});

test('the JSON parser keeps the exact raw bytes on req.rawBody for a signed (connector HMAC) request and parses the body', async () => {
    const express = require('express');
    const app = express();
    httpMiddleware.applyBodyParsers(app);
    app.post('/echo', (req, res) => res.json({ raw: req.rawBody, body: req.body }));
    app.post('/api/stripe/webhook', (req, res) => res.json({ isBuffer: Buffer.isBuffer(req.body), raw: req.rawBody ?? null }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        const sent = '{"a":  1}';
        const echo = await (await fetch(`${base}/echo`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-beeflow-sig': '1.abc' }, body: sent })).json();
        assert.deepEqual(echo, { raw: sent, body: { a: 1 } });
        const unsigned = await (await fetch(`${base}/echo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: sent })).json();
        assert.deepEqual(unsigned, { body: { a: 1 } }, 'an unsigned request gets no rawBody copy');
        const hook = await (await fetch(`${base}/api/stripe/webhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: sent })).json();
        assert.deepEqual(hook, { isBuffer: true, raw: null }, 'the webhook path gets a Buffer from express.raw, the JSON parser leaves it alone');
    } finally {
        await new Promise((r) => server.close(r));
    }
});

// ── Session layers ──────────────────────────────────────────────────────────

const SECRET = 's'.repeat(32);
const MASTER = 'm'.repeat(32);

function sessionFakes() {
    const seen = { storeOpts: null, cache: null, sessionOpts: null };
    function FakeStore(opts) { seen.storeOpts = opts; }
    const sessionMw = function sessionMiddleware() {};
    const deps = {
        log: quietLog(),
        connectPgSimple: (sessionLib) => { seen.sessionLib = sessionLib; return FakeStore; },
        db: { pool: { tag: 'pool' }, getRedis: () => 'redis-client' },
        sessionCache: { installRedisCacheWhenReady: (...a) => { seen.cache = a; } },
        sessionSeal: { defaultSealer: () => 'the-sealer' },
        session: (opts) => { seen.sessionOpts = opts; return sessionMw; },
        documentCrypto: { withDocumentEncryptionSession: function withDocumentEncryptionSession() {} },
    };
    return { deps, seen, sessionMw };
}

test('cookie session: pg store, Redis read-through cache, then session → client tag → document-crypto session', () => {
    const { deps, seen, sessionMw } = sessionFakes();
    const app = recordingApp();
    withEnv({ MASTER_ENCRYPTION_KEY: MASTER, SESSION_SECRET: SECRET, COOKIE_NAME: undefined, COOKIE_SECURE: undefined,
        NODE_ENV: 'test', COOKIE_SAMESITE: undefined, COOKIE_DOMAIN: undefined, SESSION_ROLLING: undefined, SESSION_MAX_AGE_DAYS: undefined },
    () => sessionLayers.applyCookieSession(app, deps));

    assert.equal(seen.sessionLib, require('express-session'));
    assert.deepEqual(seen.storeOpts, { pool: { tag: 'pool' }, tableName: 'user_sessions', createTableIfMissing: true, pruneSessionInterval: 900 });
    assert.equal(seen.cache.length, 4);
    assert.equal(seen.cache[0], seen.cache[1], 'the pg store is both the session store and the cache\'s backing store');
    assert.equal(seen.cache[2], 'redis-client');
    assert.deepEqual(seen.cache[3], { sealer: 'the-sealer' }, 'the seal on the session rows goes in with the cache');

    const { withRequestClient } = require('../telemetry/requestClient');
    assert.deepEqual(app.calls.map(c => c[1]), [sessionMw, withRequestClient, deps.documentCrypto.withDocumentEncryptionSession]);

    const o = seen.sessionOpts;
    assert.equal(o.name, 'connect.sid');
    assert.equal(o.secret, SECRET);
    assert.equal(o.resave, false);
    assert.equal(o.saveUninitialized, false);
    assert.equal(o.rolling, false);
    assert.deepEqual(o.cookie, { secure: false, httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000, sameSite: 'lax' });
});

test('cookie session: the cookie follows COOKIE_* and production defaults to secure', () => {
    const run = (env) => {
        const { deps, seen } = sessionFakes();
        withEnv({ MASTER_ENCRYPTION_KEY: MASTER, SESSION_SECRET: SECRET, ...env }, () => sessionLayers.applyCookieSession(recordingApp(), deps));
        return seen.sessionOpts;
    };
    const prod = run({ NODE_ENV: 'production', COOKIE_SECURE: undefined, COOKIE_NAME: 'bf.sid', COOKIE_SAMESITE: 'none', COOKIE_DOMAIN: '.example.com' });
    assert.equal(prod.name, 'bf.sid');
    assert.equal(prod.cookie.secure, true);
    assert.equal(prod.cookie.sameSite, 'none');
    assert.equal(prod.cookie.domain, '.example.com');
    assert.equal(run({ NODE_ENV: 'production', COOKIE_SECURE: 'false', COOKIE_DOMAIN: undefined }).cookie.secure, false);
    assert.equal(run({ NODE_ENV: 'test', COOKIE_SECURE: 'true', COOKIE_DOMAIN: undefined }).cookie.secure, true);
    assert.equal('domain' in run({ NODE_ENV: 'test', COOKIE_SECURE: undefined, COOKIE_DOMAIN: undefined }).cookie, false);
});

test('cookie session refuses to boot without a 32-char MASTER_ENCRYPTION_KEY or SESSION_SECRET, before mounting anything', () => {
    for (const env of [{ MASTER_ENCRYPTION_KEY: undefined, SESSION_SECRET: SECRET }, { MASTER_ENCRYPTION_KEY: 'short', SESSION_SECRET: SECRET }]) {
        const app = recordingApp();
        assert.throws(() => withEnv(env, () => sessionLayers.applyCookieSession(app, sessionFakes().deps)),
            /^Error: MASTER_ENCRYPTION_KEY must be set to a random value of at least 32 characters/);
        assert.equal(app.calls.length, 0);
    }
    for (const env of [{ MASTER_ENCRYPTION_KEY: MASTER, SESSION_SECRET: undefined }, { MASTER_ENCRYPTION_KEY: MASTER, SESSION_SECRET: 'x'.repeat(31) }]) {
        const app = recordingApp();
        assert.throws(() => withEnv(env, () => sessionLayers.applyCookieSession(app, sessionFakes().deps)),
            /^Error: SESSION_SECRET must be set to a random value of at least 32 characters/);
        assert.equal(app.calls.length, 0);
    }
});

function bridgeFakes({ data = null, lookupThrows = false, tierThrows = false } = {}) {
    const seen = { lookups: [], suppressed: 0 };
    const deps = {
        log: quietLog(),
        sessionToken: {
            getSessionToken: async (t) => {
                seen.lookups.push(t);
                if (lookupThrows) throw new Error('redis down');
                return data;
            },
        },
        establishSession: { suppressSessionPersistence: () => { seen.suppressed++; } },
        licenseMiddleware: {
            resolveBestTierForRequest: async () => {
                if (tierThrows) throw new Error('license down');
                return { tier: 'enterprise' };
            },
        },
        microsoftSession: { validateMicrosoftSession: function validateMicrosoftSession() {} },
    };
    return { deps, seen };
}

async function runBridge(deps, headers) {
    const app = recordingApp();
    sessionLayers.applySessionBridge(app, deps);
    assert.equal(app.calls.length, 2, 'the bridge, then the Microsoft identity recheck');
    assert.equal(app.calls[1][1], deps.microsoftSession.validateMicrosoftSession);
    const req = { headers, session: { existing: true } };
    let nexted = 0;
    await app.calls[0][1](req, {}, () => { nexted++; });
    return { req, nexted };
}

test('bridge: no X-Session-Token header → straight through, no lookup', async () => {
    const { deps, seen } = bridgeFakes();
    const { req, nexted } = await runBridge(deps, {});
    assert.equal(nexted, 1);
    assert.deepEqual(seen.lookups, []);
    assert.deepEqual(req.session, { existing: true });
});

test('bridge: a valid token rebuilds the session, suppresses persistence and re-resolves the tier', async () => {
    const { deps, seen } = bridgeFakes({ data: { user: { id: 'u1' }, isAuthenticated: true } });
    const { req, nexted } = await runBridge(deps, { 'x-session-token': 'tok' });
    assert.equal(nexted, 1);
    assert.deepEqual(seen.lookups, ['tok']);
    assert.equal(seen.suppressed, 1);
    assert.deepEqual(req.session, { existing: true, user: { id: 'u1' }, isAuthenticated: true, _bridgeTier: 'enterprise' });
});

test('bridge: an unknown token changes nothing; a failing lookup or tier resolution never blocks the request', async () => {
    {
        const { deps, seen } = bridgeFakes({ data: null });
        const { req, nexted } = await runBridge(deps, { 'x-session-token': 'gone' });
        assert.equal(nexted, 1);
        assert.equal(seen.suppressed, 0);
        assert.deepEqual(req.session, { existing: true });
    }
    {
        const { deps } = bridgeFakes({ lookupThrows: true });
        const { req, nexted } = await runBridge(deps, { 'x-session-token': 'tok' });
        assert.equal(nexted, 1, 'continues anonymous instead of a 500 on every bridged request');
        assert.deepEqual(req.session, { existing: true });
        assert.deepEqual(deps.log.lines.warn, [['[Sessions] Bridge token lookup failed:', 'redis down']]);
    }
    {
        const { deps } = bridgeFakes({ data: { user: { id: 'u1' } }, tierThrows: true });
        const { req, nexted } = await runBridge(deps, { 'x-session-token': 'tok' });
        assert.equal(nexted, 1);
        assert.deepEqual(req.session, { existing: true, user: { id: 'u1' } }, 'no _bridgeTier when the licence cannot be resolved');
    }
});

// ── Static mounts ───────────────────────────────────────────────────────────

test('static mounts outside production: the uploads allow-list gate, the uploads dir, then learn-media', () => {
    const app = recordingApp();
    withEnv({ NODE_ENV: 'test' }, () => staticAssets.mountStaticAssets(app, { log: quietLog() }));
    assert.deepEqual(app.calls.map(c => c[1]), ['/uploads', '/uploads', '/learn-media']);
    assert.equal(app.calls[0][2], require('../middleware/publicUploads').publicUploadsOnly,
        'the allow-list runs BEFORE express.static, or saved-recordings would be served');
    assert.equal(staticAssets.AGENT_HUB_DIST_PATH, path.resolve(__dirname, '../../agent-hub/dist'));
    assert.equal(staticAssets.UPLOADS_DIR, path.join(__dirname, '..', 'data', 'uploads'));

    const spa = recordingApp();
    withEnv({ NODE_ENV: 'test' }, () => staticAssets.mountSpaFallback(spa));
    assert.equal(spa.calls.length, 0, 'the SPA catch-all exists in production only');
});

// ── Lifecycle ───────────────────────────────────────────────────────────────

function fakeProc() {
    const handlers = {};
    const exits = [];
    return { handlers, exits, on: (ev, fn) => { handlers[ev] = fn; }, exit: (code) => { exits.push(code); } };
}

test('process error handlers: a rejection is logged, an uncaught exception is logged and exits 1', () => {
    const proc = fakeProc();
    const log = quietLog();
    lifecycle.installProcessErrorHandlers({ log, proc });
    assert.deepEqual(Object.keys(proc.handlers), ['unhandledRejection', 'uncaughtException']);
    const p = { promise: true };
    proc.handlers.unhandledRejection('why', p);
    assert.deepEqual(log.lines.error[0], ['Unhandled Rejection at:', p, 'reason:', 'why']);
    assert.deepEqual(proc.exits, []);
    const err = new Error('boom');
    proc.handlers.uncaughtException(err);
    assert.deepEqual(log.lines.error[1], ['Uncaught Exception:', err]);
    assert.deepEqual(proc.exits, [1]);
});

function lifecycleFakes({ enabled = false, initFails = false } = {}) {
    const order = [];
    const server = {
        listen: (port, host, cb) => { order.push(`listen:${port}:${host}`); cb(); },
    };
    const app = { use: (fn) => order.push(`app.use:${fn.name}`) };
    const terminalErrorHandler = function terminalErrorHandler() {};
    const deps = {
        createServer: (a) => { order.push(a === app ? 'createServer(app)' : 'createServer(?)'); return server; },
        userStore: { initDB: async () => { order.push('userStore.initDB'); if (initFails) throw new Error('db down'); } },
        authConfigStore: { migrate: async () => { order.push('authConfigStore.migrate'); } },
        webpageRuntimeManager: { startReaper: () => order.push('startReaper'), isEnabled: () => enabled },
        fullTierProxy: { mountFullTierProxy: (a, s) => order.push(`mountFullTierProxy:${a === app}:${s === server}`) },
    };
    return {
        order, server, app, deps, terminalErrorHandler,
        runStartupChecks: () => order.push('runStartupChecks'),
        runStartupTasks: () => order.push('runStartupTasks'),
    };
}

test('startServer: auth schema migrations BEFORE listen, then checks, the reaper and the startup tasks', async () => {
    const f = lifecycleFakes();
    const log = quietLog();
    const proc = fakeProc();
    const { server, started } = lifecycle.startServer({ app: f.app, port: 4321, terminalErrorHandler: f.terminalErrorHandler,
        runStartupChecks: f.runStartupChecks, runStartupTasks: f.runStartupTasks, log, proc, deps: f.deps });
    assert.equal(server, f.server);
    await started;
    assert.deepEqual(f.order, ['createServer(app)', 'userStore.initDB', 'authConfigStore.migrate', 'listen:4321:0.0.0.0',
        'runStartupChecks', 'startReaper', 'runStartupTasks']);
    assert.deepEqual(log.lines.info, [['Server running on http://0.0.0.0:4321']]);
    assert.deepEqual(proc.exits, []);
});

test('startServer with the full-tier runtime on: the proxy mounts, then the terminal handler is re-registered behind it', async () => {
    const f = lifecycleFakes({ enabled: true });
    const { started } = lifecycle.startServer({ app: f.app, port: 1, terminalErrorHandler: f.terminalErrorHandler,
        runStartupChecks: f.runStartupChecks, runStartupTasks: f.runStartupTasks, log: quietLog(), proc: fakeProc(), deps: f.deps });
    await started;
    assert.deepEqual(f.order.slice(4), ['runStartupChecks', 'startReaper', 'mountFullTierProxy:true:true',
        'app.use:terminalErrorHandler', 'runStartupTasks']);
});

test('startServer refuses to start when a startup migration fails: logged, exit 1, never listening', async () => {
    const f = lifecycleFakes({ initFails: true });
    const log = quietLog();
    const proc = fakeProc();
    const { started } = lifecycle.startServer({ app: f.app, port: 1, terminalErrorHandler: f.terminalErrorHandler,
        runStartupChecks: f.runStartupChecks, runStartupTasks: f.runStartupTasks, log, proc, deps: f.deps });
    await started;
    assert.deepEqual(f.order, ['createServer(app)', 'userStore.initDB']);
    assert.deepEqual(log.lines.error, [['[Server] OAuth upgrade failed; refusing startup:', 'db down']]);
    assert.deepEqual(proc.exits, [1]);
});

function shutdownFakes({ drainThrows = false } = {}) {
    const order = [];
    const deps = {
        automationRunner: { stop: async (opts) => { order.push(`automationRunner.stop:${opts.timeoutMs}`); if (drainThrows) throw new Error('stuck'); } },
        usageOpenObservePush: { stop: () => order.push('usageOpenObservePush.stop') },
        opsMetricsPush: { stop: () => { order.push('opsMetricsPush.stop'); throw new Error('ignored'); } },
        chatSignals: { flush: async () => order.push('chatSignals.flush') },
        configStore: { _stopInvalidationListener: () => order.push('configStore._stopInvalidationListener') },
        studioAppDbStore: { closeAll: async () => order.push('studioAppDbStore.closeAll') },
        webpageDbStore: { closeAll: async () => order.push('webpageDbStore.closeAll') },
    };
    return {
        order, deps,
        otel: { shutdown: async () => order.push('otel.shutdown') },
        disconnectRedis: async () => order.push('disconnectRedis'),
    };
}

test('graceful shutdown: drain automations first, stop pushers, flush, close Redis, blob engines, OTEL, exit 0 — once', async () => {
    const f = shutdownFakes();
    const proc = fakeProc();
    const log = quietLog();
    await withEnv({ AUTOMATION_DRAIN_TIMEOUT_MS: undefined }, async () => {
        lifecycle.installGracefulShutdown({ otel: f.otel, disconnectRedis: f.disconnectRedis, log, proc, deps: f.deps });
        assert.deepEqual(Object.keys(proc.handlers), ['SIGTERM', 'SIGINT']);
        await proc.handlers.SIGTERM();
        await proc.handlers.SIGINT();
    });
    assert.deepEqual(f.order, ['automationRunner.stop:25000', 'usageOpenObservePush.stop', 'opsMetricsPush.stop',
        'chatSignals.flush', 'configStore._stopInvalidationListener', 'disconnectRedis',
        'studioAppDbStore.closeAll', 'webpageDbStore.closeAll', 'otel.shutdown']);
    assert.deepEqual(proc.exits, [0], 'a second signal while draining is ignored');
    assert.deepEqual(log.lines.info, [['[Server] SIGTERM received, cleaning up...']]);
});

test('graceful shutdown: AUTOMATION_DRAIN_TIMEOUT_MS bounds the drain, and a failed drain still shuts down', async () => {
    const f = shutdownFakes({ drainThrows: true });
    const proc = fakeProc();
    const log = quietLog();
    await withEnv({ AUTOMATION_DRAIN_TIMEOUT_MS: '5000' }, async () => {
        const shutdown = lifecycle.installGracefulShutdown({ otel: f.otel, disconnectRedis: f.disconnectRedis, log, proc, deps: f.deps });
        await shutdown('SIGINT');
    });
    assert.equal(f.order[0], 'automationRunner.stop:5000');
    assert.equal(f.order.at(-1), 'otel.shutdown');
    assert.deepEqual(log.lines.warn, [['[Server] automation runner drain failed:', 'stuck']]);
    assert.deepEqual(proc.exits, [0]);
});
