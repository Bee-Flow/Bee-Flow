/**
 * Query keys for the org shield editor. Its own root, not features/org's
 * `['org', 'shield', id]`: that cache holds the personal screen's read-only
 * summary in a different shape. A save invalidates both (ORG_SUMMARY_ROOT).
 */

export const orgShieldKeys = {
    doc: (orgId: string) => ['orgShield', 'doc', orgId] as const,
    guard: ['orgShield', 'guard-status'] as const,
    env: ['orgShield', 'env'] as const,
    activity: (days: number) => ['orgShield', 'activity', days] as const,
};

/** features/org's summary of the same document (its api/keys.ts `shield`). */
export const ORG_SUMMARY_ROOT = ['org', 'shield'] as const;
