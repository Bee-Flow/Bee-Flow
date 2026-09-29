// @typecheck
/**
 * Guard-service client — the HTTP call to the guard's /pii endpoint and the
 * mapping of its response back onto the scan-result shape detectPii() returns.
 */

const { PII_CATEGORIES } = require('./categories');
const { acquireSlot, releaseSlot, MAX_INFLIGHT } = require('./requestShaping');

// Simple HTTP helper — no extra dependency beyond Node built-ins
const http = require('http');
const https = require('https');
const log = require('../../../telemetry/log');

// Per-request HTTP deadline. 90s is the historical value the incident notes
// are written around; post tier-flip an 8k window scans in single-digit
// seconds, so the operator can tighten this (e.g. 20000) without code changes.
const GUARD_TIMEOUT_MS = Math.max(1000, Number(process.env.PII_GUARD_TIMEOUT_MS || 90_000));

// Guard calls get their own keep-alive agents, with an idle timeout SHORTER
// than the guard's. Node's global agent keeps idle sockets for 5s, and uvicorn
// (the guard's server) closes them after 5s by default: with equal timeouts a
// pooled socket is regularly reused at the very moment the guard closes it,
// and the scan fails with "socket hang up" (BFSF-373). Dropping idle sockets
// at 4s makes the client the one that lets go first.
const GUARD_AGENT_OPTIONS = { keepAlive: true, timeout: 4000 };
const guardHttpAgent = new http.Agent(GUARD_AGENT_OPTIONS);
const guardHttpsAgent = new https.Agent(GUARD_AGENT_OPTIONS);

// Marks an error that came from a pooled socket the server had already closed.
const STALE_SOCKET = Symbol('staleKeepAliveSocket');

/**
 * What a failed guard response may say in an error message: the status and,
 * for a validation error, the error TYPES and LOCATIONS. Never the body: a
 * FastAPI 422 echoes the offending `input`, which is the user's text.
 * @param {number} status
 * @param {string} raw
 */
function _describeFailure(status, raw) {
    let parsed = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch (_) { /* not JSON */ }
    const detail = Array.isArray(parsed?.detail) ? parsed.detail : [];
    const types = [...new Set(detail.map(d => (d && typeof d.type === 'string' ? d.type : null)).filter(Boolean))].slice(0, 5);
    const locs = [...new Set(detail
        .map(d => (Array.isArray(d?.loc) ? d.loc.filter(x => typeof x === 'string' || typeof x === 'number').join('.') : null))
        .filter(Boolean))].slice(0, 5);
    return { types, locs };
}

/**
 * POST JSON to the guard, retrying exactly once when the request died on a
 * reused keep-alive socket before any response arrived. That is the race the
 * Node docs describe for keep-alive agents: the server closed an idle socket
 * while the client was handing it a new request. A scan is idempotent, so a
 * second attempt on a fresh socket is safe.
 *
 * Nothing else is retried: a timeout, or a reset on a FRESH socket, means the
 * guard itself is in trouble, and retry load on a struggling guard is what
 * requestShaping.js exists to prevent. The retry runs inside the caller's
 * guard slot, so it adds no concurrency, and the circuit breaker in detect.js
 * only ever sees the final outcome.
 */
async function httpPost(url, body, apiKey) {
    try {
        return await _postOnce(url, body, apiKey);
    } catch (err) {
        if (!err || !err[STALE_SOCKET]) throw err;
        log.debug(`[PiiDetection] guard keep-alive socket was closed under a request (${err.code}); retrying once on a new socket`);
        return _postOnce(url, body, apiKey);
    }
}

function _postOnce(url, body, apiKey) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const isHttps = parsed.protocol === 'https:';
        const lib = isHttps ? https : http;
        const data = JSON.stringify(body);
        const headers = {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data),
        };
        if (apiKey) {
            headers['X-API-Key'] = apiKey;
        }
        const options = {
            hostname: parsed.hostname,
            port: parsed.port || (isHttps ? 443 : 80),
            path: parsed.pathname,
            method: 'POST',
            headers,
            timeout: GUARD_TIMEOUT_MS,
            agent: isHttps ? guardHttpsAgent : guardHttpAgent,
        };
        const where = `guard-service ${parsed.pathname}`;
        let responded = false;
        const req = lib.request(options, (res) => {
            responded = true;
            let chunks = '';
            res.on('data', (c) => { chunks += c; });
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        resolve(JSON.parse(chunks));
                    } catch (_) {
                        reject(Object.assign(new Error(`${where} returned invalid JSON`), { status: res.statusCode }));
                    }
                } else {
                    const { types, locs } = _describeFailure(res.statusCode, chunks);
                    const why = types.length ? ` (${types.join(',')}${locs.length ? ` at ${locs.join(',')}` : ''})` : '';
                    reject(Object.assign(new Error(`${where} returned ${res.statusCode}${why}`), {
                        status: res.statusCode, errorTypes: types, errorLocs: locs,
                    }));
                }
            });
        });
        req.on('error', (err) => {
            if (!responded && req.reusedSocket && err && (err.code === 'ECONNRESET' || err.code === 'EPIPE')) {
                err[STALE_SOCKET] = true;
            }
            reject(err);
        });
        req.on('timeout', () => { req.destroy(); reject(new Error(`${where} timeout`)); });
        req.write(data);
        req.end();
    });
}

/**
 * GET a JSON document and hand back the status WITH the body, whatever the
 * status: the guard's /health answers 503 while its model loads and still
 * says which version it is.
 * @returns {Promise<{ status: number, body: any }>}
 */
function httpGetJson(url, apiKey, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const isHttps = parsed.protocol === 'https:';
        const lib = isHttps ? https : http;
        const req = lib.request({
            hostname: parsed.hostname,
            port: parsed.port || (isHttps ? 443 : 80),
            path: parsed.pathname,
            method: 'GET',
            headers: apiKey ? { 'X-API-Key': apiKey } : {},
            timeout: timeoutMs,
        }, (res) => {
            let chunks = '';
            res.on('data', (c) => { chunks += c; });
            res.on('end', () => {
                let body = null;
                try { body = chunks ? JSON.parse(chunks) : null; } catch (_) { body = null; }
                resolve({ status: res.statusCode || 0, body });
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error(`guard-service ${parsed.pathname} timeout`)); });
        req.end();
    });
}

/**
 * Detect PII using the CPU model via the guard service (GLiNER multi-PII).
 * Maps response shapes back to the same format as detectPii().
 */
async function detectPiiViaCpuModel(text, enabledCategories, confidenceThreshold, endpoint, priority = 'interactive', customLabels = null) {
    const body = {
        text,
        confidence_threshold: confidenceThreshold,
        enabled_categories: enabledCategories || null,
    };
    // "Your own data" types recognised by the model. Only sent when there
    // are any, so every other request is byte-for-byte what it was; the
    // guard answers them in a SEPARATE list (custom_entities), which keeps
    // the built-in `entities` identical with and without them.
    const withCustom = Array.isArray(customLabels) && customLabels.length > 0;
    if (withCustom) body.custom_labels = customLabels;

    // Sidecar telemetry. There is otherwise NO latency instrumentation on this
    // path, which makes an under-redaction or slowdown regression after the
    // GLiNER-only cutover undetectable. recordSidecarCall is PII-safe by
    // construction (it takes service/status/duration only — never text,
    // categories or counts) and no-ops when OTel is disabled.
    let _t0 = Date.now();
    let _status = 'ok';
    let result;
    // Bounded in-flight, so queueing happens HERE (where the wait is
    // measurable and the timeout has not started) instead of inside the guard.
    const _queuedAt = Date.now();
    await acquireSlot(priority);
    const _queueWaitMs = Date.now() - _queuedAt;
    if (_queueWaitMs > 1000) {
        log.warn(`[PiiDetection] waited ${_queueWaitMs}ms for a guard slot (${text.length} chars, ${MAX_INFLIGHT} max in flight)`);
    }
    _t0 = Date.now();
    try {
        result = await httpPost(`${endpoint.url}/pii`, body, endpoint.apiKey);
    } catch (err) {
        _status = /timeout/i.test(err?.message || '') ? 'timeout' : 'error';
        throw err;
    } finally {
        releaseSlot(priority);
        try {
            require('../../../telemetry/metrics').recordSidecarCall({
                service: 'guard', status: _status, durationMs: Date.now() - _t0,
            });
        } catch (_) { /* telemetry must never break detection */ }
    }
    // result = { hasPii, entities: [...], degraded, degraded_reason }
    const entities = (result.entities || []).map(e => ({
        text:        e.text,
        category:    e.category,
        subCategory: null,
        confidence:  e.confidence,
        offset:      e.offset,
        length:      e.length,
        label:       e.label || PII_CATEGORIES[e.category]?.label || e.category,
    }));
    const out = {
        hasPii:      entities.length > 0,
        entities,
        redactedText: text,  // CPU model does not redact
        // The GLiNER tier could not run — the entity list is regex-only and
        // likely incomplete. Callers apply the org fail-open/closed policy
        // rather than trusting an under-redacted result (BFSF-269).
        degraded:        !!result.degraded,
        degradedReason:  result.degraded_reason || null,
        // WHICH categories lost coverage, when the guard can tell (a label
        // group whose every inference call raised). null/[] means "unknown —
        // assume all", which is what an older guard and a partial oversize
        // scan both produce. Never read an empty list as "nothing affected".
        degradedCategories: Array.isArray(result.degraded_categories) && result.degraded_categories.length
            ? result.degraded_categories
            : null,
        // Partial-scan coverage (set only when an oversize input was scanned
        // as a bounded prefix): [0, processedChars) was scanned. A coverage-
        // aware caller redacts the prefix and fails closed on the tail.
        processedChars:  typeof result.processed_chars === 'number' ? result.processed_chars : null,
        totalChars:      typeof result.total_chars === 'number' ? result.total_chars : null,
        // Which guard detection tier produced this ('on'|'shadow'|'off', see
        // GUARD_PII_REGEX_TIER). Optional — an older guard omits it — so it is
        // for attribution during a staged rollout, never for control flow.
        tierMode:        result.tier_mode || null,
        // Provenance of the engine that produced these entities. A memoising
        // caller may ONLY persist a verdict that carries one — see
        // core/dlp/scanLedger.js. Its absence is the signal that this answer
        // did not come from a live, identified guard.
        engineFingerprint: result.engine_fingerprint || null,
    };
    if (withCustom) {
        // category/label are the cdt id; the caller names them.
        out.customEntities = (Array.isArray(result.custom_entities) ? result.custom_entities : []).map(e => ({
            text:        e.text,
            category:    e.category,
            subCategory: null,
            confidence:  e.confidence,
            offset:      e.offset,
            length:      e.length,
            label:       e.category,
        }));
    }
    return out;
}

/**
 * Raw model candidates for tuning ("Your own data" test bench): POST
 * /pii/probe. Takes a guard slot like any scan, but never touches the
 * breaker: a bench experiment must not short-circuit production scans.
 * @param {{ url: string, apiKey?: string }} endpoint
 * @param {string[]} texts
 * @param {Record<string, string>} labelSet  cdt id → prompt
 * @param {'interactive'|'bulk'} [priority]
 */
async function probeViaGuard(endpoint, texts, labelSet, priority = 'bulk') {
    await acquireSlot(priority);
    try {
        return await httpPost(`${endpoint.url}/pii/probe`, { texts, label_set: labelSet }, endpoint.apiKey);
    } finally {
        releaseSlot(priority);
    }
}

module.exports = { httpPost, httpGetJson, detectPiiViaCpuModel, probeViaGuard, _describeFailure };
