/**
 * The PII category vocabulary the guard/tokenize rules check a step's
 * `categories` against, read lazily from core/privacy/piiDetection and cached
 * here (this module is its one home).
 */

/**
 * The PII category ids a guard step may name, read from the ONE place that
 * defines them (core/piiDetection). Duplicating the list here is what would
 * make the validator and the detector disagree about what a category is —
 * exactly the split the guard step exists to avoid.
 *
 * Required lazily and tolerantly: piiDetection pulls in configStore and has a
 * documented require-cycle with aiAgent, and a definition must stay validatable
 * on a box where that module cannot load. `null` means "cannot check", and the
 * caller then only rejects non-strings rather than inventing a list.
 */
let _piiCategoryIds;
function piiCategoryIds() {
    if (_piiCategoryIds !== undefined) return _piiCategoryIds;
    try {
        const { ALL_PII_CATEGORY_IDS, LEGACY_CATEGORY_ALIASES } = require('../../core/privacy/piiDetection');
        _piiCategoryIds = new Set([...ALL_PII_CATEGORY_IDS, ...Object.keys(LEGACY_CATEGORY_ALIASES || {})]);
    } catch (_) {
        _piiCategoryIds = null;
    }
    return _piiCategoryIds;
}

module.exports = { piiCategoryIds };
