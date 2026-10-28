/** Data-subject requests, in the words a person would use rather than GDPR articles. */

/** Words carried as data: the form resolves them with t(), so the list stays a constant. */
export interface DsrText {
    i18nKey: string;
    en: string;
}

/** The request types dsrStore accepts. */
export const DSR_TYPES: { id: string; label: DsrText; description: DsrText }[] = [
    {
        id: 'access',
        label: { i18nKey: 'mobile.account.dsr_access', en: 'A copy of my data' },
        description: { i18nKey: 'mobile.account.dsr_access_desc', en: 'Everything Bee Flow holds about you (GDPR Art. 15).' },
    },
    {
        id: 'rectification',
        label: { i18nKey: 'mobile.account.dsr_rectification', en: 'Correct something' },
        description: { i18nKey: 'mobile.account.dsr_rectification_desc', en: 'Something stored about you is wrong (Art. 16).' },
    },
    {
        id: 'erasure',
        label: { i18nKey: 'mobile.account.dsr_erasure', en: 'Delete my data' },
        description: { i18nKey: 'mobile.account.dsr_erasure_desc', en: 'Erase your account and its contents (Art. 17).' },
    },
    {
        id: 'portability',
        label: { i18nKey: 'mobile.account.dsr_portability', en: 'Export to take elsewhere' },
        description: { i18nKey: 'mobile.account.dsr_portability_desc', en: 'A machine-readable copy you can move (Art. 20).' },
    },
    {
        id: 'objection',
        label: { i18nKey: 'mobile.account.dsr_objection', en: 'Object to processing' },
        description: { i18nKey: 'mobile.account.dsr_objection_desc', en: 'Ask that a particular use of your data stops (Art. 21).' },
    },
];

/** Loose shape check before filing; the server identifies the org from it. */
export function looksLikeEmail(value: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}
