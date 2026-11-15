// @typecheck strict
// English GUI defaults — namespace "admin_ai_context": every key whose part before the first "." is "admin_ai_context".
// Merged into GUI_DEFAULTS by ./index.js. The frontend copy (agent-hub/src/i18n/en-defaults.js)
// is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
module.exports = {
    // ── Conversation memory: the worked examples under the safety limit ──
    // The server sends the organisation's largest and smallest model
    // (core/llm/contextWindowExamples.mts); these words build each line.
    'admin_ai_context.example_line': '{label}: about {tokens} tokens',
    // A built-in tier and the model it runs on, e.g. "Fast (Mistral Small 4)".
    'admin_ai_context.example_tier': '{tier} ({model})',
    // No chat model configured yet: a neutral size instead of a model name.
    'admin_ai_context.example_generic': 'A {size}-token model',
};
