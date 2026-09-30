/**
 * Query keys for the organisation. The two shield keys keep their original
 * `settings` root; the roster key is shared with Administration, which counts
 * the same members.
 */

export const orgKeys = {
    orgs: ['org', 'list'] as const,
    org: (id: string) => ['org', 'detail', id] as const,
    members: ['org', 'members'] as const,
    groups: ['org', 'groups'] as const,
    shield: (id: string) => ['org', 'shield', id] as const,
    dsr: ['org', 'dsr'] as const,
    licenseHealth: ['org', 'license-health'] as const,
    githubConnected: ['org', 'github-connected'] as const,
    userShield: ['settings', 'user-shield'] as const,
    guardStatus: ['settings', 'guard-status'] as const,
    languages: ['org', 'languages'] as const,
    encryption: (id: string) => ['org', 'encryption', id] as const,
    aiContext: (id: string) => ['org', 'ai-context', id] as const,
    integrationCache: (id: string) => ['org', 'integration-cache', id] as const,
    theme: ['org', 'theme'] as const,
    iconPacks: ['org', 'icon-packs'] as const,
    academy: ['org', 'academy'] as const,
};

/**
 * The key the app's theme reads (features/appearance `brandingKeys.effective`,
 * which that feature does not export). Written out here so a saved org theme
 * repaints the app; invalidating it drops the public branding under it too.
 */
export const APP_BRANDING_KEY = ['settings', 'branding'] as const;
