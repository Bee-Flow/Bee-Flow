// @typecheck
const log = require('../../telemetry/log');
const { fallback } = require('../../utils/bestEffort');

// The GLiNER detector caps each request; scan long text in overlapping
// windows so PII past the single-request cap isn't silently skipped and
// egressed raw. Overlap catches an entity straddling a window boundary; a
// window ceiling bounds cost on pathological inputs.
const PII_SCAN_WINDOW = 8000;

const PII_SCAN_OVERLAP = 256;

const PII_SCAN_MAX_WINDOWS = 40; // ~310K chars scanned before we bound it

// Run the org-configured GLiNER detector. Returns null on any failure
// (fail-open) or when nothing is found. Text longer than one window is scanned
// in overlapping windows and the entities merged with ABSOLUTE offsets so the
// downstream tokenizer (which splices by offset) redacts every occurrence.
//
// Kept for logEgress's `fullScan` hook, which only wants "is there PII in this
// payload" for the egress row's labels. The GUARD path uses _scanText below,
// which additionally applies the org's allowlist + custom terms and reports
// degradation instead of swallowing it.
async function _detectPii(text, policy) {
    const r = await _rawDetect(text, policy);
    return r && r.entities.length ? { hasPii: true, entities: r.entities } : null;
}

// Windowed detectPii. Never throws; reports degradation rather than hiding it.
// Returns { entities, degraded, degradedReason, degradedCategories, overflow }.
async function _rawDetect(text, policy) {
    const full = String(text || '');
    const empty = { entities: [], degraded: false, degradedReason: null, degradedCategories: null, overflow: false };
    if (full.length < 3) return empty;
    try {
        const { detectPii } = require('../privacy/piiDetection');
        if (full.length <= PII_SCAN_WINDOW) {
            const res = await detectPii(full, policy.categories, policy.confidence);
            if (!res || res.guardAbsent) {
                // detectPii returns null when no detector is installed at all.
                // That is NOT "clean" — it is "we did not look". `guardAbsent`
                // says the same, but the org's own words/patterns did run in
                // Node: keep what they found.
                return {
                    ...empty, degraded: true, degradedReason: 'guard_not_installed',
                    entities: res && res.hasPii && Array.isArray(res.entities) ? res.entities : [],
                };
            }
            return {
                entities: res.hasPii && Array.isArray(res.entities) ? res.entities : [],
                degraded: !!res.degraded,
                degradedReason: res.degradedReason || null,
                degradedCategories: res.degradedCategories || null,
                overflow: false,
            };
        }
        const step = PII_SCAN_WINDOW - PII_SCAN_OVERLAP;
        const merged = [];
        const seen = new Set();
        let windows = 0;
        let degraded = false;
        let degradedReason = null;
        let degradedCategories = null;
        for (let start = 0; start < full.length && windows < PII_SCAN_MAX_WINDOWS; start += step, windows++) {
            const chunk = full.slice(start, start + PII_SCAN_WINDOW);
            const res = await detectPii(chunk, policy.categories, policy.confidence);
            if (!res) { degraded = true; degradedReason = degradedReason || 'guard_not_installed'; continue; }
            if (res.guardAbsent) { degraded = true; degradedReason = degradedReason || 'guard_not_installed'; }
            if (res.degraded) {
                degraded = true;
                degradedReason = degradedReason || res.degradedReason || null;
                if (res.degradedCategories) degradedCategories = [...new Set([...(degradedCategories || []), ...res.degradedCategories])];
            }
            if (!res.hasPii || !Array.isArray(res.entities)) continue;
            for (const e of res.entities) {
                const absOffset = (e.offset !== undefined && e.offset >= 0) ? start + e.offset : undefined;
                const key = `${absOffset ?? 'x'}|${e.text}`;
                if (seen.has(key)) continue;
                seen.add(key);
                merged.push(absOffset !== undefined ? { ...e, offset: absOffset } : { ...e });
            }
        }
        const overflow = windows >= PII_SCAN_MAX_WINDOWS && full.length > PII_SCAN_MAX_WINDOWS * step;
        if (overflow) {
            log.warn(`[safety] PII scan window cap (${PII_SCAN_MAX_WINDOWS}) hit — tail of a ${full.length}-char value was not scanned`);
        }
        return { entities: merged, degraded, degradedReason, degradedCategories, overflow };
    } catch (e) {
        return { ...empty, degraded: true, degradedReason: `guard_unreachable: ${e.message}` };
    }
}

/**
 * Full scan of ONE string leaf, in the same order chat uses (dlpRunner):
 * detect (which includes the org's own data types) → never-redact allowlist.
 * Entities come back in `tokenizeText` shape (offset/length/text/category/
 * label); detectPii's spans are disjoint, and overlaps across windows are
 * resolved at the mint site by tokenizeText itself.
 *
 * The allowlist and custom terms were completely inert on automations: safety.js
 * called the bare detector, so an org's own company name kept being redacted
 * (false positives, garbled outputs) and its own codenames were never caught —
 * while the very same settings worked in chat. The codenames now travel as
 * category ids in `policy.categories` (core/privacy/customTypes).
 */
async function _scanText(text, policy) {
    const det = await _rawDetect(text, policy);
    let entities = det.entities.map(e => ({
        category: e.category || e.label || 'PII',
        label: e.label || e.category || 'PII',
        offset: typeof e.offset === 'number' ? e.offset : 0,
        length: e.length || (e.text ? e.text.length : 0),
        text: e.text || '',
        confidence: e.confidence,
    }));

    if (entities.length) {
        try {
            const { buildAllowMatcher, filterAllowedEntities } = require('../dlp/allowTerms');
            const filtered = filterAllowedEntities(entities, buildAllowMatcher(policy.shield || {}));
            if (filtered.allowed.length) {
                const byCat = {};
                for (const e of filtered.allowed) byCat[e.category] = (byCat[e.category] || 0) + 1;
                log.info('[safety] allowlist kept spans unredacted:', JSON.stringify(byCat));
            }
            entities = filtered.entities;
        } catch (err) { fallback('core/automationRunner/safetyScan:_scanText', err); /* allowlist unavailable — keep the raw detections */ }
    }

    return {
        entities,
        degraded: det.degraded,
        degradedReason: det.degradedReason,
        degradedCategories: det.degradedCategories,
        overflow: det.overflow,
    };
}

/**
 * Does a degraded scan actually affect what this org asked us to look for?
 * Mirrors piiDetection's narrowing: an empty/absent list means "unknown —
 * assume everything".
 */
function _degradationIsRelevant(degradedCategories, requested) {
    if (!Array.isArray(degradedCategories) || degradedCategories.length === 0) return true;
    if (!Array.isArray(requested) || requested.length === 0) return true;
    return degradedCategories.some(c => requested.includes(c));
}

function _regexHits(text, policy) {
    if (!policy.regexRules || !policy.regexRules.length) return [];
    try {
        const { checkRegexPatterns } = require('../privacy/guardrails');
        return checkRegexPatterns(text, policy.regexRules) || [];
    } catch (_) { return []; }
}

/**
 * The sentence a user reads when a fail-closed privacy check could not run.
 *
 * It used to carry the raw guard reason ("guard_unreachable: socket hang up"),
 * which says nothing to the person looking at a failed step and nothing about
 * what to do next (BFSF-373). The advice follows the kind of failure
 * (piiDetection/degradation.js): retry for a transient failure, less data for
 * an oversize one, an admin for a missing detector. Only the COPY differs per
 * kind; every one of them still blocks.
 */
function _scanFailedMessage(degradedReason, direction, valueCount) {
    const reason = String(degradedReason || '');
    const n = Number(valueCount) || 0;
    const values = `${n} ${n === 1 ? 'value' : 'values'}`;
    const head = `Blocked: the privacy check could not run on this step's ${direction === 'output' ? 'output' : 'input'} (${values}), `
        + 'and this organisation requires content to be checked before it is used.';
    let advice;
    if (/guard_not_installed/.test(reason)) {
        advice = 'No privacy check service is installed on this server. Ask an admin to install it, or to review the Privacy Shield setting for when the check cannot run.';
    } else if (/guard_circuit_open/.test(reason)) {
        advice = 'The privacy check service failed several times in a row and is paused for a moment. Wait a minute and run it again. If it keeps happening, ask an admin to check the privacy check service.';
    } else {
        const kind = require('../privacy/piiDetection/degradation').classifyDegradation(reason);
        if (kind === 'too_large') {
            advice = 'The content was too large to check. Make the step handle less data (for example a lower result limit) and run it again.';
        } else if (kind === 'timeout') {
            advice = 'The privacy check service took too long to answer. Run it again. If it keeps happening, make the step handle less data (for example a lower result limit) or ask an admin to check the privacy check service.';
        } else {
            advice = 'The privacy check service could not be reached. Run it again. If it keeps happening, make the step handle less data (for example a lower result limit), or ask an admin to check the privacy check service or the Privacy Shield setting for when the check cannot run.';
        }
    }
    return `${head} ${advice}`;
}

module.exports = { PII_SCAN_WINDOW, _detectPii, _scanText, _degradationIsRelevant, _regexHits, _scanFailedMessage };
