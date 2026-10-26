// @typecheck strict
/**
 * @typedef {import('./validate').PiiError} PiiError
 * @typedef {{ category: string, label: string, text?: string, confidence?: number, [k: string]: unknown }} PiiEntity  one detected span
 * @typedef {{ hasPii: boolean, entities: PiiEntity[] }} PiiScanResult  the detector's answer
 */

const log = require('../../../telemetry/log');
const { buildAllowMatcher, filterAllowedEntities } = require('../../dlp/allowTerms');
const { ALL_PII_CATEGORY_IDS, LEGACY_CATEGORY_ALIASES, DEFAULT_PII_CONFIDENCE_THRESHOLD } = require('./categories');
const { cacheKey, cacheGet, cacheSet } = require('./scanCache');
const { classifyDegradation } = require('./degradation');
const { tokenizeText } = require('./tokenizer');
const { detectPii } = require('./detect');
const { isCustomTypeId } = require('../customTypes/ids');
const { withBuiltinDefault } = require('../customTypes/plan');

function getAIConfig() {
    return require('../../aiAgent').getAIConfig();
}

/**
 * The stored list, aliased, with ids nobody knows dropped. "Your own data"
 * ids stay (the scan resolves them), and a list whose built-in part is empty
 * keeps meaning "every built-in category" when custom ids sit next to it.
 * @param {string[]} list
 */
function _shieldCategories(list) {
    const aliases = /** @type {Record<string, string>} */ (LEGACY_CATEGORY_ALIASES);
    const known = list
        .map(id => aliases[id] || id)
        .filter(id => ALL_PII_CATEGORY_IDS.includes(id) || isCustomTypeId(id));
    return withBuiltinDefault(known);
}

/** What a log line may say about an entity: a custom type by id, never by its name. */
const _logLabel = (/** @type {PiiEntity} */ e) => (isCustomTypeId(e.category) ? e.category : e.label);

/**
 * @param {Record<string, string> | null} existingTokenMap  The conversation's accumulated
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
 * @param {string} inputText
 * @param {PiiEntity[]} entities
 * @param {Record<string, string> | null} existingTokenMap  the conversation's accumulated token map (see above)
 * @param {string | null | undefined} vaultUserId
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
 * @overload
 * @param {PiiScanResult} result  raw scan result
 * @param {Parameters<typeof buildAllowMatcher>[0] | null} orgShieldConfig  the READING org's shield
 * @returns {PiiScanResult} a new object when anything was allowlisted away; the input untouched otherwise.
 */
/**
 * @overload
 * @param {PiiScanResult | null} result
 * @param {Parameters<typeof buildAllowMatcher>[0] | null} orgShieldConfig
 * @returns {PiiScanResult | null}
 */
/**
 * @param {PiiScanResult | null} result
 * @param {Parameters<typeof buildAllowMatcher>[0] | null} orgShieldConfig
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
    /** @type {Record<string, number>} */
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

/**
 * Validate agent output for PII.
 * @param {string | null | undefined} content
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
        const categoryList = [...new Set(cached.entities.map((/** @type {PiiEntity} */ e) => e.label))].join(', ');
        const err = /** @type {PiiError} */ (new Error(`PII Detected: Response contains sensitive personal information (${categoryList}).`));
        err.piiEntities = cached.entities;
        err.violationCodes = cached.entities.map((/** @type {PiiEntity} */ e) => `PII:${e.category}`);
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

        const categoryList = [...new Set(result.entities.map((/** @type {PiiEntity} */ e) => e.label))].join(', ');
        log.warn(`[PiiDetection] PII in output | ${categoryList}`);

        const err = /** @type {PiiError} */ (new Error(`PII Detected: Response contains sensitive personal information (${categoryList}).`));
        err.piiEntities = result.entities;
        err.violationCodes = result.entities.map((/** @type {PiiEntity} */ e) => `PII:${e.category}`);
        throw err;

    } catch (e) {
        // Optional chaining matters: a rejection with a non-Error value (a
        // string, an undici cause object) would otherwise make the catch block
        // itself throw. The input path already guards this at :744.
        if (e?.message?.includes('PII Detected') || e?.privacyUnavailable) throw e;
        log.warn('[PiiDetection] Output validation unavailable, allowing (fail-open)');
    }
}

module.exports = { getAIConfig, _shieldCategories, _logLabel, _tokenizeWithVault, _applyAllowlist, _report, validateOutputForPii };
