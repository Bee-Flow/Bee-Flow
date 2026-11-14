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
const { getAIConfig, _shieldCategories, _logLabel, _tokenizeWithVault, _applyAllowlist, _report, _warnLikelyPii, validateOutputForPii } = require('./validateOutput');

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
const { inputPolicy, lastUserText, degradedOutsideScope } = require('./inputPolicy.mts');

/** @typedef {NonNullable<Awaited<ReturnType<typeof detectPii>>>} DetectResult */

/**
 * What one gate call carries from step to step.
 * @typedef {{ piiAction: string, piiFailureMode: string, report: PiiGateReport | null, orgShieldConfig: { piiDetectionAction?: string, [k: string]: unknown } | null,
 *             existingTokenMap: Record<string, string> | null, vaultUserId: string | null, aiAction: string | undefined, confidenceThreshold: number }} GateCall
 */

/**
 * The only stored shield, for callers that do not resolve one themselves.
 *
 * Never the FIRST key of the store: on a multi-tenant install that applies an
 * arbitrary org's categories and threshold to another org's scan, a silent
 * under-detection that looks plausible in the logs. So only an unambiguous
 * answer counts (directChat.js applies the same guard).
 * @returns {Promise<{ piiDetectionCategories?: unknown, piiDetectionConfidenceThreshold?: unknown } | null | undefined>}
 */
async function legacyStoredShield() {
    /** @type {Record<string, { piiDetectionCategories?: unknown, piiDetectionConfidenceThreshold?: unknown } | undefined>} */
    const allConfigs = await configStore.getAllConfig() || {};
    const shieldKeys = Object.keys(allConfigs).filter(k => k.startsWith('org_privacy_shield_'));
    if (shieldKeys.length === 1) return allConfigs[shieldKeys[0]];
    if (shieldKeys.length > 1) {
        log.warn(`[PiiDetection] ${shieldKeys.length} org shields stored and no orgShieldConfig passed — refusing to guess; scanning ALL categories. The caller should resolve the shield (orgShield.resolveShieldFor).`);
    }
    return null;
}

/**
 * The categories and confidence threshold to scan with: the passed-in org
 * shield (callers already resolved the right org), else the one stored shield,
 * else the AI config's categories, else all of them.
 * @param {import('../../llm/modelCache').AIConfig} aiConfig
 * @param {{ [k: string]: unknown } | null} orgShieldConfig
 */
async function resolveScanScope(aiConfig, orgShieldConfig) {
    let enabledCategories = ALL_PII_CATEGORY_IDS;
    let confidenceThreshold = aiConfig.piiDetectionConfidenceThreshold ?? DEFAULT_PII_CONFIDENCE_THRESHOLD;
    try {
        const shieldConfig = orgShieldConfig || await legacyStoredShield();
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
    return { enabledCategories, confidenceThreshold };
}

/**
 * The block verdict for a find, reported as blocked.
 * @param {PiiEntity[]} entities
 * @param {PiiGateReport | null} report
 */
function piiBlockedError(entities, report) {
    const categoryList = [...new Set(entities.map((e) => e.label))].join(', ');
    const err = /** @type {PiiError} */ (new Error(`PII Detected: Message contains sensitive personal information (${categoryList}). Please remove PII before sending.`));
    err.piiEntities = entities;
    err.violationCodes = entities.map((e) => `PII:${e.category}`);
    _report(report, 'found', entities, 'blocked');
    return err;
}

/**
 * A cached scan. The entry holds the detector's raw answer; org POLICY (the
 * allowlist) is applied per read, exactly as on the fresh path, or an
 * allowlisted term would block or not depending on the LRU.
 * @param {string} inputText
 * @param {DetectResult} cached
 * @param {GateCall} gate
 */
async function answerFromCache(inputText, cached, gate) {
    const hit = _applyAllowlist(cached, gate.orgShieldConfig);
    log.info(`[PiiDetection] Cache hit → ${hit.hasPii ? 'PII found' : 'clean'}`);
    if (!hit.hasPii) {
        _report(gate.report, 'clean');
        return null;
    }
    if (MASKING_ACTIONS.has(gate.piiAction)) {
        const tokenised = await _tokeniseOrFail(inputText, hit.entities, gate.existingTokenMap, gate.vaultUserId, { piiFailureMode: gate.piiFailureMode, report: gate.report });
        if (!tokenised) return null;
        log.warn(`[PiiDetection] Tokenizing ${hit.entities.length} entities (cached): ${[...new Set(hit.entities.map(_logLabel))].join(', ')}`);
        _report(gate.report, 'found', hit.entities, 'tokenised');
        return { tokenizedText: tokenised.tokenizedText, tokenMap: tokenised.tokenMap, entities: hit.entities };
    }
    throw piiBlockedError(hit.entities, gate.report);
}

/**
 * No guard: under `guardRequired` the scan the org asked for could not
 * happen, which is a refusal; otherwise the feature is off and the text goes
 * on, as it always did.
 * @param {boolean} guardRequired
 * @param {PiiGateReport | null} report
 */
function noGuardAnswer(guardRequired, report) {
    if (guardRequired) {
        log.warn('[PiiDetection] guard not configured — fail_closed: blocking message');
        const err = /** @type {PiiError} */ (new Error('Privacy protection unavailable: the PII Guard service is not installed. Ask your administrator to install it, or to switch the Privacy Shield off.'));
        err.privacyUnavailable = true;
        err.privacyUnavailableKind = 'unavailable';
        err.degradedReason = 'guard_not_installed';
        _report(report, 'failed_closed');
        throw err;
    }
    _report(report, 'guard_absent');
    return null;
}

/**
 * A degraded scan (guard unreachable, or only the regex tier answered):
 * trusting it would under-redact, so the failure policy applies, unless the
 * degradation missed this caller's scope. True: carry on with the result;
 * false: fail open; fail closed throws.
 * @param {DetectResult} result
 * @param {string[]} enabledCategories
 * @param {GateCall} gate
 */
function continueAfterDegraded(result, enabledCategories, gate) {
    const affected = result.degradedCategories;
    const reason = result.degradedReason || 'unknown';
    if (degradedOutsideScope(affected, enabledCategories)) {
        log.warn(`[PiiDetection] Detection DEGRADED (${reason}) but only for [${affected.join(', ')}], none of which this scope requested — continuing with the result`);
        return true;
    }
    if (gate.piiFailureMode === 'fail_open') {
        log.warn(`[PiiDetection] Detection DEGRADED (${reason}) — fail_open: allowing content UNMASKED`);
        _report(gate.report, 'failed_open');
        return false;
    }
    log.warn(`[PiiDetection] Detection DEGRADED (${reason}) — fail_closed: blocking message`);
    const kind = classifyDegradation(result.degradedReason);
    const err = /** @type {PiiError} */ (new Error(kind === 'too_large'
        ? 'Privacy protection unavailable: this message is too large to scan for personal data. Please split it into smaller parts.'
        : 'Privacy protection unavailable: PII detection is temporarily unavailable. Please try again shortly.'));
    err.privacyUnavailable = true;
    err.privacyUnavailableKind = kind;
    err.degradedReason = result.degradedReason || null;
    err.degradedCategories = affected || null;
    _report(gate.report, 'failed_closed');
    throw err;
}

/**
 * The log lines of a find: counts, category names and confidences only, never
 * span text. A per-entity snippet would put the very values this service
 * protects into the server log and every aggregator behind it, against the
 * guard's own policy (guard-service/app/routers/pii.py: "Never span text").
 * @param {{ entities: PiiEntity[] }} result
 * @param {number} ms
 * @param {GateCall} gate
 */
function logFind(result, ms, gate) {
    const breakdown = result.entities
        .map((e) => `${_logLabel(e)}@${Math.round((e.confidence ?? 0) * 100)}%`)
        .join(' | ');
    log.warn(`[PiiDetection] PII detected | categories: ${[...new Set(result.entities.map(_logLabel))].join(', ')} | ${result.entities.length} entities | ${ms}ms`);
    log.warn(`[PiiDetection] Confidences: ${breakdown}`);
    log.warn(`[PiiDetection] Action: ${gate.piiAction} (source: ${gate.orgShieldConfig?.piiDetectionAction ? 'org-shield' : gate.aiAction ? 'ai-config' : 'default'})`);
}

/**
 * A fresh scan, then the verdict.
 * @param {string} inputText
 * @param {string} key  the scan cache key
 * @param {string[]} enabledCategories
 * @param {GateCall & { guardRequired: boolean }} gate
 * @param {((progress: { done: number, total: number, coveredChars: number, totalChars: number }) => void) | undefined} onProgress
 */
async function scanFresh(inputText, key, enabledCategories, gate, onProgress) {
    log.info(`[PiiDetection] Scanning input (${inputText.length} chars, ${windowCountFor(inputText)} window(s))...`);
    const start = Date.now();
    try {
        // onProgress lets the chat runtimes report "part 3/6" while a
        // multi-window scan runs: minutes of otherwise silent wait.
        let result = await detectPii(inputText, enabledCategories, gate.confidenceThreshold, { onProgress });
        // null: the guard is not installed. `guardAbsent` without a find: no
        // guard either, but the org's own words/patterns ran in Node and found
        // nothing (a find is acted on below).
        if (!result || (result.guardAbsent && !result.hasPii)) return noGuardAnswer(gate.guardRequired, gate.report);
        if (result.degraded && !continueAfterDegraded(result, enabledCategories, gate)) return null;

        const ms = Date.now() - start;
        // NEVER cache a degraded result: the "missed this scope" branch falls
        // through with degraded still true, and caching it would serve an
        // incomplete entity set for the full TTL after the model recovered.
        if (!result.degraded && !result.guardAbsent) cacheSet(key, result);
        // The allowlist is per-org POLICY, applied AFTER the cache write: the
        // cache holds the detector's honest answer, and two orgs sharing an
        // entry must not inherit each other's.
        result = _applyAllowlist(result, gate.orgShieldConfig);
        if (!result.hasPii) {
            log.info(`[PiiDetection] Input clean | ${ms}ms | threshold ≥ ${gate.confidenceThreshold}`);
            _warnLikelyPii(inputText, gate.confidenceThreshold);
            _report(gate.report, 'clean');
            return null;
        }
        logFind(result, ms, gate);
        if (MASKING_ACTIONS.has(gate.piiAction)) {
            const { tokenizedText, tokenMap } = await _tokenizeWithVault(inputText, result.entities, gate.existingTokenMap, gate.vaultUserId);
            log.warn(`[PiiDetection] Tokenizing — sending redacted text to AI`);
            _report(gate.report, 'found', result.entities, 'tokenised');
            return { tokenizedText, tokenMap, entities: result.entities };
        }
        throw piiBlockedError(result.entities, gate.report);
    } catch (e) {
        return verdictOrGateFailure(e, gate);
    }
}

/**
 * A throw out of the fresh scan. The deliberate gate outcomes (the PII block
 * and the fail-closed "protection unavailable" block) propagate; anything else
 * is a failure of the gate itself and takes the failure policy (null: open).
 * @param {{ message?: string, privacyUnavailable?: boolean } | null | undefined} e
 * @param {GateCall} gate
 * @returns {null}
 */
function verdictOrGateFailure(e, gate) {
    if (e?.message?.includes('PII Detected') || e?.privacyUnavailable) throw e;
    const err = _gateFailure(e, gate.piiFailureMode, gate.report);
    if (err) throw err;
    return null;
}

/**
 * The user's text to scan, or null (reported as too short) when there is no
 * user message or fewer than three characters.
 * @param {Parameters<typeof lastUserText>[0]} messages
 * @param {PiiGateReport | null} report
 */
function textToScan(messages, report) {
    const { found, text } = lastUserText(messages);
    if (!found) {
        log.info('[PiiDetection] no user message in batch');
        _report(report, 'too_short');
        return null;
    }
    if (!text || text.length < 3) {
        log.info(`[PiiDetection] input too short (${text?.length || 0} chars), skipping`);
        _report(report, 'too_short');
        return null;
    }
    return text;
}

/**
 * Loud entry trace so admins can see PII gates firing in logs.
 * @param {boolean} agentPiiEnabled
 * @param {{ piiDetectionEnabled?: boolean }} aiConfig
 * @param {{ enabled?: boolean, piiDetectionAction?: string } | null} orgShieldConfig
 */
function logGateEntry(agentPiiEnabled, aiConfig, orgShieldConfig) {
    log.info(`[PiiDetection] validateInputForPii called: agentPiiEnabled=${agentPiiEnabled} aiCfgEnabled=${!!aiConfig.piiDetectionEnabled} shield={enabled:${!!orgShieldConfig?.enabled}, action:${orgShieldConfig?.piiDetectionAction || 'default'}}`);
}

async function validateInputForPii(/** @type {Array<{ role?: string, content?: string | Array<{ type?: string, text?: string }> | null, [k: string]: unknown }>} */ messages, agentPiiEnabled = false, /** @type {{ enabled?: boolean, piiDetectionAction?: string, piiFailureMode?: string, [k: string]: unknown } | null} */ orgShieldConfig = null, /** @type {string | null} */ overridePiiAction = null, /** @type {Record<string, string> | null} */ existingTokenMap = null, /** @type {{ vaultUserId?: string | null, report?: PiiGateReport | null, onProgress?: (progress: { done: number, total: number, coveredChars: number, totalChars: number }) => void, [k: string]: unknown }} */ options = {}) {
    /** @type {PiiGateReport|null} */
    const report = options.report && typeof options.report === 'object' ? options.report : null;
    const aiConfig = await getAIConfig();

    logGateEntry(agentPiiEnabled, aiConfig, orgShieldConfig);

    const policy = inputPolicy(aiConfig, agentPiiEnabled, orgShieldConfig, overridePiiAction);
    if (!policy.enabled) {
        log.info('[PiiDetection] gate=DISABLED (aiConfig + agent + shield all off)');
        _report(report, 'disabled');
        return null;
    }
    if (policy.action === 'allow') {
        log.info('[PiiDetection] gate=ALLOW (per-call override) — skipping scan');
        _report(report, 'allowed_by_policy');
        return null;
    }

    const inputText = textToScan(messages, report);
    if (inputText === null) return null;

    const { enabledCategories, confidenceThreshold } = await resolveScanScope(aiConfig, orgShieldConfig);
    const gate = {
        piiAction: policy.action, piiFailureMode: policy.failureMode, guardRequired: policy.guardRequired, report,
        orgShieldConfig, existingTokenMap, vaultUserId: options.vaultUserId || null, aiAction: aiConfig.piiDetectionAction, confidenceThreshold,
    };
    // The key includes the resolved categories + threshold, so a shield change
    // takes effect at once and a narrow scan's result is never served to an
    // all-categories caller.
    const key = cacheKey('user_input', inputText, enabledCategories, confidenceThreshold);
    const cached = cacheGet(key);
    if (cached) return answerFromCache(inputText, cached, gate);
    return scanFresh(inputText, key, enabledCategories, gate, options.onProgress);
}

/**
 * Tokenise after a find. The vault is a database read: a failure here, after
 * PII was found, takes the failure policy instead of slipping past it as a
 * plain exception the caller reads as "nothing to report".
 * @param {string} inputText
 * @param {PiiEntity[]} entities
 * @param {Record<string, string> | null} existingTokenMap
 * @param {string | null | undefined} vaultUserId
 * @param {{ piiFailureMode: string, report: PiiGateReport | null }} gate
 * @returns {Promise<{ tokenizedText: string, tokenMap: Record<string, string> } | null>}  null: fail open
 */
async function _tokeniseOrFail(inputText, entities, existingTokenMap, vaultUserId, gate) {
    try {
        return await _tokenizeWithVault(inputText, entities, existingTokenMap, vaultUserId);
    } catch (e) {
        const err = _gateFailure(e, gate.piiFailureMode, gate.report);
        if (err) throw err;
        return null;
    }
}

/**
 * What a failure of the gate ITSELF means — the vault read during
 * tokenisation, a detector that threw, anything that is not a verdict. The
 * scan may already have found PII by then, so under fail_closed the message is
 * refused with the same "protection unavailable" error a degraded scan gives;
 * under fail_open it is logged and the text goes on unmasked, as before.
 * @param {unknown} e
 * @param {string} piiFailureMode
 * @param {PiiGateReport | null} report
 * @returns {PiiError | null}  the error to throw, or null to fail open
 */
function _gateFailure(e, piiFailureMode, report) {
    const message = e instanceof Error ? e.message : String(e);
    log.error('[PiiDetection] Validation failed:', message);
    if (piiFailureMode === 'fail_closed') {
        log.warn('[PiiDetection] Gate error — fail_closed: blocking message');
        const err = /** @type {PiiError} */ (new Error('Privacy protection unavailable: PII detection is temporarily unavailable. Please try again shortly.'));
        err.privacyUnavailable = true;
        err.privacyUnavailableKind = 'unavailable';
        err.degradedReason = `gate_error: ${message}`;
        _report(report, 'failed_closed');
        return err;
    }
    log.warn('[PiiDetection] Service unavailable, allowing content (fail-open)');
    _report(report, 'failed_open');
    return null;
}

module.exports = { validateInputForPii, validateOutputForPii };
