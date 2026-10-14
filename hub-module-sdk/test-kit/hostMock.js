/**
 * Shared fake host for Hub module unit tests: the hostApiVersion:2 surface.
 *
 * Use it to unit-test a module's createModule(host) without the product. Each
 * module keeps a thin `test/hostMock.js` that binds its own defaults (express
 * from its own node_modules, moduleId, what limits.checkSubscription answers,
 * which logger) and re-exports the result:
 *
 *   import express from 'express';
 *   import { createHostMockFactory } from '<sdk>/test-kit/hostMock.js';
 *   export const makeHostMock = createHostMockFactory({ express });
 *
 *   const host = makeHostMock();
 *   const mod = createModule(host);
 *   await mod.stores[0].initDB();
 *   // drive mod.router with supertest, run mod.workers[0].tick(), etc.
 *
 * A CommonJS module requires this ES module directly (Node 22 require(esm)).
 *
 * The real host injects a Postgres-backed db, the product's express, gated
 * middleware, configStore, mailer and an ssrf-guarded fetch. v2 additionally
 * exposes db.getClient/tx, ai.*, usage.logUsage, limits.checkSubscription,
 * storage.getPresignedUrl, webpages.persist and net.isPrivateTarget. This mock
 * keeps the SAME method names/shapes so a module that works here works
 * in-product: inject overrides via opts to assert your module's calls.
 *
 * @typedef {Object} Host
 * @property {{ run:Function, getOne:Function, getAll:Function, exec:Function, getClient:Function, tx:Function }} db
 * @property {Function} express
 * @property {{ requireCapability:Function, requirePermission:Function }} middleware
 * @property {{ configStore:object }} stores
 * @property {{ resolveModelForTier:Function, getProviderForModel:Function, getAdapter:Function }} ai
 * @property {{ logUsage:Function }} usage
 * @property {{ checkSubscription:Function }} limits
 * @property {{ getPresignedUrl:Function }} storage
 * @property {{ persist:Function }} webpages
 * @property {{ isPrivateTarget:Function }} net
 * @property {{ debug:Function, info:Function, warn:Function, error:Function }} log
 * @property {Function} isModuleActive
 * @property {Function} fetch
 * @property {number} hostApiVersion
 */

/** In-memory stand-in for the injected db. Records calls; returns canned data. */
export function makeDbMock(seed = {}) {
    const calls = [];
    // A no-op PoolClient so getClient()/tx() are exercisable without a real pg.
    const fakeClient = {
        async query(sql, params = []) { calls.push({ fn: 'query', sql, params }); return { rows: seed.all ?? [], rowCount: 0 }; },
        release() {},
    };
    return {
        _calls: calls,
        async run(sql, params = []) { calls.push({ fn: 'run', sql, params }); return { rowCount: 1 }; },
        async exec(sql) { calls.push({ fn: 'exec', sql }); return undefined; },
        async getOne(sql, params = []) { calls.push({ fn: 'getOne', sql, params }); return seed.one ?? null; },
        async getAll(sql, params = []) { calls.push({ fn: 'getAll', sql, params }); return seed.all ?? []; },
        async getClient() { calls.push({ fn: 'getClient' }); return fakeClient; },
        async tx(fn) {
            calls.push({ fn: 'tx' });
            await fakeClient.query('BEGIN');
            try {
                const r = await fn(fakeClient);
                await fakeClient.query('COMMIT');
                return r;
            } catch (e) {
                await fakeClient.query('ROLLBACK');
                throw e;
            }
        },
    };
}

const passthrough = () => (req, res, next) => next();

// Minimal literal-host private-target check for the net.* stub: mirrors the
// product predicate's intent (block loopback / RFC1918 / non-http(s)) without
// the full numeric canonicalizer. Override via opts.net for exotic cases.
export function defaultIsPrivateTarget(rawUrl) {
    let u;
    try { u = new URL(rawUrl); } catch { return true; }
    if (!/^https?:$/.test(u.protocol)) return true;
    const h = u.hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1'
        || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
}

/** Logger that forwards to the console. */
export function consoleLog() {
    return {
        debug: (...a) => console.debug(...a),
        info: (...a) => console.log(...a),
        warn: (...a) => console.warn(...a),
        error: (...a) => console.error(...a),
    };
}

/** Logger that swallows everything. */
export function silentLog() {
    return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

/**
 * Bind a module's defaults and get its makeHostMock(opts).
 *
 * @param {object}   defaults
 * @param {Function} defaults.express             the module's own express
 * @param {string}   [defaults.moduleId]          set host.moduleId when given
 * @param {Function} [defaults.subscriptionResult=() => ({ allowed: true })]
 *                   builds what the default limits.checkSubscription resolves to
 * @param {Function} [defaults.log=consoleLog]    builds the default logger
 * @returns {(opts?: object) => Host}
 */
export function createHostMockFactory({
    express,
    moduleId,
    subscriptionResult = () => ({ allowed: true }),
    log = consoleLog,
} = {}) {
    /**
     * @param {object} [opts]
     * @param {boolean} [opts.active=true]  what isModuleActive() resolves to
     * @param {object}  [opts.db]           replace the whole db mock
     * @param {object}  [opts.dbSeed]       { one, all } canned db results
     * @param {object}  [opts.configStore]  override the fake configStore
     * @param {object}  [opts.ai]           override the ai.* stubs
     * @param {object}  [opts.usage]        override the usage.* stubs
     * @param {object}  [opts.limits]       override the limits.* stubs
     * @param {object}  [opts.storage]      override the storage.* stubs
     * @param {object}  [opts.webpages]     override the webpages.* stubs
     * @param {object}  [opts.net]          override the net.* stubs
     * @param {object}  [opts.log]          override the logger
     * @returns {Host} a host mock (not frozen, so tests can spy)
     */
    return function makeHostMock(opts = {}) {
        const active = opts.active !== false;
        const configValues = new Map();
        const secrets = new Map();

        const configStore = opts.configStore || {
            async getConfig(key) { return configValues.has(key) ? configValues.get(key) : null; },
            async setConfig(key, value) { configValues.set(key, value); },
            async getSecret(key) { return secrets.has(key) ? secrets.get(key) : null; },
            async setSecret(key, value) { secrets.set(key, value); },
        };

        let _webpageSeq = 0;

        return {
            hostApiVersion: 2,
            ...(moduleId !== undefined ? { moduleId } : {}),
            db: opts.db || makeDbMock(opts.dbSeed),
            express,
            middleware: {
                // In-product these are the real gates; here they pass through so
                // route logic is testable in isolation.
                requireCapability: () => passthrough(),
                requirePermission: () => passthrough(),
            },
            stores: { configStore },

            // ── v2 seams: stubbed so module unit tests can inject/observe them ──
            ai: opts.ai || {
                async resolveModelForTier(ref, _opts) { return typeof ref === 'string' ? ref : (ref?.model || null); },
                async getProviderForModel(_modelId) { return null; },
                getAdapter(_type, _url) { return null; },
            },
            usage: opts.usage || {
                async logUsage(_entry) { return { ok: true }; },
            },
            limits: opts.limits || {
                async checkSubscription(_orgId, _agentType, _userId) { return subscriptionResult(); },
            },
            storage: opts.storage || {
                async getPresignedUrl(key, _expiresIn) { return `https://example.test/presigned/${encodeURIComponent(key)}`; },
            },
            webpages: opts.webpages || {
                async persist(_page) { return `webpage-mock-${++_webpageSeq}`; },
            },
            net: opts.net || {
                isPrivateTarget: (url) => defaultIsPrivateTarget(url),
            },

            log: opts.log || log(),
            async isModuleActive(_id) { return active; },
            // Real host wraps fetch with an SSRF guard; the mock is plain fetch.
            fetch: (...args) => globalThis.fetch(...args),
        };
    };
}
