/**
 * Automation Builder — POST /summarise-layer: a fast-tier, one-sentence
 * plain-language summary of a single flowlet, plus the guardrails on the
 * mini-definition the client submits.
 *
 * The envelope is strict; the flowlet inside it is not. `layer` is the
 * definition the user is looking at — a flowlet, or the whole root flow the
 * Build tab passes for its own one-liner — so its keys are the definition
 * schema's, not this route's. validateLayerForSummary stays its gate.
 */

const express = require('express');
const log = require('../../../telemetry/log');
const router = express.Router();
const { z } = require('zod');
const { validate } = require('../../../core/http/validate');

const { resolveModelForTierName } = require('../../../core/llm/modelResolver');
const llmClient = require('../../../core/llm/llmClient');
const { summariseDefinition } = require('../../../automation/summarise');
const { requireAuth } = require('../../../auth/permissions');
const { summariseLayerRateLimit } = require('./rateLimits');

const MAX_LAYER_STEPS_FOR_SUMMARY = 200;

/**
 * Validate a flowlet mini-definition submitted for AI summarisation.
 * Returns an error string when rejected, or null when acceptable.
 */
function validateLayerForSummary(layer) {
    if (!layer || typeof layer !== 'object' || Array.isArray(layer) || !Array.isArray(layer.steps)) {
        return 'A flowlet object with a steps array is required.';
    }
    if (layer.steps.length > MAX_LAYER_STEPS_FOR_SUMMARY) {
        return 'Flowlet is too large to summarise.';
    }
    return null;
}

const SummariseLayerBody = z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object({
    layer: z.unknown().superRefine((layer, ctx) => {
        const invalid = validateLayerForSummary(layer);
        if (invalid) ctx.addIssue({ code: z.ZodIssueCode.custom, message: invalid });
    }),
}).strict());

/** Collapse whitespace, strip surrounding quotes, and cap a model summary. */
function sanitiseLayerSummary(raw) {
    return String(raw || '')
        .replace(/\s+/g, ' ')
        .replace(/^["'“”\s]+|["'“”\s]+$/g, '')
        .slice(0, 280)
        .trim();
}

/**
 * POST /summarise-layer — generate a one-sentence, plain-language summary
 * of an automation flowlet (a reusable sub-flow).
 *
 * Body: { layer }  — the flowlet's mini-definition { title, trigger, steps, edges }.
 *
 * The client owns the draft (autosave + undo), so this endpoint is stateless:
 * it takes the flowlet the user is actually looking at (no lag against the
 * persisted row), feeds the deterministic summariseDefinition() rendering to
 * a fast-tier model for a friendly one-liner, and returns { summary }. The
 * client persists it into definition.layers[key].description itself.
 *
 * Opt-in only — the UI gates this behind an off-by-default checkbox — so no
 * tokens are spent unless the user explicitly asks.
 */
router.post('/summarise-layer', requireAuth, summariseLayerRateLimit, validate({ body: SummariseLayerBody }), async (req, res) => {
    const userId = req.session.user.id;
    const { userHasBetaFeature } = require('../../../core/entitlements/betaFeatures');
    const hasFeature = await userHasBetaFeature(userId, 'automations', req.session);
    if (!hasFeature) {
        return res.status(403).json({ error: 'The Automations beta is not enabled for your organisation.' });
    }

    // Bounded by the schema — a real flowlet is a handful of steps, and an
    // obviously malformed/oversized payload never reaches the model.
    const { layer } = req.body;

    // Reuse the deterministic, side-effect-aware renderer the builder
    // already uses everywhere else; the model just makes it friendly.
    const { summary: deterministic } = summariseDefinition(layer);

    const userOrgId = req.session?.user?.organizationId || null;
    const modelId = await resolveModelForTierName('fast', { userOrgId, userId, fallback: 'gemini-2.0-flash-lite' });
    const sys = 'You summarise an automation flow in ONE plain-language sentence (max ~25 words) for a non-technical user. Describe what it accomplishes, not the step types. Output only the sentence — no preamble, no markdown, no quotes.';
    const name = String(layer.title || 'this automation').slice(0, 200);
    const userMsg = `Name: ${name}\n\n${deterministic}`;

    let result;
    try {
        result = await llmClient.chat(modelId, [
            { role: 'system', content: sys },
            { role: 'user', content: userMsg },
        ], { maxTokens: 80, temperature: 0.3, reasoningEffort: 'none', budgetTokens: 0 });
    } catch (e) {
        log.error('[automationBuilder/summarise-layer] inference failed:', e.message);
        return res.status(502).json({ error: 'Could not generate a summary right now. Please try again.' });
    }

    const summary = sanitiseLayerSummary(result?.content);
    return res.json({ summary });
});

module.exports = router;
// Pure helpers, re-exported through the facade's ._test surface.
module.exports.validateLayerForSummary = validateLayerForSummary;
module.exports.sanitiseLayerSummary = sanitiseLayerSummary;
