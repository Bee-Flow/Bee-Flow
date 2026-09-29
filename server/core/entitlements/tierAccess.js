'use strict';

/**
 * MAY THIS PERSON USE THIS TIER — asked by every place a request picks a
 * model tier.
 *
 * An administrator narrows the tiers per group (`allowedTiers`, the group's
 * Allowed-tiers editor), and userTiers.getPermittedTierKeys turns that, the
 * beta features and the task type into the set the tier dropdown offers
 * (/ai/config/tiers-for-user applies the same rules). This file is how a
 * REQUEST is measured against that set, so the playbook routes and both
 * builders give one answer instead of each copying the rule:
 *
 *   - An explicit tier must be in the set, under the name the set uses:
 *     `deep_thinking` is `pro` (the group editor stores `pro` and labels it
 *     Deep Thinking), `smart` is `thinking` (modelResolver's legacy alias),
 *     and an agent's `tier:` prefix is not part of the name. A name the set
 *     does not know, a typo included, is not allowed.
 *   - `auto` is not a model but a way of choosing one, so it is measured by
 *     what it may choose from: this person's own tiers, never a custom tier
 *     (those are picked by hand) and never swarm. It is refused only when the
 *     workspace has tiers `auto` could choose and none of them is this
 *     person's. With nothing configured at all a caller keeps its own
 *     fallback: that is a configuration question, not a permission one.
 *   - NO tier is not `fast` by fiat. It is the tier a request runs on when
 *     nobody picked one, so it is chosen the way `auto` is when there is no
 *     tier map to rank: the cheapest tier this person may use, which is
 *     `fast` when it is theirs (choose()).
 *
 * The refusal is the same everywhere: 403 `tier_not_permitted`, naming the tier.
 */

const AUTO = 'auto';
const TIER_NOT_PERMITTED = 'tier_not_permitted';

// Names the permitted set does not use, mapped to the one it does.
const PERMISSION_NAME = Object.freeze({ deep_thinking: 'pro', smart: 'thinking' });

// Where `auto` lands when its own policy found nothing this person may use:
// the cheapest first, and `fast` first of all, because it is this product's
// default tier. Keys not listed follow alphabetically.
const CHEAPEST_FIRST = Object.freeze(['fast', 'thinking', 'writer', 'standard', 'pro', 'deep_thinking', 'smart']);

/** The name a tier goes by in the permitted set, or null for no name at all. */
function permissionNameOf(tier) {
    if (typeof tier !== 'string') return null;
    const trimmed = tier.trim();
    const bare = trimmed.startsWith('tier:') ? trimmed.slice('tier:'.length) : trimmed;
    if (!bare) return null;
    return PERMISSION_NAME[bare] || bare;
}

/** A tier `auto` may land on: never itself, never swarm, never a custom tier. */
function autoMayPick(key) {
    return typeof key === 'string' && key !== AUTO && key !== 'swarm' && !key.startsWith('custom:');
}

function isConfigured(entry) {
    return !!(entry && typeof entry.modelId === 'string' && entry.modelId);
}

/** The cheapest of `keys` that `auto` may land on, or null when there is none. */
function cheapestTier(keys) {
    const pool = [...(keys || [])].filter(autoMayPick);
    if (!pool.length) return null;
    const rank = (k) => {
        const i = CHEAPEST_FIRST.indexOf(k);
        return i === -1 ? CHEAPEST_FIRST.length : i;
    };
    return pool.sort((a, b) => (rank(a) - rank(b)) || (a < b ? -1 : a > b ? 1 : 0))[0];
}

/**
 * The questions a caller asks of one person's permitted set.
 * @param {Set<string>|string[]} permitted  getPermittedTierKeys' answer
 */
function tierAccessOf(permitted) {
    const keys = new Set(permitted instanceof Set || Array.isArray(permitted) ? permitted : []);
    const allowsNamed = (tier) => {
        const name = permissionNameOf(tier);
        return !!name && name !== AUTO && keys.has(name);
    };
    const autoPool = [...keys].filter(autoMayPick);
    return {
        /** An explicit pick: may this person run on `tier`? */
        allows(tier) {
            return tier === AUTO ? autoPool.length > 0 : allowsNamed(tier);
        },
        /** The entries of a tier map this person may use. */
        narrow(tiers) {
            return Object.fromEntries(Object.entries(tiers || {}).filter(([k]) => allowsNamed(k)));
        },
        /**
         * What `auto` may choose from in a tier map: this person's configured
         * tiers, minus custom and swarm. `refused` when the map has tiers
         * `auto` could use and none of them is this person's.
         */
        autoChoice(tiers) {
            const eligible = Object.entries(tiers || {}).filter(([k, v]) => autoMayPick(k) && isConfigured(v));
            const candidates = Object.fromEntries(eligible.filter(([k]) => allowsNamed(k)));
            return { candidates, refused: eligible.length > 0 && Object.keys(candidates).length === 0 };
        },
        /** `auto` for a caller that has no tier map: the cheapest tier this person may use. */
        cheapest() {
            return cheapestTier(autoPool);
        },
        /**
         * The tier a request runs on, for a caller that has no tier map (the
         * playbook routes): an explicit tier when it is this person's, under
         * the name it was given; `auto` and no tier at all the cheapest tier
         * they may use, `fast` when it is theirs. A custom tier is never
         * chosen FOR somebody. Null means refuse.
         */
        choose(tier) {
            if (tier === undefined || tier === null || tier === AUTO) return cheapestTier(autoPool);
            return allowsNamed(tier) ? tier : null;
        },
    };
}

/** One person's access, read from the list the tier dropdown is built from. */
async function tierAccessFor({ userId, session = null, taskType = 'direct_chat' } = {}) {
    // Required when asked, so requiring this file costs nothing and a test
    // that stubs userTiers is the list every caller reads.
    const { getPermittedTierKeys } = require('./userTiers');
    return tierAccessOf(await getPermittedTierKeys({ userId, session, taskType }));
}

/** The refusal, in the words every caller gives. */
function tierRefusal(tier) {
    return { status: 403, code: TIER_NOT_PERMITTED, error: `Tier "${String(tier).slice(0, 60)}" is not available on your account.` };
}

module.exports = {
    tierAccessFor,
    tierAccessOf,
    tierRefusal,
    cheapestTier,
    permissionNameOf,
    TIER_NOT_PERMITTED,
};
