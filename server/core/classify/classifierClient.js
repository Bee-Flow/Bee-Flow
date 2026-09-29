// @typecheck
/**
 * The wire to classify-service, the zero-shot topic classifier behind the
 * Condition node's "is about" rule (shared/expr/topics.mjs).
 *
 * ONE DIFFERENCE FROM THE OTHER SIDECAR CLIENTS, AND IT IS THE POINT.
 * disclosureClassifier.js answers `null` ("no opinion") whenever the guard
 * cannot say, because its caller has a keyword rule to fall back on. A
 * routing rule has nothing to fall back on: reading "the classifier is down"
 * as "not about a complaint" would send every complaint down the "otherwise"
 * output while the run finishes green. So every failure here THROWS, with an
 * `errorClass` the run history can filter on, and the step fails where the
 * author can see it.
 *
 * What goes over the wire is an allow-list: the texts and the topics, nothing
 * else (BFSF-441). The service is in-cluster, keeps nothing and logs no text;
 * this side logs counts and timings only. The cache holds SCORES under a hash
 * of the text, never the text.
 */

const crypto = require('node:crypto');
const log = require('../../telemetry/log');

/** Texts per request. The service accepts 32; 16 keeps one request short. */
const BATCH_SIZE = 16;
const MAX_IN_FLIGHT = 2;
/** Overall budget for one classify() call, retries included. */
const DEADLINE_MS = Number(process.env.AUTOMATION_TOPIC_DEADLINE_MS) || 120_000;
const REQUEST_BASE_MS = 10_000;
const REQUEST_PER_TEXT_MS = 2_000;
const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 30_000;
const CACHE_MAX_ENTRIES = 5_000;
const PROBE_TTL_OK_MS = 30_000;
const PROBE_TTL_FAIL_MS = 10_000;
const PROBE_TIMEOUT_MS = 1_500;
// The service reports its own; this is only the fallback, and it matches the
// service's default (classify-service/eval/MODEL-DECISIONS.md).
const DEFAULT_THRESHOLD = 0.75;

const MESSAGES = {
    topic_classifier_not_configured:
        'This step uses "is about", but no topic classifier is installed. Start classify-service and set CLASSIFY_SERVICE_URL, or remove the "is about" rules.',
    topic_classifier_unavailable:
        'The topic classifier did not answer, so nothing was routed. Run it again once classify-service is back.',
};

class TopicClassifierError extends Error {
    /**
     * @param {string} errorClass
     * @param {string} [message]
     * @param {string} [detail]  operator-facing detail (status, reason); never text
     */
    constructor(errorClass, message, detail) {
        super(message || MESSAGES[errorClass] || errorClass);
        this.name = 'TopicClassifierError';
        this.errorClass = errorClass;
        // Read by the executors: a failure of the classifier fails the step,
        // it is never swallowed into "this row does not match".
        this.topicFatal = true;
        if (detail) this.detail = detail;
    }
}

// ── Module state: breaker, score cache, last engine, probe ──────────────

let _failures = 0;
let _openUntil = 0;
/** @type {Map<string, Record<string, number>>} hash → scores, oldest first */
const _cache = new Map();
/** @type {Map<string, string>} url → the engine fingerprint it last reported */
const _engineByUrl = new Map();
/** @type {{ at: number, ttl: number, value: any } | null} */
let _probe = null;

function _noteFailure(reason) {
    _failures += 1;
    if (_failures >= BREAKER_THRESHOLD && Date.now() >= _openUntil) {
        _openUntil = Date.now() + BREAKER_COOLDOWN_MS;
        log.warn(`[TopicClassifier] ${_failures} failures in a row (${reason}); short-circuiting for ${BREAKER_COOLDOWN_MS}ms`);
    }
}

function _noteSuccess() {
    _failures = 0;
    _openUntil = 0;
}

/** Test seam: the breaker, cache and probe are module state. */
function _resetClassifierState() {
    _failures = 0;
    _openUntil = 0;
    _cache.clear();
    _engineByUrl.clear();
    _probe = null;
}

function _cacheKey(engine, labels, text) {
    return crypto.createHash('sha256').update(`${engine}\u0000${labels.join('\u0000')}\u0000${text}`).digest('hex');
}

function _cacheGet(key) {
    const hit = _cache.get(key);
    if (hit) { _cache.delete(key); _cache.set(key, hit); }
    return hit;
}

function _cacheSet(key, scores) {
    _cache.set(key, scores);
    while (_cache.size > CACHE_MAX_ENTRIES) _cache.delete(_cache.keys().next().value);
}

// ── Transport ────────────────────────────────────────────────────────────

/**
 * @param {string} url
 * @param {{ method?: string, body?: any, apiKey?: string, signal?: AbortSignal }} opts
 * @returns {Promise<{ status: number, json: any }>}
 */
async function _request(url, { method = 'POST', body, apiKey, signal }) {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['X-API-Key'] = apiKey;
    const res = await fetch(url, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal,
    });
    let json = null;
    try { json = await res.json(); } catch { /* a non-JSON body is read as no body */ }
    return { status: res.status, json };
}

function _sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
    });
}

function _withTimeout(ms, signal) {
    const t = AbortSignal.timeout(ms);
    return signal ? AbortSignal.any([t, signal]) : t;
}

/** A response is only usable when every text has a number for every topic. */
function _validResults(json, n, labels) {
    const results = json && Array.isArray(json.results) ? json.results : null;
    if (!results || results.length !== n) return null;
    for (const r of results) {
        if (!r || typeof r.scores !== 'object' || r.scores === null) return null;
        for (const l of labels) if (typeof r.scores[l] !== 'number' || !Number.isFinite(r.scores[l])) return null;
    }
    return results;
}

/**
 * One batch, retried while the service says "busy" or "still loading" and
 * the overall deadline allows.
 */
async function _classifyBatch(target, texts, labels, { signal, deadlineAt, request }) {
    let delay = 500;
    for (;;) {
        const remaining = deadlineAt - Date.now();
        if (remaining <= 0) {
            throw new TopicClassifierError('topic_classifier_unavailable', undefined, 'deadline');
        }
        let res;
        try {
            res = await request(`${target.url}/classify`, {
                // ALLOW-LIST: the texts and the topics. No threshold: the
                // runner applies thresholds itself, per rule.
                body: { texts, labels },
                apiKey: target.apiKey,
                signal: _withTimeout(Math.min(remaining, REQUEST_BASE_MS + REQUEST_PER_TEXT_MS * texts.length), signal),
            });
        } catch (e) {
            if (signal?.aborted) throw e;
            _noteFailure('network');
            throw new TopicClassifierError('topic_classifier_unavailable', undefined, e?.name === 'TimeoutError' ? 'timeout' : 'network');
        }
        const retryable = res.status === 429 || (res.status === 503 && res.json?.detail === 'model_loading');
        if (retryable && Date.now() + delay < deadlineAt) {
            await _sleep(delay, signal);
            delay = Math.min(delay * 2, 8_000);
            continue;
        }
        if (res.status !== 200) {
            _noteFailure(`status ${res.status}`);
            throw new TopicClassifierError('topic_classifier_unavailable', undefined, `status ${res.status}`);
        }
        const results = _validResults(res.json, texts.length, labels);
        if (!results) {
            _noteFailure('bad response');
            throw new TopicClassifierError('topic_classifier_unavailable', undefined, 'bad response');
        }
        return { results, json: res.json };
    }
}

/**
 * Score `texts` against `labels`.
 *
 * @param {string[]} texts   normalised texts (topics.mjs normalizeTopicText), distinct, non-empty
 * @param {string[]} labels  the step's full topic list, trimmed, distinct, sorted
 * @param {{ signal?: AbortSignal, endpoint?: { url: string|null, apiKey: string }, request?: typeof _request }} [opts]
 *   `endpoint` and `request` are injection seams for tests and callers that
 *   already resolved the service.
 * @returns {Promise<{ scores: Array<Record<string, number>>, defaultThreshold: number, model: string|null, engine: string|null, truncated: number }>}
 * @throws {TopicClassifierError}
 */
async function classify(texts, labels, { signal, endpoint, request = _request } = {}) {
    const empty = { scores: [], defaultThreshold: DEFAULT_THRESHOLD, model: null, engine: null, truncated: 0 };
    if (!texts.length) return empty;

    const target = endpoint || await require('./classifierEndpoint').getClassifierEndpoint();
    if (!target || !target.url) throw new TopicClassifierError('topic_classifier_not_configured');
    if (Date.now() < _openUntil) throw new TopicClassifierError('topic_classifier_unavailable', undefined, 'breaker open');

    const started = Date.now();
    const deadlineAt = started + DEADLINE_MS;
    let engine = _engineByUrl.get(target.url) || '';
    /** @type {Array<Record<string, number>|undefined>} */
    const scores = texts.map((t) => (engine ? _cacheGet(_cacheKey(engine, labels, t)) : undefined));
    const missing = [];
    scores.forEach((s, i) => { if (!s) missing.push(i); });

    const batches = [];
    for (let i = 0; i < missing.length; i += BATCH_SIZE) batches.push(missing.slice(i, i + BATCH_SIZE));

    let defaultThreshold = DEFAULT_THRESHOLD;
    let model = null;
    let truncated = 0;
    let next = 0;
    const worker = async () => {
        while (next < batches.length) {
            const idx = batches[next++];
            const { results, json } = await _classifyBatch(target, idx.map((i) => texts[i]), labels, { signal, deadlineAt, request });
            if (typeof json.default_threshold === 'number' && json.default_threshold > 0 && json.default_threshold < 1) {
                defaultThreshold = json.default_threshold;
            }
            if (typeof json.model === 'string') model = json.model;
            if (typeof json.engine === 'string' && json.engine) engine = json.engine;
            results.forEach((r, j) => {
                const s = Object.fromEntries(labels.map((l) => [l, r.scores[l]]));
                scores[idx[j]] = s;
                if (r.truncated === true) truncated += 1;
                if (engine) _cacheSet(_cacheKey(engine, labels, texts[idx[j]]), s);
            });
        }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_IN_FLIGHT, batches.length) }, worker));
    if (batches.length) {
        _noteSuccess();
        if (engine) _engineByUrl.set(target.url, engine);
        log.info(`[TopicClassifier] ${missing.length} texts x ${labels.length} topics in ${Date.now() - started}ms (${texts.length - missing.length} cached)`);
    }
    return { scores: /** @type {Array<Record<string, number>>} */ (scores), defaultThreshold, model, engine: engine || null, truncated };
}

/**
 * Is a classifier installed and answering? For the builder (show or disable
 * the "is about" operator) and the validator (block activation when none is
 * configured). Cached briefly; never throws.
 *
 * @param {{ endpoint?: { url: string|null, apiKey: string }, request?: typeof _request, fresh?: boolean }} [opts]
 * @returns {Promise<{ available: boolean, reason: null|'not_configured'|'unreachable'|'loading'|'error', defaultThreshold: number, maxLabels: number|null, model: string|null }>}
 */
async function probe({ endpoint, request = _request, fresh = false } = {}) {
    if (!fresh && _probe && Date.now() - _probe.at < _probe.ttl) return _probe.value;
    const answer = (value) => {
        _probe = { at: Date.now(), ttl: value.available ? PROBE_TTL_OK_MS : PROBE_TTL_FAIL_MS, value };
        return value;
    };
    const base = { defaultThreshold: DEFAULT_THRESHOLD, maxLabels: null, model: null };
    let target;
    try {
        target = endpoint || await require('./classifierEndpoint').getClassifierEndpoint();
    } catch {
        target = null;
    }
    if (!target || !target.url) return answer({ available: false, reason: 'not_configured', ...base });
    let res;
    try {
        res = await request(`${target.url}/health`, { method: 'GET', apiKey: target.apiKey, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    } catch {
        return answer({ available: false, reason: 'unreachable', ...base });
    }
    const j = res.json || {};
    if (res.status === 200) {
        return answer({
            available: true,
            reason: null,
            defaultThreshold: typeof j.default_threshold === 'number' ? j.default_threshold : DEFAULT_THRESHOLD,
            maxLabels: typeof j.max_labels === 'number' ? j.max_labels : null,
            model: typeof j.model === 'string' ? j.model : null,
        });
    }
    return answer({ available: false, reason: res.status === 503 && !j.load_error ? 'loading' : 'error', ...base });
}

/**
 * The validator's `topicClassifier` fact for one routine definition
 * (validate/stepRules/topicRules.js):
 *
 *   null  — the routine asks no "is about" question (no probe is made), or
 *           the classifier's state is unknown (unreachable, still loading):
 *           never a finding, so an outage cannot block anyone;
 *   false — it does, and no classifier is configured;
 *   true  — it does, and the classifier answers.
 */
async function topicClassifierFor(definition, { probeFn = probe } = {}) {
    let text;
    try { text = JSON.stringify(definition || {}); } catch { return null; }
    if (!text.includes('isAbout(')) return null;
    const p = await probeFn();
    if (p.available) return true;
    return p.reason === 'not_configured' ? false : null;
}

module.exports = {
    classify,
    probe,
    topicClassifierFor,
    TopicClassifierError,
    BATCH_SIZE,
    _resetClassifierState,
};
