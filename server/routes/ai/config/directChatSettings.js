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
const log = require('../../../telemetry/log');
const router = express.Router();
const configStore = require('../../../stores/configStore');
const { isAdminUser } = require('./shared');
const { requireAuth } = require('../../../auth/permissions');
const { validate } = require('../../../core/http/validate');
const { z } = require('zod');

async function requireAdmin(req, res, next) {
    if (!(await isAdminUser(req))) return res.status(403).json({ error: 'Admin access required' });
    next();
}

// ── What an admin may send ────────────────────────────────────────────────

/** An absent body is an empty one, so each missing field gets its sentence rather than "Required". */
const bodyOf = (schema) => z.preprocess((v) => (v === undefined || v === null ? {} : v), schema);

const PROMPT_TEXT = 'systemPrompt is the prompt text; send an empty string to use the default.';
const SystemPromptBody = bodyOf(z.object({
    // `systemPrompt || ''` read a misspelled key as "clear it": the prompt
    // was wiped and the page said "saved".
    systemPrompt: z.string({ required_error: PROMPT_TEXT, invalid_type_error: PROMPT_TEXT }),
}).strict());

const TIER_TOOLS_TEXT = 'Each tier maps to a list of component ids.';
/** { [tier]: componentId[] } — directChatToolStack reads `tierTools[tier].includes(id)`. */
const TierToolsBody = bodyOf(z.record(
    z.string(),
    z.array(z.string({ invalid_type_error: TIER_TOOLS_TEXT }), { invalid_type_error: TIER_TOOLS_TEXT }),
    { invalid_type_error: 'The body maps each tier to its list of component ids.' },
));

const TOOL_PARAMS_TEXT = 'Each tool maps to an object of the parameters it is pinned to.';
/** { [tier]: { [toolName]: { [param]: value } } } — spread over the tool's own arguments. */
const TierToolParamsBody = bodyOf(z.record(
    z.string(),
    z.record(z.string(), z.record(z.string(), z.unknown(), { invalid_type_error: TOOL_PARAMS_TEXT }),
        { invalid_type_error: 'Each tier maps tool names to their pinned parameters.' }),
    { invalid_type_error: 'The body maps each tier to its tools\' pinned parameters.' },
));

// ─── Direct Chat System Prompt ───────────────────────────────────

router.get('/config/direct-chat', requireAuth, async (req, res) => {
    try {
        const prompt = await configStore.getConfig('direct_chat_system_prompt') || '';
        res.json({ systemPrompt: prompt });
    } catch (e) {
        res.status(500).json({ error: 'Failed to fetch config' });
    }
});

router.post('/config/direct-chat', requireAuth, requireAdmin, validate({ body: SystemPromptBody }), async (req, res) => {
    try {
        await configStore.setConfig('direct_chat_system_prompt', req.body.systemPrompt);
        res.json({ success: true });
    } catch (e) {
        log.error('Failed to save direct chat config:', e);
        res.status(500).json({ error: 'Failed to save config' });
    }
});

// ─── Per-Tier Tool Enablement ────────────────────────────────────

router.get('/config/direct-chat-tools', requireAuth, async (req, res) => {
    try {
        const tierTools = await configStore.getConfig('direct_chat_tier_tools') || {};
        res.json(tierTools);
    } catch (e) {
        res.status(500).json({ error: 'Failed to fetch config' });
    }
});

router.post('/config/direct-chat-tools', requireAuth, requireAdmin, validate({ body: TierToolsBody }), async (req, res) => {
    try {
        await configStore.setConfig('direct_chat_tier_tools', req.body);
        res.json({ success: true });
    } catch (e) {
        log.error('Failed to save direct chat tools config:', e);
        res.status(500).json({ error: 'Failed to save config' });
    }
});

// ─── Per-Tier Tool Parameter Overrides ───────────────────────────

router.get('/config/direct-chat-tool-params', requireAuth, requireAdmin, async (req, res) => {
    try {
        const params = await configStore.getConfig('direct_chat_tier_tool_params') || {};
        res.json(params);
    } catch (e) {
        res.status(500).json({ error: 'Failed to fetch config' });
    }
});

router.post('/config/direct-chat-tool-params', requireAuth, requireAdmin, validate({ body: TierToolParamsBody }), async (req, res) => {
    try {
        await configStore.setConfig('direct_chat_tier_tool_params', req.body);
        res.json({ success: true });
    } catch (e) {
        log.error('Failed to save direct chat tool params config:', e);
        res.status(500).json({ error: 'Failed to save config' });
    }
});

module.exports = router;
