/**
 * The self-hosted AI budget fields (a user's monthly budget, a group's budget
 * per member) are text inputs in the forms and a positive number or null on
 * the wire. Empty means "no limit".
 */

/** The stored value as the text the input shows. */
export function costLimitToInput(value: unknown): string {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? String(value) : '';
}

/**
 * The input text as the value to send: null for empty, the number for a
 * positive amount (a decimal comma is accepted), `undefined` when it is not a
 * usable amount (zero, negative, not a number).
 */
export function parseCostLimitInput(text: string): number | null | undefined {
    const trimmed = text.trim().replace(',', '.');
    if (trimmed === '') return null;
    const n = Number(trimmed);
    return Number.isFinite(n) && n > 0 ? n : undefined;
}
