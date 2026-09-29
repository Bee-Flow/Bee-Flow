/**
 * AI Config — the AI regex generator: an admin-only tool loop that drafts
 * regex guardrail rules through the Regex Generator agent.
 *
 * A model tier the caller NAMED is honoured or refused, never swapped. The
 * lookup was `tiers[modelTier] || {}` and then the global default model, so a
 * tier that is not configured — misspelled, or one the picker's hard-coded
 * list used to offer (`think`, `write`, `deep_thinking`) — generated the
 * org's guardrail rules on whichever model happened to be the default, and
 * the page said "generated". Sending no tier still means the fast tier, then
 * the default model: that is what the page does when no tier is configured.
 */

const express = require('express');
const log = require('../../../telemetry/log');
const router = express.Router();
const { getAIConfig } = require('../../../core/aiAgent');
const configStore = require('../../../stores/configStore');
const { isAdminUser } = require('./shared');
const { requireAuth } = require('../../../auth/permissions');
const { validate } = require('../../../core/http/validate');
const { HttpError } = require('../../../core/http/errors');
const { z } = require('zod');

// Only admins can generate regex rules — and only an admin learns what the
// schema below refuses.
async function requireAdmin(req, res, next) {
    if (!(await isAdminUser(req))) return res.status(403).json({ error: 'Admin access required' });
    next();
}

const PROMPT_TEXT = 'Prompt is required';
const GenerateRegexBody = z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object({
    prompt: z.string({ required_error: PROMPT_TEXT, invalid_type_error: PROMPT_TEXT }).trim().min(1, PROMPT_TEXT),
    // '' is the page's "no tier picked" (its picker is empty until the
    // configured tiers load).
    modelTier: z.string({ invalid_type_error: 'modelTier is the name of a configured model tier.' }).trim().optional(),
}).strict());

// ─── AI Regex Generator ──────────────────────────────────────────
router.post('/generate-regex', requireAuth, requireAdmin, validate({ body: GenerateRegexBody }), async (req, res) => {
    const { prompt, modelTier } = req.body;

    // Resolve model from tier config (same system as direct chat)
    const tiers = await configStore.getConfig('chat_model_tiers') || {};
    if (modelTier && !tiers[modelTier]?.modelId) {
        throw new HttpError(400, 'tier_not_configured', `The model tier '${modelTier.slice(0, 40)}' has no model configured. Pick one of the configured tiers.`);
    }

    const { REGEX_GENERATOR_AGENT_ID } = require('../../../stores/agentStore');
    const agentStore = require('../../../stores/agentStore');
    const { getProviderForModel } = require('../../../core/aiAgent');
    const { getAdapter } = require('../../../core/providers');
    const { sanitizeMessages } = require('../../../utils/messageUtils');
    const { REGEX_GENERATOR_TOOLS, executeRegexGeneratorTool, deduplicateCollections } = require('../../../integrations/regexGeneratorTools');

    const agent = await agentStore.getAgent(REGEX_GENERATOR_AGENT_ID);
    if (!agent) throw new Error('Regex Generator agent not found');

    const resolvedTier = modelTier || 'fast';
    const tier = tiers[resolvedTier] || {};
    const modelToUse = tier.modelId || (await getAIConfig()).model || 'mistral-small-latest';
    const config = await getProviderForModel(modelToUse);

    const messages = [
        { role: 'system', content: agent.system_prompt },
        { role: 'user', content: prompt }
    ];

    // Tool execution loop
    let iterations = 0;
    const maxIterations = 10;

    while (iterations < maxIterations) {
        iterations++;

        const adapter = getAdapter(null, config.url);
        let apiUrl = config.url.replace(/\/$/, '');
        if (!apiUrl.endsWith('/v1')) apiUrl = `${apiUrl}/v1`;

        const requestBody = adapter.buildRequestBody(modelToUse, sanitizeMessages(messages), {
            maxTokens: 4000,
            temperature: 0.7,
            tools: REGEX_GENERATOR_TOOLS,
            toolChoice: 'auto',
        });

        const headers = { 'Content-Type': 'application/json' };
        if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;

        const response = await fetch(`${apiUrl}/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`AI API error: ${response.status} - ${error}`);
        }

        const data = await response.json();
        const choice = data.choices?.[0];
        if (!choice) throw new Error('No response from AI');

        const assistantMsg = choice.message;
        messages.push(assistantMsg);

        // If no tool calls, we're done
        if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
            await deduplicateCollections();
            const aiConfig = await getAIConfig();
            const regexGuardrails = aiConfig.regexGuardrails || { rules: [], collections: [] };
            return res.json({
                success: true,
                message: assistantMsg.content || 'Rules generated',
                regexGuardrails
            });
        }

        // Execute tool calls
        for (const toolCall of assistantMsg.tool_calls) {
            const toolName = toolCall.function.name;
            const toolArgs = JSON.parse(toolCall.function.arguments || '{}');
            log.info(`[RegexGenerator] Executing tool: ${toolName}`, toolArgs);

            const result = await executeRegexGeneratorTool(toolName, toolArgs);
            messages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                content: JSON.stringify(result)
            });
        }
    }

    // Max iterations reached
    await deduplicateCollections();
    const aiConfig = await getAIConfig();
    const regexGuardrails = aiConfig.regexGuardrails || { rules: [], collections: [] };
    res.json({
        success: true,
        message: 'Rules generated (max iterations reached)',
        regexGuardrails
    });
});

module.exports = router;
