/**
 * Local CommonJS v2 host mock for the security_scan module tests.
 *
 * Mirrors the SDK's hostApiVersion:2 surface (hub-module-sdk/template/test/hostMock.js)
 * but in CommonJS so the module's `node --test` files (this package is
 * type:commonjs) can require it directly. Inject overrides via opts to assert a
 * module's calls (ai/usage/limits/storage/webpages/net stubs).
 */

'use strict';

const express = require('express');

/** In-memory stand-in for the injected db. Records calls; returns canned data. */
function makeDbMock(seed = {}) {
    const calls = [];
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

// Minimal literal-host private-target check for the net.* stub — mirrors the
// product predicate's intent (block loopback / RFC1918 / non-http(s)) without
// the full numeric canonicalizer. Override via opts.net for exotic cases.
function defaultIsPrivateTarget(rawUrl) {
    let u;
    try { u = new URL(rawUrl); } catch { return true; }
    if (!/^https?:$/.test(u.protocol)) return true;
    const h = u.hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1'
        || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
}

/**
 * @param {object} [opts]
 * @returns {object} a frozen-shaped host mock (not actually frozen so tests can spy)
 */
function makeHostMock(opts = {}) {
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
        moduleId: 'security_scan',
        db: opts.db || makeDbMock(opts.dbSeed),
        express,
        middleware: {
            requireCapability: () => passthrough(),
            requirePermission: () => passthrough(),
        },
        stores: { configStore },

        // ── v2 seams — stubbed so module unit tests can inject/observe them ──
        ai: opts.ai || {
            async resolveModelForTier(ref, _opts) { return typeof ref === 'string' ? ref : (ref?.model || null); },
            async getProviderForModel(_modelId) { return null; },
            getAdapter(_type, _url) { return null; },
        },
        usage: opts.usage || {
            async logUsage(_entry) { return { ok: true }; },
        },
        limits: opts.limits || {
            async checkSubscription(_orgId, _agentType, _userId) { return null; },
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

        log: opts.log || {
            debug: () => {},
            info: () => {},
            warn: () => {},
            error: () => {},
        },
        async isModuleActive(_id) { return active; },
        fetch: (...args) => globalThis.fetch(...args),
    };
}

module.exports = { makeHostMock, makeDbMock, defaultIsPrivateTarget };
