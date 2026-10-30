// @typecheck strict
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
 * The options of createSigningSecret: `envVars` are the env var names, checked
 * in order; `devCacheName` the temp-file prefix, e.g.
 * 'beeflow-learning-cert-secret'; `configKey` the configStore key for
 * ensureDurable() (omit to disable); `label` the log prefix, e.g.
 * 'CertificateToken'; `productionWarning` the message logged when falling back
 * to a random secret; `productionLogLevel` 'warn' or 'error' (default 'error').
 *
 * ensureDurable() RETRIES. Its one database write lands in the busiest seconds
 * of boot (101 store inits, the migrations, the first requests), and on a small
 * host that window has exhausted the pool: the write timed out, the replica
 * kept its per-process random secret until the next restart, and every share
 * link it signed in between died with it. A failed bootstrap is now retried on
 * a backoff (5 s … 5 min, `retryDelaysMs`, or SIGNING_SECRET_RETRY_DELAYS_MS
 * as a comma-separated list; empty = one attempt) until the secret is durable;
 * a stored value that is unusable is not retried, that is a configuration
 * problem. Tests inject `setSecretIfAbsent` and `setTimer`, or set the env
 * var to '' where they load the real token modules.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const log = require('../../telemetry/log');
const { bestEffort } = require('../../utils/bestEffort');

const DEFAULT_RETRY_DELAYS_MS = [5_000, 15_000, 45_000, 120_000, 300_000];

function retryDelaysFromEnv() {
    const raw = process.env.SIGNING_SECRET_RETRY_DELAYS_MS;
    if (raw === undefined) return DEFAULT_RETRY_DELAYS_MS;
    return raw.split(',').map((s) => s.trim()).filter((s) => s !== '')
        .map(Number).filter((n) => Number.isFinite(n) && n >= 0);
}

/** @typedef {(fn: () => void, ms: number) => { unref?: () => void } | unknown} SetTimer */

/**
 * @typedef SigningSecretOptions
 * @property {string[]} envVars
 * @property {string} devCacheName
 * @property {string | null} [configKey]
 * @property {string} label
 * @property {string} productionWarning
 * @property {'warn' | 'error'} [productionLogLevel]
 * @property {(key: string, value: string) => Promise<string | null | undefined>} [setSecretIfAbsent] configStore.setSecretIfAbsent by default
 * @property {number[]} [retryDelaysMs] waits between bootstrap attempts; empty = one attempt
 * @property {SetTimer} [setTimer] global setTimeout by default
 */

/** The dev secret on disk, or null when there is none worth using. @param {string} cachePath */
function readDevSecret(cachePath) {
    try {
        const stored = fs.readFileSync(cachePath);
        if (stored.length >= 32) return stored;
    } catch (err) { if (err?.code !== 'ENOENT') bestEffort('signingSecret:read-dev-cache', err); }
    return null;
}

/** @param {string} cachePath @param {Buffer} secret @returns {Error | null} the write error, if any */
function writeDevSecret(cachePath, secret) {
    try {
        fs.writeFileSync(cachePath, secret, { mode: 0o600 });
        return null;
    } catch (err) {
        return /** @type {Error} */ (err);
    }
}

/** The first env var of `names` that holds a usable secret. @param {string[]} names */
function envSecret(names) {
    for (const name of names) {
        const v = process.env[name];
        if (v && v.length >= 32) return v;
    }
    return null;
}

/** A wait that never keeps the process alive. @param {SetTimer} setTimer @param {number} ms */
function sleepUnref(setTimer, ms) {
    return new Promise((resolve) => {
        const t = setTimer(() => resolve(undefined), ms);
        if (t && typeof t === 'object' && 'unref' in t && typeof t.unref === 'function') t.unref();
    });
}

/**
 * Run `attempt` until it resolves, waiting `retryDelaysMs[n]` after the n-th
 * rejection; out of delays, give up.
 * @template T
 * @param {() => Promise<T>} attempt
 * @param {{ retryDelaysMs: number[], sleep: (ms: number) => Promise<unknown>,
 *           onRetry: (err: Error, delayMs: number) => void, onGiveUp: (err: Error, attempts: number) => void }} o
 * @returns {Promise<{ ok: true, value: T, retries: number } | { ok: false }>}
 */
async function retrying(attempt, o) {
    for (let n = 0; ; n++) {
        try {
            return { ok: true, value: await attempt(), retries: n };
        } catch (err) {
            const delay = o.retryDelaysMs[n];
            if (delay === undefined) { o.onGiveUp(/** @type {Error} */ (err), n + 1); return { ok: false }; }
            o.onRetry(/** @type {Error} */ (err), delay);
            await o.sleep(delay);
        }
    }
}

/** @param {SigningSecretOptions} opts */
function createSigningSecret(opts) {
    const {
        envVars,
        devCacheName,
        configKey = null,
        label,
        productionWarning,
        productionLogLevel = 'error',
        setSecretIfAbsent = (key, value) => require('../../stores/configStore').setSecretIfAbsent(key, value),
        retryDelaysMs = retryDelaysFromEnv(),
        setTimer = setTimeout,
    } = opts;

    /** @type {NonSharedBuffer | Buffer<ArrayBuffer> | null} */
    let cachedSecret = null;
    let durable = false;
    /** @type {Promise<boolean> | null} the bootstrap in flight, so two callers share one */
    let bootstrapInFlight = null;

    const fromEnv = () => envSecret(envVars);

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
        const stored = readDevSecret(cachePath);
        if (stored) {
            cachedSecret = stored;
            durable = true;
            return cachedSecret;
        }
        cachedSecret = crypto.randomBytes(32);
        const writeError = writeDevSecret(cachePath, cachedSecret);
        durable = !writeError;
        if (writeError) log.warn(`[${label}] Could not persist dev secret (${writeError.message}); tokens will be invalidated on every restart.`);
        return cachedSecret;
    }

    /** True once the secret survives a restart (env, bootstrapped, or dev cache). */
    function hasDurable() {
        if (!cachedSecret) get();
        return durable;
    }

    /**
     * One attempt: true when a durable secret is now in place, false when the
     * store answered but with nothing usable (not retried). Throws when the
     * store did not answer (retried).
     */
    async function tryBootstrap() {
        const stored = await setSecretIfAbsent(/** @type {string} */ (configKey), crypto.randomBytes(48).toString('hex'));
        if (stored && stored.length >= 32) {
            cachedSecret = Buffer.from(stored, 'utf8');
            durable = true;
            return true;
        }
        return false;
    }

    async function bootstrapWithRetries() {
        const r = await retrying(tryBootstrap, {
            retryDelaysMs,
            sleep: (ms) => sleepUnref(setTimer, ms),
            onRetry: (err, delay) => log.warn(`[${label}] Could not bootstrap a durable secret (${err.message}); retrying in ${Math.round(delay / 1000)} s.`),
            onGiveUp: (err, attempts) => log.error(`[${label}] Could not bootstrap a durable secret after ${attempts} attempts (${err.message}); tokens signed by this replica die on restart until the bootstrap succeeds.`),
        });
        if (!r.ok || !r.value) return hasDurable();
        if (r.retries > 0) log.info(`[${label}] Durable secret bootstrapped after ${r.retries} ${r.retries === 1 ? 'retry' : 'retries'}.`);
        return true;
    }

    /**
     * Startup bootstrap for installs that never set the env var. Non-fatal and
     * safe to call repeatedly: concurrent callers share one bootstrap, and a
     * secret that is already durable is left alone. Env secrets always win.
     */
    async function ensureDurable() {
        if (fromEnv()) return true;
        if (!configKey) return hasDurable();
        if (durable) return true;
        if (!bootstrapInFlight) {
            bootstrapInFlight = bootstrapWithRetries().finally(() => { bootstrapInFlight = null; });
        }
        return bootstrapInFlight;
    }

    return { get, hasDurable, ensureDurable };
}

module.exports = { createSigningSecret };
