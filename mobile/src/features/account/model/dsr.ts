/** Data-subject requests, in the words a person would use rather than GDPR articles. */

/** The request types dsrStore accepts. */
export const DSR_TYPES: { id: string; label: string; description: string }[] = [
    {
        id: 'access',
        label: 'A copy of my data',
        description: 'Everything Bee Flow holds about you (GDPR Art. 15).',
    },
    {
        id: 'rectification',
        label: 'Correct something',
        description: 'Something stored about you is wrong (Art. 16).',
    },
    {
        id: 'erasure',
        label: 'Delete my data',
        description: 'Erase your account and its contents (Art. 17).',
    },
    {
        id: 'portability',
        label: 'Export to take elsewhere',
        description: 'A machine-readable copy you can move (Art. 20).',
    },
    {
        id: 'objection',
        label: 'Object to processing',
        description: 'Ask that a particular use of your data stops (Art. 21).',
    },
];

/** Loose shape check before filing; the server identifies the org from it. */
export function looksLikeEmail(value: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}
