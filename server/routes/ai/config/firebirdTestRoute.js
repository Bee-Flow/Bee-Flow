// @typecheck strict
/**
 * POST /ai/firebird/test — can Bee Flow attach to the database with these
 * values? Accepts the unsaved values of the settings form; anything left out
 * falls back to the stored secret. Answers { ok, server_version, table_count }
 * or { ok: false, error }. The password is never echoed: the driver's error text
 * is scrubbed of it before it leaves.
 *
 * Mounted by routes/ai/config/integrations.js. The collaborators are parameters
 * (a test passes fakes), defaulting to the real ones on first use.
 */
const express = require('express');
const { HttpError } = require('../../../core/http/errors');
const { validate } = require('../../../core/http/validate');
const { lazyGate } = require('../../../auth/gateMeta');
const { bodyOf } = require('../../../core/http/schemaParts');
const { firebirdFields } = require('./firebirdFields');

const FirebirdTestBody = bodyOf(Object.fromEntries(Object.entries(firebirdFields).map(([k, v]) => [k, v.optional()])));
const FIREBIRD_TEST_TIMEOUT_MS = 10000;
const FIREBIRD_NOT_CONFIGURED = 'Firebird database not configured. Add the server, database and account in Settings → Connections.';

/**
 * @typedef {{ host: string, port: string, database: string, user: string, password: string, charset: string }} TestCreds
 * @typedef {{ ok?: boolean, error?: string, server_version?: string, table_count?: number }} TestOutcome
 * @typedef {{
 *   getSecret?: (key: string) => Promise<string | null | undefined>,
 *   testConnection?: (creds: TestCreds) => Promise<TestOutcome>,
 *   requireAuth?: import('express').RequestHandler,
 * }} FirebirdTestDeps
 */

/**
 * @param {import('express').Request<{}, unknown, import('zod').infer<typeof FirebirdTestBody>, import('qs').ParsedQs>} req
 * @param {(key: string) => Promise<string | null | undefined>} getSecret
 * @returns {Promise<TestCreds>}
 */
async function credsFor(req, getSecret) {
    const userId = req.session?.user?.id;
    if (!userId) throw new HttpError(401, 'unauthenticated', 'Not authenticated');
    const body = req.body || {};
    /** @param {string} field @param {string | number | null | undefined} typed */
    const pick = async (field, typed) => (typed ? String(typed) : '') || (await getSecret(`firebird_${field}_user_${userId}`)) || '';
    return {
        host: await pick('host', body.firebirdHost),
        port: await pick('port', body.firebirdPort),
        database: await pick('database', body.firebirdDatabase),
        user: await pick('user', body.firebirdUser),
        password: await pick('password', body.firebirdPassword),
        charset: await pick('charset', body.firebirdCharset),
    };
}

/**
 * @param {FirebirdTestDeps} [deps]
 * @returns {import('express').Router}
 */
function createFirebirdTestRouter(deps = {}) {
    const router = express.Router();
    /** @type {import('express').RequestHandler} */
    // lazyGate keeps the deferred require and tags the mount as the session gate it is.
    const auth = deps.requireAuth || lazyGate(() => require('../../../auth/permissions').requireAuth, { axis: 'auth' });
    const getSecret = deps.getSecret || ((/** @type {string} */ key) => require('../../../stores/configStore').getSecret(key));
    const testConnection = deps.testConnection || ((/** @type {TestCreds} */ creds) => require('../../../integrations/firebirdTools').testFirebirdConnection(creds));

    router.post('/firebird/test', auth, validate({ body: FirebirdTestBody }), /** @param {import('express').Request<{}, unknown, import('zod').infer<typeof FirebirdTestBody>, import('qs').ParsedQs>} req */ async (req, res) => {
        const creds = await credsFor(req, getSecret);
        if (!creds.host || !creds.database || !creds.user || !creds.password) {
            return res.json({ ok: false, error: FIREBIRD_NOT_CONFIGURED });
        }
        /** @param {unknown} message */
        const scrub = (message) => String(message || 'Connection failed').split(creds.password).join('***').slice(0, 300);
        /** @type {NodeJS.Timeout | undefined} */
        let timer;
        try {
            const result = await Promise.race([
                testConnection(creds),
                new Promise((_resolve, reject) => {
                    timer = setTimeout(() => reject(new Error(`Timed out after ${FIREBIRD_TEST_TIMEOUT_MS / 1000} seconds`)), FIREBIRD_TEST_TIMEOUT_MS);
                }),
            ]);
            const outcome = /** @type {TestOutcome | null | undefined} */ (result);
            if (!outcome || !outcome.ok) return res.json({ ok: false, error: scrub(outcome && outcome.error) });
            res.json({ ok: true, server_version: outcome.server_version, table_count: outcome.table_count });
        } catch (err) {
            res.json({ ok: false, error: scrub(/** @type {Error} */ (err).message) });
        } finally {
            clearTimeout(timer);
        }
    });
    return router;
}

module.exports = { createFirebirdTestRouter };
