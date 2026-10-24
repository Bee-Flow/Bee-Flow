// @typecheck
/**
 * AI Config — the model cost table: public read, admin config view and
 * cost updates/resets.
 *
 * The overrides written here are meant to be what every usage row is billed
 * at, instance wide — core/llm/modelCosts.getModelCost checks them first —
 * and the write carried requireAuth only. It now takes the admin gate of the
 * sibling config writes (config/shared.isAdminUser).
 *
 * The config view could not have worked since it was split out of config.js:
 * it called `.map` on the PROMISE of usageStore.getUsageModels() and spread
 * the promise of getAllCachedModelIds(), so every call was a TypeError and a
 * 500. Both are awaited now.
 *
 * The override store underneath was fixed in core/llm/modelCosts.js (it read
 * the async config row synchronously, so no override was ever billed and each
 * save erased the others). Its setModelCost/resetModelCost now return the
 * write, and each one is awaited here: a save that failed is not a 200.
 */

const express = require('express');
const log = require('../../../telemetry/log');
const router = express.Router();
const { requireAuth } = require('../../../auth/permissions');
const { isAdminUser } = require('./shared');
const { validate } = require('../../../core/http/validate');
const { z, typeError } = require('../../../utils/zod');
const { requireAdminUser } = require('../requireAdminUser');

const requireAdmin = requireAdminUser(isAdminUser);

// ── What an admin may send ────────────────────────────────────────────────
// Each entry either prices a model or resets it. The loop below used to skip
// whatever did not fit — no model, a price missing or null — and `reset` was
// read for truthiness, so `reset: "false"` RESET the model it came to price.
// setModelCost stores Number(input): "2,5" became NaN, '' became a free model.

const COSTS_TEXT = 'costs must be an array of { model, input, output }';
const price = (which) => z.number({ error: typeError({ invalid: `The ${which} price is a number (per million tokens).` }) })
    .nonnegative(`The ${which} price cannot be negative.`);

const CostEntry = z.object({
    model: z.string({ error: 'Each cost names the model it prices.' })
        .trim().min(1, 'Each cost names the model it prices.'),
    input: price('input').optional(),
    output: price('output').optional(),
    reset: z.boolean({ error: typeError({ invalid: 'reset is true or false.' }) }).optional(),
}, { error: typeError({ invalid: COSTS_TEXT }) }).strict().superRefine((c, ctx) => {
    if (c.reset) return;
    if (c.input === undefined || c.output === undefined) {
        ctx.addIssue({
            code: 'custom',
            path: [c.input === undefined ? 'input' : 'output'],
            message: `The cost of ${c.model} needs both an input and an output price — or reset: true to go back to the default.`,
        });
    }
});

const CostsBody = z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object({
    costs: z.array(CostEntry, { error: COSTS_TEXT }),
}).strict());

// ─── Model Costs ─────────────────────────────────────────────────
// GET /model-costs is a public read (auth/accessRegistry.sweep.test.js).

router.get('/model-costs', async (req, res) => {
    try {
        const { getAllModelCosts } = require('../../../core/llm/modelCosts');
        res.json(getAllModelCosts());
    } catch (e) {
        log.error('[AI] model-costs error:', e);
        res.json({});
    }
});

router.get('/model-costs-config', requireAuth, async (req, res) => {
    const { getModelCostsForConfig } = require('../../../core/llm/modelCosts');
    const { getAllCachedModelIds } = require('../../../core/aiAgent');
    const usageStore = require('../../../stores/usageStore');

    // Provider models come as { id, providerName, providerType } objects
    const providerModels = await getAllCachedModelIds();
    // Used models come as plain strings (model IDs from usage log)
    const usedModels = (await usageStore.getUsageModels()).map(id => ({ id, providerName: null }));

    // Combine: provider models first (with provider info), then used models
    const allEntries = [...providerModels, ...usedModels];

    res.json({ costs: getModelCostsForConfig(allEntries) });
});

router.post('/model-costs', requireAuth, requireAdmin, validate({ body: CostsBody }), async (req, res) => {
    const { setModelCost, resetModelCost } = require('../../../core/llm/modelCosts');

    // One at a time, in the order sent; a write that fails ends the request
    // there (Express 5 hands the rejection to the terminal handler, a 500).
    let updated = 0;
    let reset = 0;
    for (const c of req.body.costs) {
        if (c.reset) {
            await resetModelCost(c.model);
            reset++;
        } else {
            await setModelCost(c.model, c.input, c.output);
            updated++;
        }
    }

    log.info(`[AI] Model costs updated: ${updated} set, ${reset} reset`);
    res.json({ success: true, updated, reset });
});

module.exports = router;
