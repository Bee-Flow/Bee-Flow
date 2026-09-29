// @typecheck
/**
 * The "never redact this" layer.
 *
 * The org's own data types (core/privacy/customTypes, which replaced
 * `customTerms.js`) are the mirror image of this file: they make the shield
 * redact MORE (project codenames, contract-number shapes). This one makes it
 * redact LESS, for values that are not personal data at all.
 *
 * Two sources, both optional and independently switchable:
 *   1. A shipped list of public organisations (`publicOrgs.js`). Applies to the
 *      Organization category only. On by default; an org can turn it off with
 *      `piiAllowPublicOrgs: false`.
 *   2. The organisation's own never-redact terms (`piiAllowTerms`). Applies to
 *      EVERY category — an admin who writes down a term means it, whichever
 *      detector happened to flag it.
 *
 * ── Why exact-on-normalised, and not substring ────────────────────────────
 * Matching is on the value with case, punctuation and whitespace removed, and
 * it must be EXACT on that form. Substring matching would be an unbounded
 * privacy hole: allowlisting "Shell" would silently unredact "Shell Advies BV",
 * a completely different company that might well be a client. The cost of the
 * strict rule is that "Microsoft Nederland" needs its own entry; the cost of the
 * loose one is a leak, so the choice is not close.
 *
 * ── Why this filters entities rather than text ────────────────────────────
 * The allowlist runs on the DETECTED SPANS, after the scan, not as a
 * pre-pass over the input. Removing text before scanning would shift every
 * offset downstream, and a term that appears inside a longer real detection
 * would tear a hole in it. Dropping a whole span is the only operation that
 * cannot corrupt the redaction of its neighbours.
 */

const { PUBLIC_ORGANISATIONS } = require('./publicOrgs');
const { isCustomTypeId } = require('../privacy/customTypes/ids');

/** Case-, punctuation- and whitespace-insensitive comparison key. */
function normaliseAllowValue(value) {
    return String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

// Built once — the shipped list never changes at runtime.
const _PUBLIC_ORG_KEYS = new Set(
    PUBLIC_ORGANISATIONS.map(normaliseAllowValue).filter(Boolean),
);

/**
 * Build a matcher from an org shield config.
 *
 * @param {object} shieldConfig  `{ piiAllowTerms?: string[], piiAllowPublicOrgs?: boolean }`
 * @returns {{ isAllowed(value: string, category: string): boolean, size: number }}
 */
function buildAllowMatcher(shieldConfig = {}) {
    const usePublic = shieldConfig.piiAllowPublicOrgs !== false;   // default ON
    const own = new Set();
    const raw = shieldConfig.piiAllowTerms;
    if (Array.isArray(raw)) {
        for (const term of raw) {
            // Accept both a bare string and `{ term }` — the settings UI has
            // historically shipped both shapes for list fields.
            const value = typeof term === 'string' ? term : (term && term.term);
            const key = normaliseAllowValue(value);
            if (key) own.add(key);
        }
    }

    return {
        size: own.size + (usePublic ? _PUBLIC_ORG_KEYS.size : 0),
        isAllowed(value, category) {
            const key = normaliseAllowValue(value);
            if (!key) return false;
            if (own.has(key)) return true;
            // The shipped list is organisations, so it must never silence a
            // person, an IBAN, or anything else that happens to spell the same.
            return usePublic && category === 'Organization' && _PUBLIC_ORG_KEYS.has(key);
        },
    };
}

/**
 * Drop entities the matcher allows.
 *
 * @returns {{ entities: Array, allowed: Array }} — `allowed` is returned so the
 *   caller can log WHAT was let through. Nothing should ever silently vanish
 *   from a privacy pipeline; a dropped detection that leaves no trace is
 *   indistinguishable from a detector that stopped working.
 *
 * A span named by one of the org's own data types ("Your own data", a `cdt_`
 * category) is never allowed away: the org listed it to be hidden, and the
 * two lists contradicting each other resolves towards hiding.
 */
function filterAllowedEntities(entities, matcher) {
    if (!Array.isArray(entities) || entities.length === 0 || !matcher) {
        return { entities: entities || [], allowed: [] };
    }
    const kept = [];
    const allowed = [];
    for (const e of entities) {
        if (!isCustomTypeId(e && e.category) && matcher.isAllowed(e && e.text, e && e.category)) allowed.push(e);
        else kept.push(e);
    }
    return { entities: kept, allowed };
}

module.exports = { buildAllowMatcher, filterAllowedEntities, normaliseAllowValue };
