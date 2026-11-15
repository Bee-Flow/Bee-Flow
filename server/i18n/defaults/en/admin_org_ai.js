// @typecheck strict
// English GUI defaults — namespace "admin_org_ai": every key whose part before the first "." is "admin_org_ai".
// Merged into GUI_DEFAULTS by ./index.js. The frontend copy (agent-hub/src/i18n/en-defaults.js)
// is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
//
// The organisation's AI editors in the admin dashboard (agent-hub admin/org:
// OrgAiContextEditor, OrgMemoryEditor, OrgCollabEditor, OrgIntegrationCacheEditor
// and the load state they share). A counted phrase is a pair: the base key for
// one, `<key>_plural` for any other count (utils/plural.ts nOf).
module.exports = {
    // ── Shared ──
    'admin_org_ai.retry': 'Try again',
    // Under a switch that saves on its own, next to its save status.
    'admin_org_ai.applies_immediately': 'Applies immediately',

    // ── Context in long conversations ──
    // {count} is the organisation's own threshold (the server sends it).
    'admin_org_ai.context_on_desc': 'Once a chat passes about {count} messages, everything older is replaced by a short summary and long tool results are shortened. Cheaper, but detail from earlier in the conversation is permanently lost to the assistant.',
    // {model} is a model's display name, as the server administrator configured it.
    'admin_org_ai.context_runs_on': 'Summaries are written by {model}, which the server administrator chooses.',

    // ── Memory ──
    'admin_org_ai.memory_settings_title': 'Memory in this organisation',
    'admin_org_ai.memory_runs_on': 'Memories are picked out of chats by {model}, which the server administrator chooses.',

    // ── Reusing answers between runs ──
    'admin_org_ai.cache_intro': 'Automations often ask the same question over and over: of a connected app, of a web service they call directly, or of an AI model in an AI step. This decides whether the answer may be stored so a later run can use it, which means storing what the other side sent back.',
    'admin_org_ai.cache_minutes': '1 minute',
    'admin_org_ai.cache_minutes_plural': '{count} minutes',
    'admin_org_ai.cache_held': 'Stored right now: 1 answer, {size}.',
    'admin_org_ai.cache_held_plural': 'Stored right now: {count} answers, {size}.',
    'admin_org_ai.cache_held_expired': '1 of those has already expired and is never served. The hourly clean-up deletes it, or the button below does.',
    'admin_org_ai.cache_held_expired_plural': '{count} of those have already expired and are never served. The hourly clean-up deletes them, or the button below does.',
    'admin_org_ai.cache_clear': 'Delete the stored answer now',
    'admin_org_ai.cache_clear_plural': 'Delete the {count} stored answers now',
    'admin_org_ai.cache_clear_title': 'Delete the stored answers?',
    'admin_org_ai.cache_clear_desc': 'Every answer this organisation has stored is deleted now. Later runs ask the app, service or model again, so nothing else is lost.',
    'admin_org_ai.cache_clear_confirm': 'Delete answers',
};
