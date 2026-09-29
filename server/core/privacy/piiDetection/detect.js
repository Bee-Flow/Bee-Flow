// @typecheck
/**
 * Detection orchestration — the entry point every caller reaches: cached,
 * single-flighted, short-circuited when the guard is known bad, and windowed
 * when the text is larger than one request.
 */

const { DEFAULT_PII_CONFIDENCE_THRESHOLD } = require('./categories');
const { getGuardEndpoint } = require('./guardEndpoint');
const { cacheKey, cacheGet, cacheSet, _inflightScans, _cloneScanResult } = require('./scanCache');
const { MAX_REQUEST_CHARS, circuitIsOpen, noteGuardFailure, noteGuardSuccess } = require('./requestShaping');
const { windowCountFor, detectPiiWindowed } = require('./windowing');
const { detectPiiViaCpuModel } = require('./guardClient');
const { hasCustomIds, planScan } = require('../customTypes/plan');
const { detectWithCustomTypes } = require('../customTypes/scan');
const log = require('../../../telemetry/log');

/**
 * Detect PII entities in text via the PII Guard service.
 * Returns { hasPii, entities[] } or null when:
 *   - the guard isn't installed (configStore `pii_guard_url` is unset), or
 *   - the guard is unreachable / returns an error.
 *
 * Either failure mode fails open — the chat path still completes. The
 * admin UI surfaces guard-not-installed state on the Privacy Shield page.
 *
 * A category list holding "Your own data" ids (cdt_…) takes its own branch,
 * customTypes/scan.js: those types run in Node and/or as the guard's
 * custom_labels, and the answer is merged into one disjoint entity list. That
 * branch can answer `{ …, guardAbsent: true }` instead of null: no guard, but
 * the org's own words/patterns were found. A list without custom ids never
 * leaves this function's original path.
 *
 * opts.customTypes (tests, the test bench): resolve the custom ids against
 * these types instead of the process registry.
 */
async function detectPii(text, enabledCategories = null, confidenceThreshold = DEFAULT_PII_CONFIDENCE_THRESHOLD, opts = {}) {
    if (hasCustomIds(enabledCategories)) {
        const plan = await planScan(enabledCategories, { customTypes: opts?.customTypes });
        if (plan) return detectWithCustomTypes(String(text ?? ''), enabledCategories, confidenceThreshold, plan, opts);
    }
    return _detectBuiltIn(text, enabledCategories, confidenceThreshold, opts);
}

/** Today's path: built-in categories only, exactly as before custom types. */
async function _detectBuiltIn(text, enabledCategories, confidenceThreshold, opts) {
    // 'bulk' de-prioritises this scan behind interactive chat traffic — see the
    // two-queue admission control above. Document/background callers pass it.
    const priority = opts?.priority === 'bulk' ? 'bulk' : 'interactive';
    // Windowed scans of a big paste take minutes, not milliseconds. A caller
    // that can show the user where it has got to passes this; it fires once
    // per completed window with { done, total, coveredChars, totalChars }.
    const onProgress = typeof opts?.onProgress === 'function' ? opts.onProgress : null;
    const guardEndpoint = await getGuardEndpoint();
    if (!guardEndpoint.url) {
        // Guard not installed → the feature is simply off. Return null so
        // callers fail open (nothing to detect with). Distinct from the
        // "installed but couldn't scan" case below.
        log.info('[PiiDetection] guard endpoint not configured — install the PII Guard service to activate detection');
        return null;
    }

    // One structured completion line per scan. The guard's `pii.scan` line
    // measures the guard's side of the wire; this measures the caller's —
    // including cache hits and coalesced joins, which never reach the guard at
    // all. Same privacy stance: counts and durations only, never text.
    const _t0 = Date.now();
    const _log = (how, r) => log.info(
        `[PiiDetection] pii.client ms=${Date.now() - _t0} chars=${text.length} `
        + `windows=${windowCountFor(text)} `
        + `via=${how} degraded=${!!r?.degraded} reason=${r?.degradedReason || '-'}`,
    );

    // The cache lives HERE so every caller inherits it. It used to sit only in
    // validateInput/OutputForPii, which meant the interactive DLP chat path —
    // the one on time-to-first-token — re-paid a full guard round trip for
    // every identical scan (a regenerate, a retry, the same tool payload in
    // two lanes). Checked before the circuit breaker on purpose: a cached
    // entry was a SUCCESSFUL scan within TTL and stays valid while the guard
    // itself is having a bad ten seconds.
    const key = cacheKey('detect', text, enabledCategories, confidenceThreshold);
    const cached = cacheGet(key);
    if (cached) {
        _log('cache', cached);
        return _cloneScanResult(cached);
    }

    // Identical scan already in flight → join it rather than re-sending.
    const inflight = _inflightScans.get(key);
    if (inflight) {
        return inflight.then((r) => {
            _log('coalesced', r);
            return _cloneScanResult(r);
        });
    }

    const scan = (async () => {
        // Configured but known-bad: answer immediately rather than making the
        // user wait out another 90s timeout to be told the same thing. Still
        // degraded, so the caller's fail-open/closed policy is unchanged —
        // only the latency is.
        if (circuitIsOpen()) {
            log.warn('[PiiDetection] guard circuit open — short-circuiting to degraded');
            return { hasPii: false, entities: [], degraded: true, degradedReason: 'guard_circuit_open' };
        }
        try {
            const result = text.length > MAX_REQUEST_CHARS
                ? await detectPiiWindowed(text, enabledCategories, confidenceThreshold, guardEndpoint, priority, onProgress)
                : await detectPiiViaCpuModel(text, enabledCategories, confidenceThreshold, guardEndpoint, priority);
            noteGuardSuccess();
            return result;
        } catch (err) {
            // Installed but unreachable/errored — this is NOT the same as "no
            // PII". Return a degraded result (no entities) so policy-enforcing
            // callers (validateInputForPii, dlpRunner.scan) can fail closed
            // instead of silently sending unmasked text (BFSF-269). Secondary
            // callers guard on `?.hasPii`, so they still treat this as clean
            // (fail open).
            noteGuardFailure();
            log.warn('[PiiDetection] guard-service unavailable:', err.message);
            return { hasPii: false, entities: [], degraded: true, degradedReason: `guard_unreachable: ${err.message}` };
        }
    })();

    _inflightScans.set(key, scan);
    try {
        const result = await scan;
        // Degraded is never cached (same rule as validateInputForPii): a
        // failure must not be replayed for 5 minutes, and a retry should get
        // a fresh chance the moment the guard recovers.
        if (result && !result.degraded) cacheSet(key, result);
        _log('guard', result);
        // The cache keeps the pristine copy; every caller — including the
        // first — gets its own clone.
        return _cloneScanResult(result);
    } finally {
        _inflightScans.delete(key);
    }
}

module.exports = { detectPii };
