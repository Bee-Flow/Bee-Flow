// @typecheck strict
// English GUI defaults, namespace "ai_model_setup": every key whose part before the first "." is "ai_model_setup".
// The model set-up screens of AI configuration: the Claude models block on the chat-model page (shown only
// when a Claude model is configured, so its notes name Claude models) and the Embeddings pane.
// Merged into GUI_DEFAULTS by ./index.js. The frontend copy (agent-hub/src/i18n/en-defaults.js)
// is GENERATED from these files: after an edit, run `npm run i18n:gen`.
module.exports = {
    "ai_model_setup.claude_applied_one": "Recommended settings applied to 1 tier. Click Save Tier Configuration to keep them.",
    "ai_model_setup.claude_applied_some": "Recommended settings applied to {n} tiers. Click Save Tier Configuration to keep them.",
    "ai_model_setup.claude_apply_all_confirm_desc": "This replaces the model and settings of {n} tiers ({tiers}). Tiers whose recommended model this server does not offer keep what they have. Nothing is saved until you click Save Tier Configuration.",
    "ai_model_setup.claude_apply_all_confirm_desc_one": "This replaces the model and settings of 1 tier ({tiers}). Tiers whose recommended model this server does not offer keep what they have. Nothing is saved until you click Save Tier Configuration.",
    "ai_model_setup.claude_apply_all_confirm_title": "Apply the recommended settings?",
    "ai_model_setup.claude_rec_none_available": "None of the recommended models is offered by a provider on this server.",
    "ai_model_setup.claude_rec_note_fast": "Haiku 4.5 has no adaptive thinking, so effort stays off.",
    "ai_model_setup.claude_rec_note_pro": "Opus 4.7 thinks adaptively only: effort sets the thinking budget internally.",
    "ai_model_setup.claude_rec_note_standard": "Flow: multi-stage workflow with light adaptive thinking.",
    "ai_model_setup.claude_rec_note_swarm": "Per-agent depth handled by the swarm runtime.",
    "ai_model_setup.claude_rec_note_thinking": "Sonnet 5 thinks adaptively only: Effort sets the depth (no manual budget).",
    "ai_model_setup.claude_rec_note_writer": "Long-form prose with light adaptive thinking.",
    "ai_model_setup.claude_rec_unavailable": "This model is not offered on this server.",
    "ai_model_setup.embed_model_hint": "Pick an embedding model this provider offers. Changing it later re-indexes your knowledge bases.",
    "ai_model_setup.embed_no_providers": "No connected provider offers embedding models. Connect one under Providers.",
};
