// @typecheck strict
/**
 * The policy gates — validateInputForPii and validateOutputForPii: resolve the
 * org's categories and threshold, scan, apply the never-redact allowlist, then
 * tokenise, block, or fail open/closed on a degraded result.
 */

// Circular dep: piiDetection ← aiAgent ← agentStore ← ... ← piiDetection.
// During the cycle aiAgent.js does `module.exports = { ... }` at the END
// (full object replacement). If we capture `require('../aiAgent')` at module
// load, we get a snapshot of the EMPTY pre-cycle exports object that never
// gets updated — `module.exports = {...}` rebinds the new object in the
// require cache but our captured reference points at the abandoned old one.
// Calling `require('../aiAgent')` fresh on each invocation fetches the
// up-to-date cached exports from Node's module cache. By the time
// validateInputForPii runs (request time, not load time) aiAgent has long
// finished initialising.
const log = require('../../../telemetry/log');
const { getAIConfig, _shieldCategories, _logLabel, _tokenizeWithVault, _applyAllowlist, _report, validateOutputForPii } = require('./validateOutput');

/**
 * The Error this module throws: the PII verdict (or the reason detection was
 * unavailable) rides on it for the route that turns it into a response.
 * @typedef {Error & { piiEntities?: any[], violationCodes?: string[], privacyUnavailable?: boolean,
 *                     privacyUnavailableKind?: string, degradedReason?: string, degradedCategories?: string[] }} PiiError
 */

/**
 * @typedef {import('./validateOutput').PiiGateReport} PiiGateReport
 * @typedef {import('./validateOutput').PiiEntity} PiiEntity
 */

const configStore = require('../../../stores/configStore');
// Leaf modules, no requires back into this file — safe inside the cycle above.
const { ALL_PII_CATEGORY_IDS, LEGACY_CATEGORY_ALIASES, DEFAULT_PII_CONFIDENCE_THRESHOLD, MASKING_ACTIONS } = require('./categories');
const { cacheKey, cacheGet, cacheSet } = require('./scanCache');
const { classifyDegradation } = require('./degradation');
const { windowCountFor } = require('./windowing');
const { detectPii } = require('./detect');

async function validateInputForPii(/** @type {Array<{ role?: string, content?: string | Array<{ type?: string, text?: string }> | null, [k: string]: unknown }>} */ messages, agentPiiEnabled = false, /** @type {{ enabled?: boolean, piiDetectionAction?: string, piiFailureMode?: string, [k: string]: unknown } | null} */ orgShieldConfig = null, /** @type {string | null} */ overridePiiAction = null, /** @type {Record<string, string> | null} */ existingTokenMap = null, /** @type {{ vaultUserId?: string | null, report?: PiiGateReport | null, onProgress?: (progress: { done: number, total: number, coveredChars: number, totalChars: number }) => void, [k: string]: unknown }} */ options = {}) {
    const vaultUserId = options.vaultUserId || null;
    /** @type {PiiGateReport|null} */
    const report = options.report && typeof options.report === 'object' ? options.report : null;
    const aiConfig = await getAIConfig();

    // Loud entry trace so admins can see PII gates firing in logs.
    log.info(`[PiiDetection] validateInputForPii called: agentPiiEnabled=${agentPiiEnabled} aiCfgEnabled=${!!aiConfig.piiDetectionEnabled} shield={enabled:${!!orgShieldConfig?.enabled}, action:${orgShieldConfig?.piiDetectionAction || 'default'}}`);

    // PII detection switches on if any of:
    //   1. Global AI config flag (admin-set via /ai/config)
    //   2. Per-agent override (rare; specific agent configs)
    //   3. Org Privacy Shield's master `enabled` flag — the only switch a
    //      non-developer typically uses, exposed at /app/settings/organisation/privacy
    const piiEnabled =
        aiConfig.piiDetectionEnabled ||
        agentPiiEnabled ||
        !!orgShieldConfig?.enabled;
    if (!piiEnabled) {
        log.info('[PiiDetection] gate=DISABLED (aiConfig + agent + shield all off)');
        _report(report, 'disabled');
        return null;
    }

    // overridePiiAction lets a trusted internal flow set the action per-call
    // (takes precedence over org/AI config). The support auto-responder passes
    // 'allow' — a support reply is legitimate first-party processing of the
    // customer's OWN email (their address/IBAN/order ids), so it must not be
    // hard-blocked. 'allow' short-circuits before any scan/block/tokenize.
    const piiAction = overridePiiAction || orgShieldConfig?.piiDetectionAction || aiConfig.piiDetectionAction || 'block';
    if (piiAction === 'allow') {
        log.info('[PiiDetection] gate=ALLOW (per-call override) — skipping scan');
        _report(report, 'allowed_by_policy');
        return null;
    }

    // Failure policy when detection can't fully run (guard unreachable or the
    // GLiNER model isn't ready → regex-only). Default fail_closed so we never
    // silently send unmasked text to the LLM (BFSF-269). Per-org overridable.
    const piiFailureMode =
        orgShieldConfig?.piiFailureMode ||
        aiConfig.piiFailureMode ||
        'fail_closed';

    const lastUserMessage = messages.slice().reverse().find(m => m.role === 'user');
    if (!lastUserMessage) {
        log.info('[PiiDetection] no user message in batch');
        _report(report, 'too_short');
        return null;
    }

    const rawContent = lastUserMessage.content;
    /** @type {string | null | undefined} */
    let inputText;
    if (Array.isArray(rawContent)) {
        const textBlock = rawContent.find(b => b.type === 'text');
        inputText = textBlock ? textBlock.text : '';
    } else {
        inputText = rawContent;
    }
    if (!inputText || inputText.length < 3) {
        log.info(`[PiiDetection] input too short (${inputText?.length || 0} chars), skipping`);
        _report(report, 'too_short');
        return null;
    }

    // ── Load enabled categories & confidence threshold
    // Priority: 1) Passed-in org shield config (callers already resolved the correct org)
    //           2) Fallback: scan configStore for any org shield (legacy/generic callers)
    //           3) Global AI config categories
    //           4) All categories (default)
    let enabledCategories = ALL_PII_CATEGORY_IDS;
    let confidenceThreshold = aiConfig.piiDetectionConfidenceThreshold ?? DEFAULT_PII_CONFIDENCE_THRESHOLD;
    try {
        const shieldConfig = orgShieldConfig || await (async () => {
            // Legacy fallback for callers that don't resolve a shield themselves.
            //
            // This used to be `.find(...)` — the FIRST key in an unordered
            // object. On a single-org install that is the right shield by
            // accident; on a multi-tenant install it applies an ARBITRARY
            // org's categories and threshold to another org's scan. Narrowing
            // org B's scan to org A's category list is silent under-detection
            // in a privacy control, and it is invisible in the logs because
            // the line below reports a perfectly plausible category count.
            //
            // So: only fall back when the answer is unambiguous. Same guard
            // directChat.js already applies at :1528 and :2126.
            /** @type {Record<string, { piiDetectionCategories?: unknown, piiDetectionConfidenceThreshold?: unknown } | undefined>} */
            const allConfigs = await configStore.getAllConfig() || {};
            const shieldKeys = Object.keys(allConfigs).filter(k => k.startsWith('org_privacy_shield_'));
            if (shieldKeys.length === 1) return allConfigs[shieldKeys[0]];
            if (shieldKeys.length > 1) {
                log.warn(`[PiiDetection] ${shieldKeys.length} org shields stored and no orgShieldConfig passed — refusing to guess; scanning ALL categories. The caller should resolve the shield (orgShield.resolveShieldFor).`);
            }
            return null;
        })();
        if (shieldConfig) {
            if (Array.isArray(shieldConfig.piiDetectionCategories) && shieldConfig.piiDetectionCategories.length > 0) {
                enabledCategories = _shieldCategories(shieldConfig.piiDetectionCategories);
            }
            if (typeof shieldConfig.piiDetectionConfidenceThreshold === 'number') {
                confidenceThreshold = shieldConfig.piiDetectionConfidenceThreshold;
            }
            log.info(`[PiiDetection] Using org shield: ${enabledCategories.length}/${ALL_PII_CATEGORY_IDS.length} categories (Email=${enabledCategories.includes('Email')}), confidence ≥ ${confidenceThreshold}`);
        } else if (aiConfig.piiDetectionCategories && aiConfig.piiDetectionCategories.length > 0) {
            const aliases = /** @type {Record<string, string>} */ (LEGACY_CATEGORY_ALIASES);
            enabledCategories = aiConfig.piiDetectionCategories
                .map(id => aliases[id] || id)
                .filter(id => ALL_PII_CATEGORY_IDS.includes(id));
            log.info(`[PiiDetection] Using AI config: ${enabledCategories.length}/${ALL_PII_CATEGORY_IDS.length} categories, confidence ≥ ${confidenceThreshold}`);
        } else {
            log.info(`[PiiDetection] No org shield found, using all ${ALL_PII_CATEGORY_IDS.length} categories`);
        }
    } catch (shieldErr) {
        log.warn(`[PiiDetection] Could not load org shield:`, shieldErr.message);
    }

    // Check cache. The key includes the resolved categories + threshold, so a
    // shield change takes effect immediately instead of after the TTL, and a
    // narrow scan's result can never be served to an all-categories caller.
    const key = cacheKey('user_input', inputText, enabledCategories, confidenceThreshold);
    const cached = cacheGet(key);
    if (cached) {
        // The entry holds the detector's raw answer; org POLICY is applied per
        // read, exactly as on the fresh path below — otherwise an allowlisted
        // term blocks or not depending on whether an identical message is still
        // in the LRU.
        const hit = _applyAllowlist(cached, orgShieldConfig);
        log.info(`[PiiDetection] Cache hit → ${hit.hasPii ? 'PII found' : 'clean'}`);
        if (hit.hasPii) {
            const categoryList = [...new Set(hit.entities.map((/** @type {PiiEntity} */ e) => e.label))].join(', ');
            if (MASKING_ACTIONS.has(piiAction)) {
                const { tokenizedText, tokenMap } = await _tokenizeWithVault(inputText, hit.entities, existingTokenMap, vaultUserId);
                log.warn(`[PiiDetection] Tokenizing ${hit.entities.length} entities (cached): ${[...new Set(hit.entities.map(_logLabel))].join(', ')}`);
                _report(report, 'found', hit.entities, 'tokenised');
                return { tokenizedText, tokenMap, entities: hit.entities };
            }
            const err = /** @type {PiiError} */ (new Error(`PII Detected: Message contains sensitive personal information (${categoryList}). Please remove PII before sending.`));
            err.piiEntities = hit.entities;
            err.violationCodes = hit.entities.map((/** @type {PiiEntity} */ e) => `PII:${e.category}`);
            _report(report, 'found', hit.entities, 'blocked');
            throw err;
        }
        _report(report, 'clean');
        return null;
    }

    log.info(`[PiiDetection] Scanning input (${inputText.length} chars, ${windowCountFor(inputText)} window(s))...`);
    const start = Date.now();

    try {
        // options.onProgress lets the chat runtimes report "part 3/6" while a
        // multi-window scan runs — minutes of otherwise silent wait.
        let result = await detectPii(inputText, enabledCategories, confidenceThreshold, { onProgress: options.onProgress });
        if (!result) { _report(report, 'guard_absent'); return null; } // Guard not installed → feature off, fail open
        // No guard, but the org's own words/patterns ran in Node: same
        // fail-open as null for what the guard would have found, and the
        // custom matches are still acted on below.
        if (result.guardAbsent && !result.hasPii) { _report(report, 'guard_absent'); return null; }

        // Detection couldn't fully run (guard unreachable, or the GLiNER model
        // isn't ready so only the regex tier answered). Trusting this would
        // under-redact — apply the org failure policy (BFSF-269).
        if (result.degraded) {
            // Does the degradation actually touch what THIS caller asked for?
            //
            // The guard reports which categories lost coverage when it can (a
            // label group whose every inference call raised). Under model-only
            // it runs 7 label groups instead of 4, so a transient ORT error is
            // meaningfully more likely per request AND degrades the whole
            // response — without this check an org scoped to {Email,
            // PhoneNumber} gets blocked because the government-id group died,
            // for a category it never asked about. That org previously never
            // touched the model at all and could never fail closed.
            //
            // Absent/empty degradedCategories means "unknown — assume all"
            // (older guard, or an oversize partial scan whose unscanned tail
            // can hide anything), which preserves the old behaviour exactly.
            const affected = result.degradedCategories;
            const requested = Array.isArray(enabledCategories) && enabledCategories.length
                ? enabledCategories : null;
            if (affected && requested && !affected.some((/** @type {string} */ c) => requested.includes(c))) {
                log.warn(`[PiiDetection] Detection DEGRADED (${result.degradedReason || 'unknown'}) but only for [${affected.join(', ')}], none of which this scope requested — continuing with the result`);
            } else if (piiFailureMode === 'fail_open') {
                log.warn(`[PiiDetection] Detection DEGRADED (${result.degradedReason || 'unknown'}) — fail_open: allowing content UNMASKED`);
                _report(report, 'failed_open');
                return null;
            } else {
                log.warn(`[PiiDetection] Detection DEGRADED (${result.degradedReason || 'unknown'}) — fail_closed: blocking message`);
                const kind = classifyDegradation(result.degradedReason);
                const err = /** @type {PiiError} */ (new Error(kind === 'too_large'
                    ? 'Privacy protection unavailable: this message is too large to scan for personal data. Please split it into smaller parts.'
                    : 'Privacy protection unavailable: PII detection is temporarily unavailable. Please try again shortly.'));
                err.privacyUnavailable = true;
                err.privacyUnavailableKind = kind;
                err.degradedReason = result.degradedReason || null;
                err.degradedCategories = affected || null;
                _report(report, 'failed_closed');
                throw err;
            }
        }

        const ms = Date.now() - start;

        // NEVER cache a degraded result. Most degraded paths above return or
        // throw, but the "degradation missed this scope" branch deliberately
        // falls through with degraded still true — and caching that would
        // serve an incomplete entity set for the full TTL after the model
        // recovered, silently under-redacting (BFSF-269).
        if (!result.degraded && !result.guardAbsent) cacheSet(key, result);

        // Never-redact layer — deliberately AFTER the cache write. The cache
        // holds the detector's honest answer; the allowlist is per-org POLICY,
        // and two orgs sharing a cache entry must not inherit each other's.
        // The cache-hit branch above applies the identical filter on its way out.
        result = _applyAllowlist(result, orgShieldConfig);

        if (!result.hasPii) {
            log.info(`[PiiDetection] Input clean | ${ms}ms | threshold ≥ ${confidenceThreshold}`);
            // A very common misconfiguration: admin slid the confidence threshold
            // to 0.9+ which filters out almost every detection for short prompts
            // (typical confidence range: 0.70–0.85). Emit a loud hint when the
            // prompt *looks* like it contains PII but the scan came back clean
            // with a high threshold, so operators can diagnose the "PII works on
            // dev but not on customer" class of tickets.
            if (confidenceThreshold >= 0.85) {
                const looksLikeEmail = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(inputText);
                const looksLikePhone = /(?:\+?\d[\s-]?){8,}/.test(inputText);
                const looksLikeIban  = /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/.test(inputText);
                const looksLikePii   = looksLikeEmail || looksLikePhone || looksLikeIban;
                if (looksLikePii) {
                    const hints = [];
                    if (looksLikeEmail) hints.push('email');
                    if (looksLikePhone) hints.push('phone');
                    if (looksLikeIban) hints.push('IBAN');
                    log.warn(`[PiiDetection] Input contains likely PII (${hints.join(', ')}) but threshold is ${confidenceThreshold}. Detectors typically return 0.70–0.85 confidence for short texts; lower the threshold to 0.70 if you expect detections. (Org Privacy Shield → PII Detection → Confidence Threshold)`);
                }
            }
            _report(report, 'clean');
            return null;
        }

        const categoryList = [...new Set(result.entities.map((/** @type {PiiEntity} */ e) => e.label))].join(', ');
        // Counts, category names and confidences only — never span text.
        //
        // This used to emit `snippets`, up to 20 characters of EVERY detected
        // entity, at warn level. That put the very values this service exists
        // to protect into the server log, where they are shipped to whatever
        // aggregator the deployment uses and outlive the conversation. It also
        // contradicted the guard's own stated policy, which it is careful about
        // (guard-service/app/routers/pii.py:96-99: "Never span text").
        //
        // A per-entity confidence breakdown keeps the diagnostic value that
        // line actually had — "why did this fire / why is it under threshold" —
        // without the payload.
        const breakdown = result.entities
            .map((/** @type {PiiEntity} */ e) => `${_logLabel(e)}@${Math.round((e.confidence ?? 0) * 100)}%`)
            .join(' | ');
        log.warn(`[PiiDetection] PII detected | categories: ${[...new Set(result.entities.map(_logLabel))].join(', ')} | ${result.entities.length} entities | ${ms}ms`);
        log.warn(`[PiiDetection] Confidences: ${breakdown}`);
        log.warn(`[PiiDetection] Action: ${piiAction} (source: ${orgShieldConfig?.piiDetectionAction ? 'org-shield' : aiConfig.piiDetectionAction ? 'ai-config' : 'default'})`);

        if (MASKING_ACTIONS.has(piiAction)) {
            const { tokenizedText, tokenMap } = await _tokenizeWithVault(inputText, result.entities, existingTokenMap, vaultUserId);
            log.warn(`[PiiDetection] Tokenizing — sending redacted text to AI`);
            _report(report, 'found', result.entities, 'tokenised');
            return { tokenizedText, tokenMap, entities: result.entities };
        }

        // Default: block
        const err = /** @type {PiiError} */ (new Error(`PII Detected: Message contains sensitive personal information (${categoryList}). Please remove PII before sending.`));
        err.piiEntities = result.entities;
        err.violationCodes = result.entities.map((/** @type {PiiEntity} */ e) => `PII:${e.category}`);
        _report(report, 'found', result.entities, 'blocked');
        throw err;

    } catch (e) {
        // Propagate deliberate gate outcomes: the PII block and the
        // fail-closed "protection unavailable" block must not be swallowed.
        if (e.message?.includes('PII Detected') || e.privacyUnavailable) throw e;
        log.error('[PiiDetection] Validation failed:', e.message);
        log.warn('[PiiDetection] Service unavailable, allowing content (fail-open)');
        _report(report, 'failed_open');
        return null;
    }
}

module.exports = { validateInputForPii, validateOutputForPii };
