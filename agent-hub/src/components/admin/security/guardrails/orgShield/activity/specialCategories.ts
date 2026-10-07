/**
 * Special categories of personal data (GDPR Art. 9) on the "What happened"
 * pane: health, the one Art. 9 kind the guard detects.
 *
 * A health label next to a named or identifiable person reveals health data
 * about that person, so the server shows these categories as ORGANISATION
 * TOTALS only (server/core/privacy/specialCategories.js): it strips them from
 * every row that carries a user, drops them from a breakdown narrowed to one
 * person, and answers `?pii=<health category>` together with `?user=` (or on a
 * route that lists people) with 400 `special_category_per_person`.
 *
 * The pane follows the same rule: a health category is a readout, never a
 * filter. It cannot be picked (shieldFilters.toggleFilter refuses it), so it
 * never narrows the people panel, and it is only counted from the window's
 * totals, never from the rows (which carry a person).
 *
 * The spellings mirror the server's: the canonical ids its personalColumns
 * maps to the kind 'health', and the older spellings it still reads, all
 * compared squashed to bare letters and digits so 'Medical Condition',
 * 'medical_condition' and 'MedicalCondition' are one. The phone keeps the
 * same list (mobile/src/features/orgShield/model/activity.ts), and its
 * lockstep test pins both against the server.
 */

/** Every spelling of a health category, squashed to bare lower-case letters and digits. */
export const SPECIAL_CATEGORY_SPELLINGS: readonly string[] = Object.freeze([
    // The canonical ids (personalColumns KIND_OF_CATEGORY → 'health').
    'healthinsurancenumber',
    'medicalcondition',
    'medication',
    // The older spellings producers wrote (personalColumns LOOSE_KIND → 'health').
    'health',
    'medical',
]);

const squash = (value: unknown): string => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Is this stored category, in any spelling, a special category (health)? */
export function isSpecialCategory(category: unknown): boolean {
    if (category === null || category === undefined) return false;
    const squashed = squash(category);
    return squashed !== '' && SPECIAL_CATEGORY_SPELLINGS.includes(squashed);
}

/** The categories without the special ones, order kept. */
export function withoutSpecialCategories<T>(categories: readonly T[]): T[] {
    return categories.filter(c => !isSpecialCategory(c));
}
