/**
 * Automation Builder — the per-user rate limits guarding the builder routes.
 *
 * One limiter per surface, each holding its own counters. They live together
 * here so a budget stays in exactly one place no matter which route spends it.
 */

const { perUserRateLimit } = require('../../../utils/perUserRateLimit');

// Each builder turn is a multi-iteration LLM conversation that can chain
// many tool calls and a dry-run — i.e. expensive. Cap to 12/min/user so a
// runaway client (or a malicious script) can't burn through tokens.
const builderRateLimit = perUserRateLimit({ windowMs: 60_000, max: 12 });

// One cheap (fast-tier) completion per call. 20/min/user is plenty for a
// human clicking "Summarize" across a handful of flowlets and starves a
// script that tries to use it as a free LLM proxy.
const summariseLayerRateLimit = perUserRateLimit({ windowMs: 60_000, max: 20 });

// A flowlet-agent run is a full thinking-model tool loop — heavier than a
// chat turn. 8/min/user is plenty for clicking "Build a flowlet with AI" a
// few times and starves abuse.
const layerAgentRateLimit = perUserRateLimit({ windowMs: 60_000, max: 8 });

// Map-with-AI is an interactive button the user may click several times a
// minute while refining a parse_json step. Its own limiter (rather than
// sharing summariseLayerRateLimit) so those clicks don't compete with the
// autosave-driven label-steps/summarise traffic. One cheap fast-tier call
// per click; 20/min/user starves a script using it as a free LLM proxy.
const mapJsonFieldsRateLimit = perUserRateLimit({ windowMs: 60_000, max: 20 });

// The Condition node's "ask the AI" fallback. It only fires when the OFFLINE
// catalogue (agent-hub .../settings/routeIntents.js) did not understand the
// sentence, so a human hits it far less often than Map-with-AI: they type,
// read the offline answer, and only reach for this when it was not enough.
// One cheap fast-tier call per click; 10/min/user covers rewording a
// stubborn sentence a few times and starves a script using it as a free LLM
// proxy.
const routeRulesRateLimit = perUserRateLimit({ windowMs: 60_000, max: 10 });

// "Check the sample rows" for the Condition node's "is about" rules: one
// in-cluster classifier call per click, no LLM. 20/min/user covers an author
// tuning topics and sensitivity; it is not a free classification API.
const topicPreviewRateLimit = perUserRateLimit({ windowMs: 60_000, max: 20 });

// A suggestion scan is a read-only tool loop (or a single forced synthesis when
// activity is dense) — the heaviest fast-path call here. 10/min/user comfortably
// covers a human clicking "Scan for ideas" / "Re-scan" while iterating, and the
// FE surfaces a friendly cooldown on 429 instead of a hard error.
const suggestRateLimit = perUserRateLimit({ windowMs: 60_000, max: 10 });

// Recording suggestion feedback (dismiss / built / asked) is a cheap DB upsert;
// 30/min/user is plenty for clicking through cards and starves abuse.
const feedbackRateLimit = perUserRateLimit({ windowMs: 60_000, max: 30 });

module.exports = {
    builderRateLimit,
    summariseLayerRateLimit,
    layerAgentRateLimit,
    mapJsonFieldsRateLimit,
    routeRulesRateLimit,
    topicPreviewRateLimit,
    suggestRateLimit,
    feedbackRateLimit,
};
