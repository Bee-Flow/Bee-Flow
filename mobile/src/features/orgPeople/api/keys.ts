/**
 * Query keys for the people surface. Its own root, because its roster reads
 * more fields (status, MFA) than the org feature's; `ORG_ROSTER_KEYS` are the
 * org feature's copies of the same lists (the org index and Administration
 * count them), invalidated alongside so every screen agrees after a write.
 */

export const peopleKeys = {
    members: ['orgPeople', 'members'] as const,
    groups: ['orgPeople', 'groups'] as const,
    invitations: ['orgPeople', 'invitations'] as const,
    roles: ['orgPeople', 'org-roles'] as const,
    customTiersList: ['orgPeople', 'custom-tiers-list'] as const,
    orgTiers: ['orgPeople', 'org-tiers'] as const,
    models: ['orgPeople', 'models'] as const,
    access: (orgId: string) => ['orgPeople', 'access', orgId] as const,
};

/** features/org's orgKeys.members and orgKeys.groups. */
export const ORG_ROSTER_KEYS = [['org', 'members'], ['org', 'groups']] as const;
