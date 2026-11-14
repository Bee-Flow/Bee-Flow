// @typecheck strict
/**
 * The model tiers a playbook phase may run on.
 */

'use strict';

// The depth axis the dialog offers (licensing/tierMeta DEPTH_TIER_KEYS), plus
// `standard`: which of them a given person may pick is decided there against
// /ai/config/tiers-for-user; this set only keeps an unknown string out of the
// builder's `modelTier`. `pro` and `deep_thinking` are the same tier.
const TIERS = new Set(['fast', 'auto', 'standard', 'thinking', 'pro', 'deep_thinking']);

module.exports = { TIERS };
