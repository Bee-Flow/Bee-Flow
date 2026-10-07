/**
 * Special categories of personal data (GDPR Art. 9) in the monitoring views.
 *
 * The Privacy Shield's guard detects one Art. 9 kind: health
 * (MedicalCondition, Medication, HealthInsuranceNumber, and the older
 * spellings personalColumns maps to 'health'). A health label next to a named
 * or identifiable person reveals health data about that person (CJEU
 * C-184/20), and the per-user monitoring views have no Art. 9(2) condition for
 * that. So these labels appear only as organisation-wide totals:
 *
 *   - never on a row that carries a user (the recent-events and egress logs),
 *   - never in a category breakdown narrowed to one person (?user=),
 *   - and a ?pii=<special category> filter never returns people.
 *
 * A person's own rows are exempt: showing someone their own data discloses
 * nothing to anyone else.
 *
 * Pure: no I/O. The routes apply it (routes/usage.js).
 */

'use strict';

const { kindOfCategory } = require('./personalColumns');

/** Our kinds that are special categories under Art. 9. */
const SPECIAL_KINDS = Object.freeze(['health']);

/** Whether one category, in any spelling a producer has used, is a special category. */
function isSpecialCategory(category) {
    if (category === null || category === undefined || String(category).trim() === '') return false;
    return SPECIAL_KINDS.includes(kindOfCategory(String(category).trim()));
}

/** The entries of a comma-joined category list (any era: 'a,b' or 'a, b'). */
function entriesOf(list) {
    return typeof list === 'string' ? list.split(',').map(s => s.trim()).filter(Boolean) : [];
}

/** Whether a comma-joined category list names a special category. */
function hasSpecialCategory(list) {
    return entriesOf(list).some(isSpecialCategory);
}

/**
 * A comma-joined category list without its special categories: re-joined with
 * ',' or null when nothing is left. A list without one, or a value that is not
 * a string, comes back unchanged.
 */
function withoutSpecialCategories(list) {
    if (!hasSpecialCategory(list)) return list;
    const kept = entriesOf(list).filter(s => !isSpecialCategory(s));
    return kept.length ? kept.join(',') : null;
}

/**
 * Rows that carry a person, without special-category labels in `field`.
 *
 * A row whose list named ONLY special categories is left out: kept with an
 * empty list it would stand out (a find without a kind) and so say what was
 * removed. The organisation-wide totals still count it. Rows are copied, never
 * changed in place.
 */
function withholdSpecialCategories(rows, field) {
    const out = [];
    for (const row of Array.isArray(rows) ? rows : []) {
        if (!row || !hasSpecialCategory(row[field])) { out.push(row); continue; }
        const kept = withoutSpecialCategories(row[field]);
        if (kept !== null) out.push({ ...row, [field]: kept });
    }
    return out;
}

/** Rows keyed by a category field, without the rows whose category is special. */
function dropSpecialCategoryRows(rows, field = 'category') {
    return (Array.isArray(rows) ? rows : []).filter(r => !isSpecialCategory(r?.[field]));
}

module.exports = {
    SPECIAL_KINDS,
    isSpecialCategory,
    hasSpecialCategory,
    withoutSpecialCategories,
    withholdSpecialCategories,
    dropSpecialCategoryRows,
};
