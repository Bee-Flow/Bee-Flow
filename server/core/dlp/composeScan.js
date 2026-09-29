// @typecheck
/**
 * Scan many units, tokenise them ONCE.
 *
 * THE MISTAKE THIS EXISTS TO PREVENT
 * The obvious shape — "scan each unit, tokenise each unit" — is wrong, and
 * wrong silently. `tokenizeText` seeds its per-category counters from the map
 * it is handed and mints `[${cat}_${n+1}]` (core/piiDetection.js:885-896). Two
 * units tokenised separately from the same snapshot therefore both mint
 * `[person_1]` — for two DIFFERENT people. And `_buildAliasIndex` (:770-819)
 * only coalesces "Tom" with "Tom Smit", and only refuses to when a third
 * "Tom Bakker" makes it ambiguous, if it sees every value at once. Partitioned,
 * that guarantee evaporates.
 *
 * So: detect per unit (that is where the reuse lives), then splice every
 * finding into ONE shared coordinate system — a carrier string — and run
 * exactly one `tokenizeText` and one `mergeTokenMap` per assembly. The carrier
 * never reaches the guard and never reaches the model; it is split back apart
 * afterwards. Same trick `_entitiesToFlatOffsets` already plays per PDF page
 * (core/dlp/attachmentScanner.js), with an assertion added.
 */

const { tokenizeText, ALL_PII_CATEGORY_IDS } = require('../privacy/piiDetection');
const { resolveSpanOverlaps } = require('./spanOverlap');
const { mergeTokenMap, getConversationTokenMap } = require('./dlpRunner');
const { detectWithLedger } = require('./scanLedger');
const { _resolveFailureMode } = require('./attachmentScanner');
const { isCustomTypeId } = require('../privacy/customTypes/ids');
const { withBuiltinDefault } = require('../privacy/customTypes/plan');
const log = require('../../telemetry/log');

// A separator the model never sees and that cannot occur in cleaned unit text,
// so splitting back apart is exact.
const SEP = '\x1f';

function _action(orgShield) {
    const legacy = orgShield?.piiDetectionAction;
    if (legacy === 'block') return 'block';
    if (legacy === 'tokenize' || legacy === 'redact') return 'tokenize';
    return orgShield?.privacyAction === 'block' ? 'block' : 'tokenize';
}
function _categories(orgShield) {
    const cats = orgShield?.piiDetectionCategories;
    // "Your own data" ids stay in the list (detectPii resolves them); an empty
    // built-in part still means every built-in category.
    if (Array.isArray(cats) && cats.length > 0) {
        return withBuiltinDefault(cats.filter(id => ALL_PII_CATEGORY_IDS.includes(id) || isCustomTypeId(id)));
    }
    return null;
}
function _threshold(orgShield) {
    const t = orgShield?.piiDetectionConfidenceThreshold;
    return Number.isFinite(t) ? t : undefined;
}
function _enabled(orgShield) {
    if (!orgShield) return false;
    return orgShield.enabled !== false && orgShield.privacyScanEnabled !== false;
}

/**
 * @param {object} params
 * @param {string[]} params.units      Texts that will literally appear in the prompt.
 * @param {object}   params.orgShield
 * @param {string}   [params.conversationId]
 * @param {string}   [params.scope]    Ledger scope (see scanLedger).
 * @returns {Promise<{units:string[], blocked:boolean, reason:string|null,
 *                    findings:Array, count:number, mentions:number,
 *                    byCategory:object, tokenMap:object|null, degraded:boolean,
 *                    stats:{segments:number,hits:number,fresh:number}}>}
 */
async function composeScan({ units, orgShield, conversationId, scope } = /** @type {any} */ ({})) {
    const list = (units || []).map(u => (typeof u === 'string' ? u : ''));
    const idle = {
        units: list, blocked: false, reason: null, findings: [], count: 0, mentions: 0,
        byCategory: {}, tokenMap: null, degraded: false, stats: { segments: 0, hits: 0, fresh: 0 },
    };
    if (list.length === 0 || !_enabled(orgShield)) return idle;

    // The separator must not occur inside a unit or the split below would not
    // line up with the inputs.
    const clean = list.map(u => (u.includes(SEP) ? u.split(SEP).join(' ') : u));
    const categories = _categories(orgShield);
    const threshold = _threshold(orgShield);

    const findings = [];
    const stats = { segments: 0, hits: 0, fresh: 0 };
    let degraded = false;
    let degradedReason = null;

    let cursor = 0;
    for (let i = 0; i < clean.length; i++) {
        const unit = clean[i];
        if (unit) {
            const r = await detectWithLedger(unit, { categories, threshold, scope });
            stats.segments += r.stats.segments; stats.hits += r.stats.hits; stats.fresh += r.stats.fresh;
            if (r.degraded) { degraded = true; degradedReason = degradedReason || r.degradedReason; }
            for (const e of r.entities) findings.push({ ...e, offset: e.offset + cursor });
        }
        cursor += unit.length + SEP.length;
    }

    if (degraded && _resolveFailureMode(orgShield) === 'fail_closed') {
        return { ...idle, units: clean, blocked: true, reason: 'degraded', degraded: true, stats };
    }

    const carrier = clean.join(SEP);
    // Overlap resolution over the WHOLE assembly, so a value seen twice in two
    // units collapses to one span exactly as it would in a single scan.
    const resolved = resolveSpanOverlaps(findings, carrier);

    const byCategory = {};
    for (const f of resolved) {
        const k = f.label || f.category || 'Other';
        byCategory[k] = (byCategory[k] || 0) + 1;
    }

    if (resolved.length === 0) {
        return { ...idle, units: clean, byCategory, degraded, stats };
    }
    if (_action(orgShield) === 'block') {
        return {
            ...idle, units: clean, blocked: true, reason: 'pii',
            findings: resolved, mentions: resolved.length, byCategory, degraded, stats,
        };
    }

    // ── The single tokenisation ────────────────────────────────────────────
    const existing = conversationId ? getConversationTokenMap(conversationId) : null;
    const { tokenizedText, tokenMap } = tokenizeText(carrier, resolved, existing);
    if (conversationId) mergeTokenMap(conversationId, tokenMap);

    const out = tokenizedText.split(SEP);
    // Tokens never contain SEP and units were cleaned of it, so this holds by
    // construction. Asserted rather than assumed: a mismatch would silently
    // shift prompt fragments between slots.
    if (out.length !== clean.length) {
        log.warn(`[ComposeScan] carrier split ${out.length} != ${clean.length} units — returning untokenised`);
        return { ...idle, units: clean, findings: resolved, mentions: resolved.length, byCategory, degraded, stats };
    }

    return {
        units: out,
        blocked: false,
        reason: null,
        findings: resolved,
        count: Object.keys(tokenMap).length,   // distinct values = token-map rows
        mentions: resolved.length,             // occurrences
        byCategory,
        tokenMap,
        degraded,
        stats,
    };
}

module.exports = { composeScan, SEP };
