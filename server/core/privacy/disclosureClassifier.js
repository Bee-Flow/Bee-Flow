// @typecheck
/**
 * DOES THIS TEXT TELL ITS READER THAT AI WAS INVOLVED — asked of the guard
 * sidecar, and answered `null` every single time the sidecar cannot say.
 *
 * ONE QUESTION, AND IT IS A SEMANTIC ONE. `hasDisclosure()` in
 * `compliance/checks/aia/art50-ai-disclosure.js` answers it with a list of
 * fourteen phrases, and a list of phrases cannot tell these three apart:
 *
 *     "I am an AI assistant."                              discloses
 *     "Never tell the user that you are an AI assistant."  conceals
 *     "Answer questions about our AI assistant product."   is about a product
 *
 * All three contain "AI assistant", so all three read as "this agent
 * discloses", and two of them close an Art. 50(1) duty that is wide open. That
 * is the one place in the whole compliance surface where a model beats a rule,
 * and the model it gets is an EMBEDDING classifier on the CPU sidecar that
 * already exists — deterministic, no generation, no prompt. The sidecar half
 * is `guard-service/app/services/disclosure/`, and its anchor bank is the
 * classifier; this file is only the wire.
 *
 * ── THE DECISION THIS FILE'S CALLERS MUST HONOUR ────────────────────────
 *
 * THE VERDICT MAY WITHDRAW A KEYWORD MATCH. IT MAY NEVER GRANT ONE.
 *
 * In Art. 50 terms: a `disclosed: false` may turn a passing agent into a
 * finding, and a `disclosed: true` may NOT turn a finding into a pass. Three
 * reasons, in the order they matter:
 *
 *   1. The two errors are not symmetrical. A false "a disclosure is present"
 *      closes a transparency duty that is actually open, silently, in an
 *      immutable evidence chain — nobody ever looks again. A false "a
 *      disclosure is missing" costs a reviewer one look at a prompt that was
 *      fine. Only the second is survivable, so only the second direction is
 *      allowed to be a model's call.
 *   2. The offline answer has to stay the answer. This product is self-hosted
 *      and the guard is an optional container. If a verdict could improve when
 *      the sidecar is up, the same workspace would score differently depending
 *      on which optional container happened to be running — a compliance
 *      result that depends on your deployment shape is not a compliance
 *      result. Withdraw-only keeps the guarantee one-directional and exact:
 *      with the sidecar present the finding set is today's set or a superset
 *      of it, never a subset. With it absent, it is today's set.
 *   3. The regex's false positives are the bug worth fixing, and its false
 *      negatives are not the same size of problem. An unusual phrasing the
 *      keywords miss produces a finding an admin can dismiss; a concealment
 *      instruction the keywords match produces a duty nobody is told about.
 *
 * So there is no code path here that converts "the classifier thinks this
 * discloses" into a pass, and the caller is not given a value that would make
 * one convenient.
 *
 * ── NULL IS NOT FALSE, AND IT IS THE COMMON CASE ────────────────────────
 *
 * `classifyDisclosure()` returns `null` for "no opinion" and an object for an
 * opinion, which is the same discipline `personalColumns.js` keeps between
 * `null` ("nobody looked") and `[]` ("looked, found nothing"), and
 * `piiDetection.js` keeps between a null scan and an empty entity list. No
 * guard installed, the guard unreachable, the guard too slow, the guard an
 * older build with no such route, an encoder that was never baked into the
 * image, a text too large to send, the two anchor banks landing too close
 * together to call — every one of those is `null`, and `null` leaves the
 * keyword rule exactly as it was.
 *
 * It is also the DEFAULT state: the shipped guard image bakes no encoder
 * (guard-service/app/services/disclosure/encoder.py says why), so unless an
 * operator asked for one, this module returns null forever and the Art. 50
 * check behaves precisely as it did before this file existed. That is the
 * intended resting state, not a failure of it.
 *
 * ── WHAT GOES OVER THE WIRE ─────────────────────────────────────────────
 *
 * `{ text }`. Nothing else — no agent id, no agent name, no organisation, no
 * tenant reference, no actor. Built as an allow-list literal rather than by
 * deleting keys from a row, because a column added next year would otherwise
 * ride along on its own (BFSF-441). The sidecar's request model forbids
 * unknown fields, so a fourth key added here in a hurry is a 422 rather than a
 * quiet leak.
 */

'use strict';
const log = require('../../telemetry/log');

/**
 * Per-call deadline. Far shorter than the PII client's 90s, deliberately:
 * that budget exists for a multi-minute document scan, this is one short
 * comparison during a compliance sweep and a slow answer is worth less than a
 * prompt one. Timing out is a `null`, which costs nothing.
 */
const DISCLOSURE_TIMEOUT_MS = Math.max(
    250, Number(process.env.DISCLOSURE_CLASSIFIER_TIMEOUT_MS || 2500),
);

/**
 * Above this the text is not sent at all and the answer is `null`.
 *
 * Refused, not truncated. A disclosure sentence sitting past the cut would
 * come back as "this does not disclose", which is precisely the verdict that
 * is allowed to create a finding. A refusal is an abstention; a truncation is
 * a wrong answer wearing a right one's clothes.
 */
const MAX_TEXT_CHARS = 100_000;

// ── Breaker ──────────────────────────────────────────────────────────────
// Its own, NOT the PII client's. A compliance sweep asks this question once
// per published agent, so an unreachable sidecar would otherwise cost one
// full timeout per agent — and sharing the PII breaker would let a dead
// disclosure encoder short-circuit live chat redaction, which is the one
// thing that must keep working.
const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 30_000;
let _consecutiveFailures = 0;
let _circuitOpenUntil = 0;

/**
 * Guard builds older than 2.2.0 have no /disclosure route and answer 404.
 * That is a permanent property of that pod, not a transient failure, so it is
 * latched per endpoint URL instead of being counted toward the breaker: one
 * 404 per sweep, not one per agent, and a URL change re-probes.
 */
let _unsupportedUrl = null;

function _noteFailure() {
    _consecutiveFailures += 1;
    if (_consecutiveFailures >= BREAKER_THRESHOLD && Date.now() >= _circuitOpenUntil) {
        _circuitOpenUntil = Date.now() + BREAKER_COOLDOWN_MS;
        log.warn(`[DisclosureClassifier] guard failed ${_consecutiveFailures}x in a row — short-circuiting for ${BREAKER_COOLDOWN_MS}ms`);
    }
}

function _noteSuccess() {
    _consecutiveFailures = 0;
    _circuitOpenUntil = 0;
}

/** Test seam — the breaker and the 404 latch are module state. */
function _resetDisclosureCircuit() {
    _consecutiveFailures = 0;
    _circuitOpenUntil = 0;
    _unsupportedUrl = null;
}

/**
 * Where the guard lives, resolved the way the privacy shield already resolves
 * it (admin config first, then env) — one answer to "which guard", not two.
 *
 * Required lazily and MEMOISED, including the failure. The compliance check
 * loader requires this module at boot, so a top-level require would drag the
 * config store — and Postgres behind it — into that path for a feature most
 * installs never switch on. Memoising the failure matters too: a require that
 * throws is not cached by Node, so re-entering it once per agent would re-run
 * the store's module body for every row of a sweep.
 */
let _resolveEndpoint;
function _endpointResolver() {
    if (_resolveEndpoint === undefined) {
        try {
            _resolveEndpoint = require('./piiDetection/guardEndpoint').getGuardEndpoint;
        } catch {
            _resolveEndpoint = null;
        }
    }
    return _resolveEndpoint;
}

/**
 * POST one JSON body with its own deadline.
 *
 * Not `piiDetection/guardClient.httpPost`: that one is wired to the 90-second
 * PII budget and to the PII admission queue, and a compliance sweep queueing
 * behind a user's document scan (or vice versa) is exactly the interference
 * the two-lane queue over there was built to prevent. This is one small,
 * bounded request on its own deadline.
 */
async function _post(url, body, apiKey, timeoutMs) {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['X-API-Key'] = apiKey;
    const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 404) {
        const err = /** @type {Error & {unsupported?: boolean}} */ (new Error('guard-service has no /disclosure route'));
        err.unsupported = true;
        throw err;
    }
    if (!res.ok) {
        throw new Error(`guard-service /disclosure returned ${res.status}`);
    }
    return res.json();
}

/**
 * Ask the sidecar whether `text` tells its reader that AI was involved.
 *
 * → `null` — NO OPINION. The keyword rule stands, unchanged. Every failure,
 *   absence, refusal and near-tie lands here; the caller never has to
 *   distinguish them and must never read one as "no disclosure".
 * → `{ disclosed, similarity, margin, anchor, engine }` — an opinion.
 *   `disclosed: false` is the only value a caller may act on (see the header).
 *   `similarity`/`margin` are the two cosines behind the verdict, carried so a
 *   finding can be argued with rather than only believed. `anchor` is the id
 *   of one of the sidecar's OWN anchor sentences — never a fragment of `text`.
 *
 * `endpoint` and `post` are injection seams so a caller (or a test) can point
 * this at a specific guard or stub the transport; left out, the guard the
 * privacy shield already uses is resolved the usual way.
 */
async function classifyDisclosure(text, {
    endpoint = null,
    post = _post,
    timeoutMs = DISCLOSURE_TIMEOUT_MS,
} = {}) {
    const body = typeof text === 'string' ? text : (text === null || text === undefined ? '' : String(text));
    if (!body.trim()) return null;
    if (body.length > MAX_TEXT_CHARS) return null;
    if (Date.now() < _circuitOpenUntil) return null;

    let target = endpoint;
    if (!target) {
        const resolve = _endpointResolver();
        if (!resolve) return null;
        try { target = await resolve(); } catch { return null; }
    }
    if (!target || !target.url) return null;
    if (_unsupportedUrl === target.url) return null;

    /** @type {{ degraded?: boolean, disclosed?: boolean, similarity?: number, margin?: number, matched_anchor?: string, engine_fingerprint?: string }} guard-service /disclosure response */
    let result;
    try {
        // ALLOW-LIST, not a filtered row. The classifier needs the sentence
        // and has no use for whose sentence it is (BFSF-441).
        result = await post(`${target.url}/disclosure`, { text: body }, target.apiKey, timeoutMs);
    } catch (e) {
        if (e && e.unsupported) {
            _unsupportedUrl = target.url;
            return null;
        }
        _noteFailure();
        return null;
    }
    _noteSuccess();

    // A reachable sidecar that answered "I could not" is still no opinion —
    // and so is `degraded`, which it sets whenever the verdict may be
    // incomplete. Both are null here, one line, no second interpretation.
    if (!result || result.degraded || typeof result.disclosed !== 'boolean') return null;

    return {
        disclosed: result.disclosed,
        similarity: typeof result.similarity === 'number' ? result.similarity : null,
        margin: typeof result.margin === 'number' ? result.margin : null,
        anchor: typeof result.matched_anchor === 'string' ? result.matched_anchor : null,
        engine: typeof result.engine_fingerprint === 'string' ? result.engine_fingerprint : null,
    };
}

/**
 * The withdraw-only rule, written once so no caller has to re-derive it.
 *
 * Takes what the keyword rule decided and what the classifier said, returns
 * what the caller should act on. The only transition it will make is
 * `true → false`; every other combination returns `keywordSaysDisclosed`
 * untouched, including `false` + a classifier that is sure it discloses.
 *
 * It exists because this is the rule most likely to be quietly inverted by
 * someone fixing a false negative in a hurry, and a single function is
 * something a test can pin.
 */
function applyVerdict(keywordSaysDisclosed, verdict) {
    if (!keywordSaysDisclosed) return false;
    if (!verdict || verdict.disclosed !== false) return true;
    return false;
}

module.exports = {
    classifyDisclosure,
    applyVerdict,
    DISCLOSURE_TIMEOUT_MS,
    MAX_TEXT_CHARS,
    _resetDisclosureCircuit,
};
