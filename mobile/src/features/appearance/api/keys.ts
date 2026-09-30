/** Query keys for branding, under their original `settings` root. */

export const brandingKeys = {
    effective: ['settings', 'branding'] as const,
    /** Under `effective`, so invalidating the account's branding drops it too. */
    public: ['settings', 'branding', 'public'] as const,
};
