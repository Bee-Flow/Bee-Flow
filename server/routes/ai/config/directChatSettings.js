// @typecheck noImplicitAny
/**
 * AI Config — direct-chat behaviour: the system prompt, per-tier tool
 * enablement and per-tier tool parameter overrides.
 *
 * All three are INSTANCE-WIDE — one config row each, read by every user's
 * direct chat — and the three writes carried requireAuth only. Any signed-in
 * user could replace the system prompt every other user's chat runs under,
 * switch the tools of a tier off, or pin a tool's parameters for everyone
 * (the tool-params row is merged OVER the model's own arguments at execution
 * time: core/tools/toolExecution.js, `fixedParams`). They now take the same
 * admin gate as the sibling config writes (config/shared.isAdminUser); the
 * only client, the AI Config admin page, already sits behind it.
 *
 * The tool-params READ takes the same gate. Those parameters are pinned
 * precisely because the model must not choose them — an API key, a fixed
 * recipient, an internal URL — so componentToTool hides them from the model
 * and toolRoundExecutor will not even log them ("they often contain
 * secrets"). The GET handed the whole map to any signed-in member. No client
 * reads it; an admin still can. The system prompt and the tier tool lists
 * stay member-readable, as before.
 *
 * The two tier maps are keyed by tier (custom tiers included, so the keys stay
 * open), but their VALUES have one shape each, and a wrong one did not fail
 * here — it failed later, in every chat on that tier: a map of tool ids
 * instead of a list made `enabledToolIds.includes` throw; a string was
 * matched as a substring.
 */

const express = require('express');
const router = express.Router();
const configStore = require('../../../stores/configStore');
const { isAdminUser } = require('./shared');
const { requireAuth } = require('../../../auth/permissions');
const { validate } = require('../../../core/http/validate');
const { z, typeError } = require('../../../utils/zod');
const { orEmpty: bodyOf } = require('../../../core/http/schemaParts');
const { requireAdminUser } = require('../requireAdminUser');

const requireAdmin = requireAdminUser(isAdminUser);

// ── What an admin may send ────────────────────────────────────────────────

const PROMPT_TEXT = 'systemPrompt is the prompt text; send an empty string to use the default.';
const SystemPromptBody = bodyOf(z.object({
    // `systemPrompt || ''` read a misspelled key as "clear it": the prompt
    // was wiped and the page said "saved".
    systemPrompt: z.string({ error: PROMPT_TEXT }),
}).strict());

const TIER_TOOLS_TEXT = 'Each tier maps to a list of component ids.';
/** { [tier]: componentId[] } — directChatToolStack reads `tierTools[tier].includes(id)`. */
const TierToolsBody = bodyOf(z.record(
    z.string(),
    z.array(z.string({ error: typeError({ invalid: TIER_TOOLS_TEXT }) }), { error: typeError({ invalid: TIER_TOOLS_TEXT }) }),
    { error: typeError({ invalid: 'The body maps each tier to its list of component ids.' }) },
));

const TOOL_PARAMS_TEXT = 'Each tool maps to an object of the parameters it is pinned to.';
/** { [tier]: { [toolName]: { [param]: value } } } — spread over the tool's own arguments. */
const TierToolParamsBody = bodyOf(z.record(
    z.string(),
    z.record(z.string(), z.record(z.string(), z.unknown(), { error: typeError({ invalid: TOOL_PARAMS_TEXT }) }),
        { error: typeError({ invalid: 'Each tier maps tool names to their pinned parameters.' }) }),
    { error: typeError({ invalid: 'The body maps each tier to its tools\' pinned parameters.' }) },
));

// ─── Direct Chat System Prompt ───────────────────────────────────

router.get('/config/direct-chat', requireAuth, async (req, res) => {
    const prompt = await configStore.getConfig('direct_chat_system_prompt') || '';
    res.json({ systemPrompt: prompt });
});

router.post('/config/direct-chat', requireAuth, requireAdmin, validate({ body: SystemPromptBody }), async (req, res) => {
    await configStore.setConfig('direct_chat_system_prompt', req.body.systemPrompt);
    res.json({ success: true });
});

// ─── Per-Tier Tool Enablement ────────────────────────────────────

router.get('/config/direct-chat-tools', requireAuth, async (req, res) => {
    const tierTools = await configStore.getConfig('direct_chat_tier_tools') || {};
    res.json(tierTools);
});

router.post('/config/direct-chat-tools', requireAuth, requireAdmin, validate({ body: TierToolsBody }), async (req, res) => {
    await configStore.setConfig('direct_chat_tier_tools', req.body);
    res.json({ success: true });
});

// ─── Per-Tier Tool Parameter Overrides ───────────────────────────

router.get('/config/direct-chat-tool-params', requireAuth, requireAdmin, async (req, res) => {
    const params = await configStore.getConfig('direct_chat_tier_tool_params') || {};
    res.json(params);
});

router.post('/config/direct-chat-tool-params', requireAuth, requireAdmin, validate({ body: TierToolParamsBody }), async (req, res) => {
    await configStore.setConfig('direct_chat_tier_tool_params', req.body);
    res.json({ success: true });
});

module.exports = router;
