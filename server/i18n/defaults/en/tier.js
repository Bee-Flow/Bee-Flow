// English GUI defaults — namespace "tier": every key whose part before the first "." is "tier".
// Merged into GUI_DEFAULTS by ./index.js. The frontend copy (agent-hub/src/i18n/en-defaults.js)
// is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
module.exports = {
    // ── Model tiers ────────────────────────────────────────────────────
    // The names TIER_META carries as English constants. `pro` is deliberately
    // absent: it is an alias of deep_thinking and shares that key, so the same
    // tier cannot end up answering in two different words.
    'tier.auto': 'Auto',
    'tier.fast': 'Fast',
    'tier.standard': 'Flow',
    'tier.swarm': 'Swarm',
    'tier.thinking': 'Think',
    'tier.writer': 'Write',
    'tier.deep_thinking': 'Deep Thinking',
};
