/**
 * The licence tier ladder. MUST match server/license/tiers.js TIER_HIERARCHY
 * and LEGACY_TIER_ALIAS, which the web copies too (LicenseContext.jsx,
 * EntitlementsContext.jsx); access.lockstep.test.ts reads all three.
 */

export const TIER_HIERARCHY = ['community', 'enterprise', 'full'] as const;

/** Tier values minted before the Pro tier was retired. */
export const LEGACY_TIER_ALIAS: Readonly<Record<string, string>> = { pro: 'enterprise' };

/** An absent tier reads as community, the floor every installation has. */
export function normalizeTier(tier: string | null | undefined): string {
    if (!tier) return 'community';
    return LEGACY_TIER_ALIAS[tier] ?? tier;
}

/** Rank on the ladder, or null for a name the ladder does not know. */
function rankOf(tier: string): number | null {
    const index = (TIER_HIERARCHY as readonly string[]).indexOf(normalizeTier(tier));
    return index === -1 ? null : index;
}

/**
 * Is `current` at least `required`? An unknown current tier ranks below
 * everything and an unknown required tier above everything, so a typo in
 * either direction reads as "no" (the web's `?? -1` / `?? 99`).
 */
export function tierAtLeast(current: string, required: string): boolean {
    return (rankOf(current) ?? -1) >= (rankOf(required) ?? 99);
}
