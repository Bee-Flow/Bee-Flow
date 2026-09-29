// @typecheck
/**
 * One implementation of the "signing secret with a durable fallback" pattern.
 *
 * certificateToken.js, webpagePreviewToken.js and publicShareToken.js each grew
 * their own byte-for-byte copy of this ladder:
 *
 *   1. env var (>= 32 chars)          — operator-set, always wins, durable.
 *   2. configStore-persisted secret   — bootstrapped once at startup via
 *      setSecretIfAbsent (ON CONFLICT DO NOTHING), so every replica agrees
 *      without operator action. Durable.
 *   3. production last-resort          — a per-process random secret. NOT
 *      durable: tokens die on restart and are rejected by sibling replicas,
 *      so this is loud but non-fatal (a request landing during the startup
 *      window must not 500).
 *   4. dev                             — a random secret persisted to a
 *      per-project file in the OS temp dir, so nodemon restarts keep signing
 *      with the same key. Keyed on cwd so two checkouts stay distinct.
 *
 * Three copies meant three places to fix a bug in the ladder and three subtly
 * different log messages. The per-feature parameters that MUST stay distinct —
 * the env var names, the configStore key, the temp-file name — are arguments,
 * never merged: a secret scoped to one feature must not sign another's tokens.
 *
 * @param {object}   opts
 * @param {string[]} opts.envVars        env var names, checked in order
 * @param {string}   opts.devCacheName   temp-file prefix, e.g. 'beeflow-learning-cert-secret'
 * @param {string}   [opts.configKey]    configStore key for ensureDurable(); omit to disable
 * @param {string}   opts.label          log prefix, e.g. 'CertificateToken'
 * @param {string}   opts.productionWarning  message logged when falling back to a random secret
 * @param {'warn'|'error'} [opts.productionLogLevel='error']
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const log = require('../../telemetry/log');

function createSigningSecret(opts) {
    const {
        envVars,
        devCacheName,
        configKey = null,
        label,
        productionWarning,
        productionLogLevel = 'error',
    } = opts;

    let cachedSecret = null;
    let durable = false;

    function fromEnv() {
        for (const name of envVars) {
            const v = process.env[name];
            if (v && v.length >= 32) return v;
        }
        return null;
    }

    function get() {
        if (cachedSecret) return cachedSecret;

        const env = fromEnv();
        if (env) {
            cachedSecret = Buffer.from(env, 'utf8');
            durable = true;
            return cachedSecret;
        }

        if (process.env.NODE_ENV === 'production') {
            cachedSecret = crypto.randomBytes(32);
            log[productionLogLevel](`[${label}] ${productionWarning}`);
            return cachedSecret;
        }

        // Dev: persist to a per-project temp file so restarts keep the key.
        const projHash = crypto.createHash('sha1').update(process.cwd()).digest('hex').slice(0, 12);
        const cachePath = path.join(os.tmpdir(), `${devCacheName}-${projHash}`);
        try {
            const stored = fs.readFileSync(cachePath);
            if (stored.length >= 32) {
                cachedSecret = stored;
                durable = true;
                return cachedSecret;
            }
        } catch (_) { /* first run */ }

        cachedSecret = crypto.randomBytes(32);
        try {
            fs.writeFileSync(cachePath, cachedSecret, { mode: 0o600 });
            durable = true;
        } catch (err) {
            log.warn(`[${label}] Could not persist dev secret (${err.message}); tokens will be invalidated on every restart.`);
        }
        return cachedSecret;
    }

    /** True once the secret survives a restart (env, bootstrapped, or dev cache). */
    function hasDurable() {
        if (!cachedSecret) get();
        return durable;
    }

    /**
     * Startup bootstrap for installs that never set the env var. Non-fatal and
     * safe to call repeatedly. Env secrets always win.
     */
    async function ensureDurable() {
        if (fromEnv()) return true;
        if (!configKey) return hasDurable();
        try {
            const configStore = require('../../stores/configStore');
            const stored = await configStore.setSecretIfAbsent(configKey, crypto.randomBytes(48).toString('hex'));
            if (stored && stored.length >= 32) {
                cachedSecret = Buffer.from(stored, 'utf8');
                durable = true;
                return true;
            }
        } catch (err) {
            log.error(`[${label}] Could not bootstrap a durable secret:`, err.message);
        }
        return hasDurable();
    }

    return { get, hasDurable, ensureDurable };
}

module.exports = { createSigningSecret };
