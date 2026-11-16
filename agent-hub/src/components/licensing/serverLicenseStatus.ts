// The server-wide licence as GET /api/license/status describes it, read the
// same way by the Server licence page (ServerLicensePanel) and by the
// read-only summary under Access > Ceiling, so the two never disagree about
// which licence governs the install or what its tier is called.

import type { TranslateFn } from '@/hooks/useTranslation';

interface ServerLicenseRecord {
    tier?: string;
    expiresAt?: string | null;
    issuer?: string;
    billingInterval?: string;
}

export interface LicenseStatus {
    serverLicense?: ServerLicenseRecord | null;
    scope?: string;
    serverOverride?: boolean;
    license?: ServerLicenseRecord | null;
}

interface ServerLicenseView {
    /** The server-wide licence, or null when none is applied. */
    licence: ServerLicenseRecord | null;
    /** It governs every organisation on the install (false on cloud, where each organisation has its own subscription). */
    governing: boolean;
    /** The tier the install runs at by this licence: Community without one. */
    tier: string;
}

/**
 * `serverLicense` is present whenever a server-wide row exists, regardless of
 * deployment mode; `serverOverride` says whether it governs the install. An
 * older answer carried the server row as `license` with scope 'server'.
 */
export function serverLicenseView(status: LicenseStatus | null | undefined): ServerLicenseView {
    const licence = status?.serverLicense
        || (status?.scope === 'server' && status?.serverOverride ? status?.license ?? null : null);
    return {
        licence: licence ?? null,
        governing: status?.serverOverride === true,
        tier: licence?.tier || 'community',
    };
}

/** A licence tier's name. Every tier gets the same neutral chip: a tier is not a status. */
export function licenceTierLabel(t: TranslateFn, tier: string): string {
    switch (tier) {
        case 'enterprise': return t('license.tier_enterprise', 'Enterprise');
        case 'full': return t('license.tier_full', 'Full');
        case 'pro': return t('license.tier_pro', 'Pro');
        case 'community': return t('license.tier_community', 'Community');
        default: return tier;
    }
}
