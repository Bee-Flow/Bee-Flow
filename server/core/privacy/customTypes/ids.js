// @typecheck
'use strict';
/**
 * Identity of an org-defined data type ("Your own data").
 *
 * A type travels through the whole shield as a CATEGORY ID next to the
 * built-in ones (`Person`, `Email`, …), so the id is the one thing every
 * layer can recognise without a lookup: `cdt_` + 10 lowercase hex.
 *
 *   - New types get a random id from the client (or newTypeId here).
 *   - Types migrated from the old "Always hide these" list
 *     (`customSensitiveTerms`) get a DETERMINISTIC id, so the lazy migration
 *     on read and the one on save agree, and so a re-migration after a
 *     rollback lands on the same ids:
 *       cdt_ + sha256(orgId + '\0' + legacyTermId).hex[0..10]
 *     where legacyTermId is the term's own id, or, for a bare string or an
 *     id-less term, sha256(label + '\0' + pattern).hex.
 */

const crypto = require('crypto');

const CDT_ID_RE = /^cdt_[0-9a-f]{10}$/;

/** @param {unknown} id */
function isCustomTypeId(id) {
    return typeof id === 'string' && CDT_ID_RE.test(id);
}

function newTypeId() {
    return `cdt_${crypto.randomBytes(5).toString('hex')}`;
}

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * The legacy term's own identity: its id, or a digest of what it matched.
 * @param {any} term  a stored customSensitiveTerms entry (object or bare string)
 */
function legacyTermKey(term) {
    if (term && typeof term === 'object' && typeof term.id === 'string' && term.id) return term.id;
    const label = typeof term === 'string' ? term : String(term?.label ?? '');
    const pattern = typeof term === 'string' ? term : String(term?.pattern ?? '');
    return sha256(`${label}\0${pattern}`);
}

/**
 * @param {string} orgId
 * @param {any} term
 */
function legacyTypeId(orgId, term) {
    return `cdt_${sha256(`${orgId}\0${legacyTermKey(term)}`).slice(0, 10)}`;
}

module.exports = { CDT_ID_RE, isCustomTypeId, newTypeId, legacyTermKey, legacyTypeId, sha256 };
