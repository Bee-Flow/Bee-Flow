// @typecheck
/**
 * Per-connection rate limiter for model providers, with Retry-After backoff.
 *
 * Why: an automation that loops over a list may fire dozens of model calls at
 * once. A provider answers an over-eager caller with 429 (or 503 / 529
 * "overloaded") and usually a `Retry-After`. Without a limiter every call
 * fails the moment the first 429 arrives; with one, calls queue up behind a
 * shared budget and a throttled call waits and retries instead of failing the
 * run.
 *
 * One bucket pair per provider CONNECTION (adapter + url + credential), keyed
 * by a hash, so two organisations with their own keys never slow each other
 * down and the key material is never kept or logged in the clear:
 *   - requests per minute  (LLM_PROVIDER_RPM, default 600, 0 = unlimited)
 *   - tokens per minute    (LLM_PROVIDER_TPM, default 2000000, 0 = unlimited)
 * Both refill continuously. A request is estimated up front and corrected from
 * the real usage once the answer is in (`settle`).
 *
 * LLM_RATE_LIMIT_RETRIES (default 4, 0 = no retry) bounds the retries after a
 * rate-limit answer; LLM_RATE_LIMIT_MAX_WAIT_MS (default 60000, 0 = no cap)
 * bounds one wait, so a hostile `Retry-After: 86400` cannot park a worker.
 *
 * A leaf module on purpose: it requires only the retry helpers, the status
 * reader of the tool loop and the logger, so it cannot join an import cycle.
 */

const crypto = require('crypto');
const retryAfter = require('../http/retryAfter');
const { providerErrorStatus } = require('./toolLoop');
const log = require('../../telemetry/log');

const IDLE_KEY_MS = 10 * 60 * 1000;
const SWEEP_EVERY_MS = 60 * 1000;
const DEFAULT_OUTPUT_TOKENS = 1024;

/** Non-negative integer from the environment; '' or invalid falls back. */
function envCap(env, name, fallback) {
    const raw = env[name];
    if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : fallback;
}

function cancelled() {
    return new Error('Run cancelled');
}

/**
 * One bucket per provider connection. A hash, so neither the credential nor the
 * url ever sits in a Map key, a log line or a heap dump of the limiter.
 */
function limiterKeyFor({ adapterName, url, apiKey }) {
    const material = `${adapterName}|${String(url || '').replace(/\/+$/, '')}|${apiKey || ''}`;
    return 'llm:' + crypto.createHash('sha256').update(material).digest('hex').slice(0, 32);
}

/** Serialised length of a value; 0 (and a debug line) when it cannot be serialised. */
function jsonLength(value) {
    try {
        return JSON.stringify(value).length;
    } catch (e) {
        log.debug(`[LLMLimiter] size estimate skips unserialisable content: ${e.message}`);
        return 0;
    }
}

/** Rough size of one request: characters / 4 plus the room for the answer. */
function estimateRequestTokens(messages, options) {
    let chars = 0;
    for (const m of Array.isArray(messages) ? messages : []) {
        const c = m && m.content;
        if (typeof c === 'string') chars += c.length;
        else if (c != null) chars += jsonLength(c);
    }
    if (options && options.tools) chars += jsonLength(options.tools);
    return Math.ceil(chars / 4) + ((options && options.maxTokens) || DEFAULT_OUTPUT_TOKENS);
}

/** Header value from an SDK error (fetch Headers, a plain object, or a nested response). */
function readRetryAfterHeader(err) {
    const h = err && err.headers;
    const viaGet = h && typeof h.get === 'function' ? h.get('retry-after') : undefined;
    if (viaGet !== undefined && viaGet !== null) return viaGet;
    if (h && typeof h === 'object' && h['retry-after'] !== undefined) return h['retry-after'];
    const rh = err && err.response && err.response.headers;
    const viaResponse = rh && typeof rh.get === 'function' ? rh.get('retry-after') : undefined;
    if (viaResponse !== undefined && viaResponse !== null) return viaResponse;
    return rh && typeof rh === 'object' && rh['retry-after'] !== undefined ? rh['retry-after'] : null;
}

/**
 * Is this a "slow down" answer, and how long did the provider ask us to wait?
 * Mirrors classifyStreamError's overloaded / 429 detection.
 * @returns {{ status: number|null, retryAfterMs: number|null } | null}
 */
function rateLimitInfo(err, nowMs = Date.now()) {
    if (!err) return null;
    const status = err.status ?? err.statusCode ?? providerErrorStatus(err);
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- a fixed literal on an error message, no repeats: linear
    const msg = String(err.message || '');
    const overloaded = /overloaded/i.test(msg) || (err.error && err.error.type === 'overloaded_error');
    if (!(status === 429 || status === 503 || status === 529 || overloaded)) return null;
    let retryAfterMs = Number.isFinite(err.retryAfterMs) ? err.retryAfterMs : null;
    if (retryAfterMs === null) retryAfterMs = retryAfter.parseRetryAfter(readRetryAfterHeader(err), nowMs);
    return { status: Number.isFinite(status) ? status : null, retryAfterMs };
}

/** Tokens a chat result reports, or null when it reports none. */
function usageTokens(result) {
    const u = result && result.usage;
    if (!u || typeof u !== 'object') return null;
    const a = Number(u.prompt_tokens ?? u.input_tokens);
    const b = Number(u.completion_tokens ?? u.output_tokens);
    if (!Number.isFinite(a) && !Number.isFinite(b)) return null;
    return (Number.isFinite(a) ? a : 0) + (Number.isFinite(b) ? b : 0);
}

/**
 * @param {{ now?: () => number, sleep?: (ms: number, signal?: AbortSignal|null) => Promise<void>, env?: Record<string, string|undefined> }} [deps]
 */
function createProviderLimiter({ now = Date.now, sleep = retryAfter.sleep, env = process.env } = {}) {
    /** @type {Map<string, any>} */
    const entries = new Map();
    let lastSweep = 0;

    function caps() {
        return {
            rpm: envCap(env, 'LLM_PROVIDER_RPM', 600),
            tpm: envCap(env, 'LLM_PROVIDER_TPM', 2_000_000),
        };
    }

    function sweep(t) {
        if (t - lastSweep < SWEEP_EVERY_MS) return;
        lastSweep = t;
        for (const [k, e] of entries) {
            if (e.pending === 0 && t - e.lastUsed > IDLE_KEY_MS && e.pausedUntil <= t) entries.delete(k);
        }
    }

    function entryFor(key, c, t) {
        sweep(t);
        let e = entries.get(key);
        if (!e) {
            e = { req: c.rpm, tok: c.tpm, at: t, pausedUntil: 0, tail: Promise.resolve(), pending: 0, lastUsed: t };
            entries.set(key, e);
        }
        return e;
    }

    function refill(e, c, t) {
        const dt = Math.max(0, t - e.at);
        e.at = t;
        if (c.rpm > 0) e.req = Math.min(c.rpm, e.req + dt * (c.rpm / 60000));
        if (c.tpm > 0) e.tok = Math.min(c.tpm, e.tok + dt * (c.tpm / 60000));
    }

    /** Resolve when `p` settles, reject when the signal aborts first. */
    function untilOrAbort(p, signal) {
        if (!signal) return p;
        if (signal.aborted) return Promise.reject(cancelled());
        return new Promise((resolve, reject) => {
            const onAbort = () => reject(cancelled());
            signal.addEventListener('abort', onAbort, { once: true });
            p.then(
                (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
                (er) => { signal.removeEventListener('abort', onAbort); reject(er); },
            );
        });
    }

    /**
     * Wait until the key's buckets cover the request and any cool-down has
     * passed, then take the budget. Waits are re-evaluated after every sleep:
     * the clock, the caps and a fresh cool-down may all have moved.
     */
    async function takeBudget(e, tokens, signal) {
        for (;;) {
            if (signal && signal.aborted) throw cancelled();
            const c = caps();
            const t = now();
            refill(e, c, t);
            const need = c.tpm > 0 ? Math.min(Math.max(0, tokens), c.tpm) : 0;
            let wait = Math.max(0, e.pausedUntil - t);
            if (c.rpm > 0 && e.req < 1) wait = Math.max(wait, Math.ceil((1 - e.req) / (c.rpm / 60000)));
            if (c.tpm > 0 && e.tok < need) wait = Math.max(wait, Math.ceil((need - e.tok) / (c.tpm / 60000)));
            if (wait <= 0) {
                if (c.rpm > 0) e.req -= 1;
                if (c.tpm > 0) e.tok -= need;
                return { reserved: need, capped: c.tpm };
            }
            await sleep(Math.max(1, wait), signal || null);
        }
    }

    /**
     * Take a place in the key's queue and wait for budget.
     * @param {string} key
     * @param {{ tokens?: number, signal?: AbortSignal|null }} [opts]
     * @returns {Promise<{ settle: (actualTokens: number|null) => void }>}
     */
    async function acquire(key, { tokens = 0, signal = null } = {}) {
        if (signal && signal.aborted) throw cancelled();
        const e = entryFor(key, caps(), now());
        const before = e.tail;
        /** @type {(value?: any) => void} */
        let release = () => {};
        e.tail = new Promise((resolve) => { release = resolve; });
        e.pending += 1;
        try {
            await untilOrAbort(before, signal);
            const { reserved, capped } = await takeBudget(e, tokens, signal);
            let settled = false;
            return {
                settle(actual) {
                    if (settled) return;
                    settled = true;
                    if (!Number.isFinite(actual) || capped <= 0) return;
                    e.tok = Math.min(capped, e.tok - (Number(actual) - reserved));
                },
            };
        } finally {
            e.pending -= 1;
            e.lastUsed = now();
            release();
        }
    }

    /**
     * Run `fn` inside the key's budget; a rate-limit answer cools the key
     * down and retries, any other error goes out untouched.
     * @template T
     * @param {{ key: string, estimateTokens?: number, signal?: AbortSignal|null }} opts
     * @param {() => Promise<T>} fn
     * @returns {Promise<T>}
     */
    async function withRateLimit({ key, estimateTokens = 0, signal = null }, fn) {
        const maxRetries = envCap(env, 'LLM_RATE_LIMIT_RETRIES', 4);
        const maxWaitCfg = envCap(env, 'LLM_RATE_LIMIT_MAX_WAIT_MS', 60000);
        for (let attempt = 0; ; attempt++) {
            const lease = await acquire(key, { tokens: estimateTokens, signal });
            let result;
            try {
                result = await fn();
            } catch (err) {
                const info = rateLimitInfo(err, now());
                if (!info || attempt >= maxRetries) throw err;
                const wait = retryAfter.backoffDelay(attempt, {
                    retryAfterMs: info.retryAfterMs,
                    baseMs: 1000,
                    maxMs: maxWaitCfg > 0 ? maxWaitCfg : Infinity,
                });
                const e = entries.get(key);
                if (e) e.pausedUntil = Math.max(e.pausedUntil, now() + wait);
                // Status, attempt and wait only: never the body, the prompt or the key.
                log.warn(`[LLMLimiter] rate limited (status ${info.status ?? '?'}), retry ${attempt + 1}/${maxRetries} after ${wait} ms`);
                continue;
            }
            lease.settle(usageTokens(result));
            return result;
        }
    }

    /**
     * adapter.chat through the limiter. The key comes from the adapter, url and
     * credential, so one organisation's key has its own budget.
     * @param {{ adapter: any, cfg: { apiKey?: string, url?: string }, modelId: string, messages: any[], options?: any, signal?: AbortSignal|null }} args
     */
    function limitedChat({ adapter, cfg, modelId, messages, options, signal }) {
        return withRateLimit({
            key: limiterKeyFor({ adapterName: adapter.name, url: cfg.url, apiKey: cfg.apiKey }),
            estimateTokens: estimateRequestTokens(messages, options),
            signal,
        }, () => adapter.chat(cfg.apiKey, cfg.url, modelId, messages, options));
    }

    function _resetForTests() {
        entries.clear();
        lastSweep = 0;
    }

    return {
        acquire, withRateLimit, limitedChat, limiterKeyFor, estimateRequestTokens,
        rateLimitInfo: (err) => rateLimitInfo(err, now()),
        _resetForTests,
    };
}

const singleton = createProviderLimiter();

module.exports = { ...singleton, createProviderLimiter };
