/** Due-date handling for the Deck tools. */

/**
 * A due date as UTC ISO. Deck re-parses the string without its offset, so an
 * offset string ("...-05:00") would shift by the offset on every resend.
 * @returns {{ iso: string | null } | { error: string }}
 */
function toUtcIso(value) {
    if (value === undefined || value === null || value === '') return { iso: null };
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return { error: `duedate is not a valid date: ${value}` };
    return { iso: d.toISOString() };
}

/** The stored due date as UTC ISO; left as Deck gave it when it cannot be parsed. */
function keepDue(stored) {
    const parsed = toUtcIso(stored);
    return 'iso' in parsed ? parsed.iso : stored;
}

module.exports = { toUtcIso, keepDue };
