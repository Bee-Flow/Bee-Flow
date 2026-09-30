/**
 * Query keys for the Settings hub's own screens. `health` is shared: About,
 * Server, Administration and the support composer all read the same probe.
 */

export const settingsKeys = {
    locales: ['settings', 'locales'] as const,
    releaseNotes: ['settings', 'release-notes'] as const,
    health: ['settings', 'health'] as const,
    /** The MIN_SERVER_BUILD capability probe — see core/api/server.ts. */
    serverSupport: ['settings', 'server-support'] as const,
    /** Every resolved locale — what a new language choice invalidates. */
    resolvedLocales: ['i18n', 'resolved'] as const,
    /** Which locale this account renders in, for the set of codes offered. */
    resolvedLocale: (codes: string) => ['i18n', 'resolved', codes] as const,
    localeStrings: (locale: string | undefined) => ['i18n', 'strings', locale] as const,
};
