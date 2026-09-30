/**
 * Turning server values into words: a snake_case enum into a label, an ISO
 * timestamp into a date a person reads as a fact. Used by the settings,
 * organisation, usage, admin and support screens alike.
 */

/** A person's name as a roster shows it: display name, else first and last name, else username, else id. */
export function personName(person: {
    id: string;
    displayName?: string;
    firstName?: string;
    lastName?: string;
    username?: string;
}): string {
    return (
        person.displayName ||
        [person.firstName, person.lastName].filter(Boolean).join(' ').trim() ||
        person.username ||
        person.id
    );
}

/** Sentence-case a snake_case or kebab-case server enum for display. */
export function humanise(value: string | null | undefined): string {
    if (!value) return '—';
    const spaced = value.replace(/[_-]+/g, ' ').trim();
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** "12 March 2026". Used where a date is a fact, not a recency cue. */
export function absoluteDate(iso: string | null | undefined): string {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
}
