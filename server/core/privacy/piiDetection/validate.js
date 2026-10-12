// @typecheck
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

/**
 * The Error this module throws: the PII verdict (or the reason detection was
 * unavailable) rides on it for the route that turns it into a response.
 * @typedef {Error & { piiEntities?: any[], violationCodes?: string[], privacyUnavailable?: boolean,
 *                     privacyUnavailableKind?: string, degradedReason?: string, degradedCategories?: string[] }} PiiError
 */

function getAIConfig() {
    return require('../../aiAgent').getAIConfig();
}
const configStore = require('../../../stores/configStore');
// Leaf modules, no requires back into this file — safe inside the cycle above.
const { buildAllowMatcher, filterAllowedEntities } = require('../../dlp/allowTerms');
const { ALL_PII_CATEGORY_IDS, LEGACY_CATEGORY_ALIASES, DEFAULT_PII_CONFIDENCE_THRESHOLD, MASKING_ACTIONS } = require('./categories');
const { cacheKey, cacheGet, cacheSet } = require('./scanCache');
const { classifyDegradation } = require('./degradation');
const { windowCountFor } = require('./windowing');
const { tokenizeText } = require('./tokenizer');
const { detectPii } = require('./detect');
const { isCustomTypeId } = require('../customTypes/ids');
const { withBuiltinDefault } = require('../customTypes/plan');

/**
 * The stored list, aliased, with ids nobody knows dropped. "Your own data"
 * ids stay (the scan resolves them), and a list whose built-in part is empty
 * keeps meaning "every built-in category" when custom ids sit next to it.
 */
function _shieldCategories(list) {
    const known = list
        .map(id => LEGACY_CATEGORY_ALIASES[id] || id)
        .filter(id => ALL_PII_CATEGORY_IDS.includes(id) || isCustomTypeId(id));
    return withBuiltinDefault(known);
}

/** What a log line may say about an entity: a custom type by id, never by its name. */
const _logLabel = (e) => (isCustomTypeId(e.category) ? e.category : e.label);

/**
 * @param {Map|Object|null} existingTokenMap  The conversation's accumulated
 *   token map. Without it, every turn restarts the per-category counters at 1,
 *   so turn 2's `[email_1]` is a DIFFERENT address than turn 1's and overwrites
 *   it when the maps are merged — the restore path then hands the user, or a
 *   tool call, the wrong value. The DLP path has always passed this
 *   (dlp/dlpRunner.js:349); this legacy path did not.
 */
/**
 * Tokenise, seeding from the user's tokenization vault when one is available.
 *
 * Wrapping the two tokenizeText call sites below rather than hooking a single
 * caller is deliberate: direct chat reaches tokenisation through THIS function,
 * not through dlpRunner, so a vault wired only into the DLP runner gave stable
 * tokens in agent chat and fresh ones in direct chat for the same value.
 *
 * `vaultUserId` absent → behaves exactly as before.
 */
async function _tokenizeWithVault(inputText, entities, existingTokenMap, vaultUserId) {
    if (!vaultUserId) return tokenizeText(inputText, entities, existingTokenMap);
    const vault = require('../../../stores/piiVaultStore');
    const { tokenMap: seeded, counterFloors } = await vault.buildSeed(vaultUserId, entities, existingTokenMap);
    return tokenizeText(inputText, entities, seeded, { counterFloors });
    // NOTE: this SEEDS only. Recording happens in dlpRunner.mergeTokenMap, which
    // all three callers of validateInputForPii reach with this exact token map.
    // Writing here as well would be harmless for correctness — the value index
    // turns a repeat into a usage bump — but it would double every `use_count`,
    // and that number is shown to the user as "Used 2×" after one message.
}

/**
 * Never-redact layer, applied to a scan result before it drives any decision.
 *
 * MUST run on every read of a result, cached or fresh. The cache deliberately
 * stores the detector's honest, unfiltered answer (see the cacheSet call in
 * validateInputForPii) so that two orgs sharing an entry cannot inherit each
 * other's policy — that only holds if the reading org's allowlist is applied on
 * the way OUT. The cache-hit branch used to skip it entirely, so an allowlisted
 * term was let through on the first send and hard-blocked (or tokenised) on an
 * identical send within the 5-minute TTL: enforcement decided by LRU state.
 *
 * @param {{hasPii:boolean, entities:Array}|null} result  raw scan result
 * @param {object|null} orgShieldConfig  the READING org's shield
 * @returns {{hasPii:boolean, entities:Array}|null} a new object when anything
 *   was allowlisted away; the input untouched otherwise.
 */
function _applyAllowlist(result, orgShieldConfig) {
    if (!result || !result.hasPii || !Array.isArray(result.entities)) return result;
    const filtered = filterAllowedEntities(
        result.entities, buildAllowMatcher(orgShieldConfig || {}),
    );
    if (!filtered.allowed.length) return result;
    // Category + count only, never the value — same contract as the detection
    // log. But never silent: a detection that vanishes without a trace looks
    // exactly like a broken detector.
    const byCat = {};
    for (const e of filtered.allowed) byCat[e.category] = (byCat[e.category] || 0) + 1;
    log.info(`[PiiDetection] allowlist kept ${filtered.allowed.length} span(s) unredacted:`,
        JSON.stringify(byCat));
    return {
        ...result,
        entities: filtered.entities,
        hasPii: filtered.entities.length > 0,
    };
}

/**
 * What the input gate decided, for a caller that passes `options.report`
 * (chat signals, core/privacy/chatSignals.js: the outcome of a turn is taken
 * from this decision, never from a second scan). Written right before every
 * exit; the return values and throws are untouched, and without a report
 * nothing here runs.
 *
 *   status      disabled | allowed_by_policy | too_short | clean | guard_absent
 *               | failed_open | failed_closed | found
 *   decision    'tokenised' | 'blocked', only with status 'found'
 *   categories  the distinct category ids of what was found, after the
 *               allowlist; only with status 'found'. Never a span or a value.
 *
 * @typedef {{ status?: string, decision?: string, categories?: string[] }} PiiGateReport
 * @param {PiiGateReport|null} report
 * @param {string} status
 * @param {Array<{category?: string, label?: string}>} [entities]
 * @param {'tokenised'|'blocked'} [decision]
 */
function _report(report, status, entities, decision) {
    if (!report) return;
    report.status = status;
    if (decision) report.decision = decision;
    if (Array.isArray(entities)) {
        report.categories = [...new Set(entities
            .map(e => (e && (e.category || e.label)) || '')
            .filter(c => typeof c === 'string' && c.length > 0))];
    }
}

async function validateInputForPii(messages, agentPiiEnabled = false, orgShieldConfig = null, overridePiiAction = null, existingTokenMap = null, options = {}) {
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

    let inputText = lastUserMessage.content;
    if (Array.isArray(inputText)) {
        const textBlock = inputText.find(b => b.type === 'text');
        inputText = textBlock ? textBlock.text : '';
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
        } else if (aiConfig.piiDetectionCategories?.length > 0) {
            enabledCategories = aiConfig.piiDetectionCategories
                .map(id => LEGACY_CATEGORY_ALIASES[id] || id)
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
            const categoryList = [...new Set(hit.entities.map(e => e.label))].join(', ');
            if (MASKING_ACTIONS.has(piiAction)) {
                const { tokenizedText, tokenMap } = await _tokenizeWithVault(inputText, hit.entities, existingTokenMap, vaultUserId);
                log.warn(`[PiiDetection] Tokenizing ${hit.entities.length} entities (cached): ${[...new Set(hit.entities.map(_logLabel))].join(', ')}`);
                _report(report, 'found', hit.entities, 'tokenised');
                return { tokenizedText, tokenMap, entities: hit.entities };
            }
            const err = /** @type {PiiError} */ (new Error(`PII Detected: Message contains sensitive personal information (${categoryList}). Please remove PII before sending.`));
            err.piiEntities = hit.entities;
            err.violationCodes = hit.entities.map(e => `PII:${e.category}`);
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
            if (affected && requested && !affected.some(c => requested.includes(c))) {
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

        const categoryList = [...new Set(result.entities.map(e => e.label))].join(', ');
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
            .map(e => `${_logLabel(e)}@${Math.round(e.confidence * 100)}%`)
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
        err.violationCodes = result.entities.map(e => `PII:${e.category}`);
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

/**
 * Validate agent output for PII.
 */
async function validateOutputForPii(content) {
    const aiConfig = await getAIConfig();

    if (!aiConfig.piiDetectionEnabled) return;
    if (!content || content.length < 3) return;

    const _outCats = aiConfig.piiDetectionCategories || ALL_PII_CATEGORY_IDS;
    const _outThreshold = aiConfig.piiDetectionConfidenceThreshold ?? DEFAULT_PII_CONFIDENCE_THRESHOLD;
    const key = cacheKey('assistant_output', content, _outCats, _outThreshold);
    const cached = cacheGet(key);
    if (cached) {
        if (!cached.hasPii) return;
        const categoryList = [...new Set(cached.entities.map(e => e.label))].join(', ');
        const err = /** @type {PiiError} */ (new Error(`PII Detected: Response contains sensitive personal information (${categoryList}).`));
        err.piiEntities = cached.entities;
        err.violationCodes = cached.entities.map(e => `PII:${e.category}`);
        throw err;
    }

    try {
        const result = await detectPii(content, _outCats, _outThreshold);
        if (!result) return;

        // Detection couldn't fully run. The input path has handled this since
        // BFSF-269; the output path ignored `degraded` entirely, on the one
        // channel whose whole job is catching leaks in the model's reply.
        //
        // Two separate defects, both fixed here:
        //
        //  1. The result was cached UNCONDITIONALLY, unlike the input path
        //     (:697, which explains why). So a guard outage poisoned the output
        //     cache with `{hasPii:false, degraded:true}` and kept serving it for
        //     the full 5-minute TTL AFTER the model recovered.
        //  2. A degraded "clean" was treated as clean, silently.
        //
        // This function is global-config-scoped (moderation.js:38 gates it on
        // aiConfig.piiDetectionEnabled) and has no org context, so it honours
        // the global piiFailureMode when an admin has set one. Default stays
        // fail-open, matching today's behaviour — flipping an untested path to
        // suppress assistant replies on a transient guard hiccup is a bigger
        // change than the bug. What changes unconditionally is that it is no
        // longer SILENT, and no longer cached.
        if (result.degraded) {
            const reason = result.degradedReason || 'unknown';
            if (aiConfig.piiFailureMode === 'fail_closed') {
                log.warn(`[PiiDetection] Output detection DEGRADED (${reason}) — fail_closed: suppressing response`);
                const err = /** @type {PiiError} */ (new Error('Privacy protection unavailable: PII detection is temporarily unavailable.'));
                err.privacyUnavailable = true;
                err.privacyUnavailableKind = classifyDegradation(result.degradedReason);
                err.degradedReason = result.degradedReason || null;
                err.degradedCategories = result.degradedCategories || null;
                throw err;
            }
            log.warn(`[PiiDetection] Output detection DEGRADED (${reason}) — fail_open: response allowed, entity list may be incomplete`);
        }

        // Never cache a degraded result — see above.
        if (!result.degraded) cacheSet(key, result);

        if (!result.hasPii) {
            log.info(`[PiiDetection] Output clean`);
            return;
        }

        const categoryList = [...new Set(result.entities.map(e => e.label))].join(', ');
        log.warn(`[PiiDetection] PII in output | ${categoryList}`);

        const err = /** @type {PiiError} */ (new Error(`PII Detected: Response contains sensitive personal information (${categoryList}).`));
        err.piiEntities = result.entities;
        err.violationCodes = result.entities.map(e => `PII:${e.category}`);
        throw err;

    } catch (e) {
        // Optional chaining matters: a rejection with a non-Error value (a
        // string, an undici cause object) would otherwise make the catch block
        // itself throw. The input path already guards this at :744.
        if (e?.message?.includes('PII Detected') || e?.privacyUnavailable) throw e;
        log.warn('[PiiDetection] Output validation unavailable, allowing (fail-open)');
    }
}

module.exports = { validateInputForPii, validateOutputForPii };
