/**
 * A tiny HTTP harness for the security-key routers: a real express app with
 * the production body parser and terminal error handler, a session the test
 * owns, and an in-memory stand-in for the userStore functions the routers
 * use. The routers are built by their factories, so nothing here touches the
 * module system.
 *
 * The test passes the error handler in: this file lives under auth/, and a
 * require of core/ from here is an upward edge layering.test.js counts.
 */

const http = require('http');
const express = require('express');

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

/** The subset of userStore the routers call, backed by arrays. */
function createMemoryStore() {
    let seq = 0;
    const state = { users: new Map(), keys: [], audit: [], used: [] };
    return {
        state,
        async getUser(id) { return state.users.get(id) || null; },
        /** camelCase updates onto the snake_case row, as stores/user/users.js maps them. */
        async updateUser(id, updates) {
            const row = state.users.get(id);
            if (!row) return false;
            const COLUMNS = {
                mfaEnabled: 'mfa_enabled', mfaSecret: 'mfa_secret', mfaEnrolledAt: 'mfa_enrolled_at',
                mfaRecoveryCodes: 'mfa_recovery_codes', mfaRecoveryCodesGeneratedAt: 'mfa_recovery_codes_generated_at',
            };
            for (const [k, v] of Object.entries(updates)) row[COLUMNS[k] || k] = v;
            return true;
        },
        async listSecurityKeys(userId) { return state.keys.filter((k) => k.userId === userId).map((k) => ({ ...k })); },
        async addSecurityKey(key) {
            if (state.keys.some((k) => k.credentialId === key.credentialId)) {
                throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
            }
            const row = { ...key, id: `key-${++seq}`, createdAt: new Date(0).toISOString(), lastUsedAt: null };
            state.keys.push(row);
            return { ...row };
        },
        async renameSecurityKey(userId, id, name) {
            const row = state.keys.find((k) => k.userId === userId && k.id === id);
            if (row) row.name = name;
            return !!row;
        },
        async deleteSecurityKey(userId, id) {
            const before = state.keys.length;
            state.keys = state.keys.filter((k) => !(k.userId === userId && k.id === id));
            return state.keys.length < before;
        },
        async recordSecurityKeyUse(userId, id, signCount) {
            const row = state.keys.find((k) => k.userId === userId && k.id === id);
            if (row) { row.signCount = signCount; row.lastUsedAt = 'now'; }
            state.used.push({ userId, id, signCount });
            return !!row;
        },
        async logAccessAudit(action, targetType, targetId, actorId, before, after) {
            state.audit.push({ action, targetId, actorId, before, after });
        },
    };
}

/**
 * Serve `router` under `mount`. `session` is whatever object the test holds;
 * the test mutates it between requests to play the browser's cookie.
 * `errorHandler` is the production terminal error handler.
 */
async function serve(router, { mount = '/', session, errorHandler }) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.session = session.current;
        if (req.session && !req.session.save) req.session.save = (cb) => cb && cb();
        next();
    });
    app.use(mount, router);
    app.use(errorHandler);
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const { port } = /** @type {import('net').AddressInfo} */ (server.address());

    function request(method, path, { body, origin } = {}) {
        const payload = body === undefined ? '' : JSON.stringify(body);
        return new Promise((resolve, reject) => {
            const req = http.request({
                host: '127.0.0.1', port, path, method,
                headers: {
                    ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
                    ...(origin ? { Origin: origin } : {}),
                },
            }, (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    const raw = Buffer.concat(chunks).toString('utf8');
                    let parsed = raw;
                    try { parsed = JSON.parse(raw); } catch (_) { /* keep raw */ }
                    resolve({ status: res.statusCode, body: parsed });
                });
            });
            req.on('error', reject);
            req.end(payload);
        });
    }

    return { request, close: () => new Promise((resolve) => server.close(resolve)) };
}

module.exports = { createMemoryStore, serve, silentLog };
