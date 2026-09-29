/**
 * Automation Builder — POST /label-steps: fast-tier auto-label and auto-icon
 * for the steps in a flow.
 *
 * The envelope is strict; `definition` is the draft on screen and keeps the
 * definition schema's keys. `allowedIcons` is the client's renderable icon
 * set and is now a list or a 400: anything else — or the key misspelled —
 * was read as "no icons", so the model got no list and every icon it
 * proposed was filtered out, while the labels came back and it looked like
 * the feature worked.
 */

const express = require('express');
const log = require('../../../telemetry/log');
const router = express.Router();
const { z } = require('zod');
const { validate } = require('../../../core/http/validate');

const { resolveModelForTierName } = require('../../../core/llm/modelResolver');
const llmClient = require('../../../core/llm/llmClient');
const { requireAuth } = require('../../../auth/permissions');
const { summariseLayerRateLimit } = require('./rateLimits');

// ── Auto-label + auto-icon for steps ────────────────────────────────────────
// The builder asks the FAST tier to name each step (a short human label + a
// symbol) so a fresh flow reads cleanly without manual work. The client only
// calls this on a meaningful structural change (debounced), and never sends
// (nor applies to) a field the user set by hand — `labelManual` / `iconManual`
// on a step lock that field. Bounded so a huge flow can't fan out unboundedly.
const MAX_LABEL_STEPS = 60;
const MAX_ALLOWED_ICONS = 300;

const LABEL_STEPS_TOOL = {
    type: 'function',
    function: {
        name: 'label_steps',
        description: 'Provide a short human label and a fitting symbol for each automation step.',
        parameters: {
            type: 'object',
            properties: {
                steps: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            id: { type: 'string', description: 'The step id, copied verbatim from the list.' },
                            label: { type: 'string', description: '2–4 word Title Case label describing what the step accomplishes.' },
                            icon: { type: 'string', description: 'One icon name from the allowed list, or "" if none fits.' },
                        },
                        required: ['id', 'label'],
                    },
                },
            },
            required: ['steps'],
        },
    },
};

const DEFINITION_TEXT = 'A definition with steps is required.';
const ICONS_TEXT = 'allowedIcons is the list of icon names the client can draw.';

const LabelStepsBody = z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object({
    definition: z.unknown().superRefine((def, ctx) => {
        if (!def || typeof def !== 'object' || Array.isArray(def) || !Array.isArray(def.steps)) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: DEFINITION_TEXT });
        }
    }),
    allowedIcons: z.array(z.string({ invalid_type_error: ICONS_TEXT }), { invalid_type_error: ICONS_TEXT })
        .max(MAX_ALLOWED_ICONS, `allowedIcons holds at most ${MAX_ALLOWED_ICONS} icon names.`).optional(),
}).strict());

// Compact, deterministic one-liner describing a step's purpose for the namer.
function describeStepForLabel(s) {
    const bits = [`type=${s.type}`];
    if (s.tool) bits.push(`tool=${s.tool}`);
    if (s.appId) bits.push(`app=${s.appId}`);
    if (s.kind) bits.push(`kind=${s.kind}`);
    if (s.op) bits.push(`op=${s.op}`);
    if (s.blockId) bits.push('reusable-step');
    if (s.layerKey) bits.push(`flowlet=${s.layerKey}`);
    if (s.appEvent?.provider) bits.push(`event=${s.appEvent.provider}.${s.appEvent.event || ''}`);
    if (s.expr) bits.push(`expr=${String(s.expr).slice(0, 80)}`);
    if (typeof s.prompt === 'string' && s.prompt.trim()) bits.push(`prompt=${s.prompt.slice(0, 160)}`);
    if (typeof s.title === 'string' && s.title.trim()) bits.push(`title=${s.title.slice(0, 80)}`);
    if (typeof s.body === 'string' && s.body.trim()) bits.push(`body=${s.body.slice(0, 80)}`);
    return bits.join(' · ');
}

/**
 * POST /label-steps — name the steps in a flow with the FAST tier.
 *
 * Body: { definition, allowedIcons }
 *   - definition  : the draft the user is looking at (stateless, like
 *                   summarise-layer — no lag against the persisted row).
 *   - allowedIcons: the icon names the client can render; the model must pick
 *                   from these (single source of truth lives on the client).
 *
 * Returns { labels: { [stepId]: { label?, icon? } } } — only for steps whose
 * corresponding field is NOT locked (`labelManual` / `iconManual`). The client
 * applies them and never overwrites a manual edit.
 */
router.post('/label-steps', requireAuth, summariseLayerRateLimit, validate({ body: LabelStepsBody }), async (req, res) => {
    const userId = req.session.user.id;
    const { userHasBetaFeature } = require('../../../core/entitlements/betaFeatures');
    if (!await userHasBetaFeature(userId, 'automations', req.session)) {
        return res.status(403).json({ error: 'The Automations beta is not enabled for your organisation.' });
    }

    const def = req.body.definition;
    // Absent means "labels only": no icon can pass the allowedSet filter below.
    const allowedIcons = req.body.allowedIcons || [];
    const allowedSet = new Set(allowedIcons);

    // Collect non-output steps with at least one unlocked field.
    const { walkSteps } = require('../../../automation/stepContract');
    const targets = [];
    walkSteps(def.steps, (s) => {
        if (!s.id || s.type === 'layer_output') return;
        // Only fill a field that is BOTH unlocked (not user-set) AND empty —
        // so we never overwrite a manual edit or churn an existing label.
        const needLabel = !s.labelManual && !(typeof s.label === 'string' && s.label.trim());
        const needIcon = !s.iconManual && !(typeof s.icon === 'string' && s.icon.trim());
        if (needLabel || needIcon) targets.push({ id: s.id, needLabel, needIcon, desc: describeStepForLabel(s) });
    });
    if (targets.length === 0) return res.json({ labels: {} });
    const bounded = targets.slice(0, MAX_LABEL_STEPS);

    const userOrgId = req.session?.user?.organizationId || null;
    const modelId = await resolveModelForTierName('fast', { userOrgId, userId, fallback: 'gemini-2.0-flash-lite' });

    const sys = 'You label steps in an automation flow for a non-technical user. For each step return: "label" — a 2–4 word Title Case name describing what the step accomplishes (not its technical type); and "icon" — the single best-fitting icon NAME chosen ONLY from the provided allowed list (or "" if none fits). Copy each step id verbatim. Keep labels concise and human.';
    const iconList = allowedIcons.length ? `Allowed icon names:\n${allowedIcons.join(', ')}\n\n` : '';
    const stepLines = bounded.map((t, i) => `${i + 1}. id=${t.id} · ${t.desc}`).join('\n');
    const userMsg = `${iconList}Steps to label:\n${stepLines}`;

    let structured;
    try {
        ({ structured } = await llmClient.chatForcedTool(modelId, [
            { role: 'system', content: sys },
            { role: 'user', content: userMsg },
        ], LABEL_STEPS_TOOL, { maxTokens: 1024, temperature: 0.2, reasoningEffort: 'none', budgetTokens: 0 }));
    } catch (e) {
        log.error('[automationBuilder/label-steps] inference failed:', e.message);
        return res.status(502).json({ error: 'Could not generate labels right now.' });
    }

    const targetById = new Map(bounded.map(t => [t.id, t]));
    const labels = {};
    for (const row of (structured?.steps || [])) {
        const t = row && row.id && targetById.get(row.id);
        if (!t) continue;
        const entry = {};
        if (t.needLabel && typeof row.label === 'string' && row.label.trim()) {
            entry.label = row.label.trim().slice(0, 60);
        }
        if (t.needIcon && typeof row.icon === 'string' && allowedSet.has(row.icon)) {
            entry.icon = row.icon;
        }
        if (Object.keys(entry).length) labels[t.id] = entry;
    }
    return res.json({ labels });
});

module.exports = router;
