// @typecheck noImplicitAny
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
const { fallback } = require('../../utils/bestEffort');

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

/** The subset of userStore the routers call, backed by arrays. */
function createMemoryStore() {
    let seq = 0;
    /**
     * @type {{
     *   users: Map<string, Record<string, any>>,
     *   keys: import('../../stores/user/securityKeys').SecurityKey[],
     *   audit: Array<{ action: string, targetId: string, actorId: string, before: unknown, after: unknown }>,
     *   used: Array<{ userId: string, id: string, signCount: number }>,
     * }}
     */
    const state = { users: new Map(), keys: [], audit: [], used: [] };
    return {
        state,
        /** @param {string} id */
        async getUser(id) { return state.users.get(id) || null; },
        /** camelCase updates onto the snake_case row, as stores/user/users.js maps them. */
        /**
         * @param {string} id
         * @param {Record<string, any>} updates
         */
        async updateUser(id, updates) {
            const row = state.users.get(id);
            if (!row) return false;
            /** @type {Record<string, string>} */
            const COLUMNS = {
                mfaEnabled: 'mfa_enabled', mfaSecret: 'mfa_secret', mfaEnrolledAt: 'mfa_enrolled_at',
                mfaRecoveryCodes: 'mfa_recovery_codes', mfaRecoveryCodesGeneratedAt: 'mfa_recovery_codes_generated_at',
            };
            for (const [k, v] of Object.entries(updates)) row[COLUMNS[k] || k] = v;
            return true;
        },
        /** @param {string} userId */
        async listSecurityKeys(userId) { return state.keys.filter((k) => k.userId === userId).map((k) => ({ ...k })); },
        /** @param {Omit<import('../../stores/user/securityKeys').SecurityKey, 'id' | 'createdAt' | 'lastUsedAt'>} key */
        async addSecurityKey(key) {
            if (state.keys.some((k) => k.credentialId === key.credentialId)) {
                throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
            }
            const row = { ...key, id: `key-${++seq}`, createdAt: new Date(0).toISOString(), lastUsedAt: /** @type {string | null} */ (null) };
            state.keys.push(row);
            return { ...row };
        },
        /**
         * @param {string} userId
         * @param {string} id
         * @param {string} name
         */
        async renameSecurityKey(userId, id, name) {
            const row = state.keys.find((k) => k.userId === userId && k.id === id);
            if (row) row.name = name;
            return !!row;
        },
        /**
         * @param {string} userId
         * @param {string} id
         */
        async deleteSecurityKey(userId, id) {
            const before = state.keys.length;
            state.keys = state.keys.filter((k) => !(k.userId === userId && k.id === id));
            return state.keys.length < before;
        },
        /**
         * @param {string} userId
         * @param {string} id
         * @param {number} signCount
         */
        async recordSecurityKeyUse(userId, id, signCount) {
            const row = state.keys.find((k) => k.userId === userId && k.id === id);
            if (row) { row.signCount = signCount; row.lastUsedAt = 'now'; }
            state.used.push({ userId, id, signCount });
            return !!row;
        },
        /**
         * @param {string} action
         * @param {string} targetType
         * @param {string} targetId
         * @param {string} actorId
         * @param {unknown} before
         * @param {unknown} after
         */
        async logAccessAudit(action, targetType, targetId, actorId, before, after) {
            state.audit.push({ action, targetId, actorId, before, after });
        },
    };
}

/**
 * Serve `router` under `mount`. `session` is whatever object the test holds;
 * the test mutates it between requests to play the browser's cookie.
 * `errorHandler` is the production terminal error handler.
 *
 * @param {import('express').Router} router
 * @param {{ mount?: string, session: { current?: Express.Session }, errorHandler: import('express').ErrorRequestHandler }} opts
 */
async function serve(router, { mount = '/', session, errorHandler }) {
    const app = express();
    app.use(express.json());
    app.use((/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ _res, /** @type {import('express').NextFunction} */ next) => {
        req.session = session.current;
        if (req.session && !req.session.save) req.session.save = /** @type {Express.Session['save']} */ ((cb) => cb && cb());
        next();
    });
    app.use(mount, router);
    app.use(errorHandler);
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const { port } = /** @type {import('net').AddressInfo} */ (server.address());

    /**
     * @param {string} method
     * @param {string} path
     * @param {{ body?: unknown, origin?: string }} [opts]
     */
    function request(method, path, /** @type {{body?: any, origin?: string}} */ { body, origin } = {}) {
        const payload = body === undefined ? '' : JSON.stringify(body);
        return new Promise((resolve, reject) => {
            const req = http.request({
                host: '127.0.0.1', port, path, method,
                headers: {
                    ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
                    ...(origin ? { Origin: origin } : {}),
                },
            }, (res) => {
                /** @type {Buffer[]} */
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    const raw = Buffer.concat(chunks).toString('utf8');
                    let parsed = raw;
                    try { parsed = JSON.parse(raw); } catch (err) { fallback('testkit:json-body', err); }
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
