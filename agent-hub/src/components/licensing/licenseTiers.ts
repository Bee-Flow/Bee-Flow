// The licence tiers in order, apart from LicenseContext so a test that replaces
// the context still ranks tiers the real way.
//
// MUST stay in sync with server/license/tiers.js → TIER_HIERARCHY.
// The repo's two Docker containers (agent-hub, server) each see only their
// own sub-tree, so a shared module isn't reachable at build time.
//
// Legacy `pro` tier values (from old license keys or Stripe rows minted
// before the Pro tier was retired) are normalised to `enterprise` via
// LEGACY_TIER_ALIAS — same contract as the server side.
export const TIER_HIERARCHY = ['community', 'enterprise', 'full'];
const LEGACY_TIER_ALIAS: Record<string, string> = { pro: 'enterprise' };
export const TIER_RANK: Record<string, number> = Object.fromEntries(TIER_HIERARCHY.map((t, i) => [t, i]));

export function normalizeTier(tier: string) {
    if (typeof tier !== 'string') return tier;
    return LEGACY_TIER_ALIAS[tier] || tier;
}
