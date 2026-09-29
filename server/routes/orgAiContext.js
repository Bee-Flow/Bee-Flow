/**
 * Organization AI Context API
 *
 * One org-level switch: whether long conversations get locally COMPACTED —
 * older turns folded into a fast-tier summary and long tool results truncated.
 *
 * Default OFF. Compaction is a lossy rewrite of the user's conversation, and
 * on a model with a 1M-token context window it throws information away long
 * before the context window is under any pressure — which is what users
 * experience as "the assistant forgot what we talked about". With it off, the
 * provider's own server-side context management does the trimming losslessly
 * and an emergency fold still protects against overrunning the context window.
 *
 * Storage + resolution: core/llm/contextPolicy.js (configStore key
 * `org_ai_context_<orgId>`). This route only reads and writes that row.
 */

const express = require('express');
const log = require('../telemetry/log');
const router = express.Router();
const configStore = require('../stores/configStore');
const { resolveUserOrgIds } = require('../auth');
const { requireAuth, isOrgAdminForOrg: isOrgAdmin } = require('../auth/permissions');
const {
    normalizePolicy,
    invalidateContextPolicy,
    contextWindowExamples,
    CONFIG_KEY_PREFIX,
    MIN_CONTEXT_BUDGET_PERCENT,
    MAX_CONTEXT_BUDGET_PERCENT,
} = require('../core/llm/contextPolicy');
const { validate } = require('../core/http/validate');
const { z } = require('zod');

// ── What a caller may send ──────────────────────────────────────────
//
// The save is a full replace of the one switch that decides whether this
// organisation's conversations get rewritten, so the body is `.strict()` and
// `compactionEnabled` is REQUIRED:
//
//   - the handler wrote `!!compactionEnabled`, so the STRING "false" switched
//     lossy compaction ON for every member, under "saved";
//   - a body that left the switch out — or spelled it `compactionEnabeld` —
//     wrote an explicit OFF under a 200: over an org that had it on, and over
//     the BEEFLOW_CHAT_COMPACTION_DEFAULT an operator had set, because
//     normalizePolicy only falls back to that default for a non-boolean and
//     the route had already turned `undefined` into `false`.
//
// The three tunables stay CLAMPED rather than refused — normalizePolicy owns
// the range, and routes/orgAiContext.test.js pins why: an out-of-range number
// is an admin typo whose intent is clear. A value that is not a number at all
// has no intent to clamp towards; it used to become the default under
// "saved", so it is refused.

/** A body that also accepts no body: Express 5 leaves `req.body` undefined then. */
const bodyOf = (shape) => z.preprocess(
    (v) => (v === undefined || v === null ? {} : v),
    z.object(shape, { invalid_type_error: 'Send the settings as a JSON object.' }).strict(),
);

const SWITCH_TEXT = 'Say whether compaction is on: compactionEnabled is true or false.';
const tunable = (name) => z.number({ invalid_type_error: `${name} is a number.` }).optional();

const PolicyBody = bodyOf({
    compactionEnabled: z.boolean({ required_error: SWITCH_TEXT, invalid_type_error: SWITCH_TEXT }),
    compactionThreshold: tunable('compactionThreshold'),
    recentWindow: tunable('recentWindow'),
    contextBudgetPercent: tunable('contextBudgetPercent'),
});

// GET /:orgId — current policy (any member of the org may read it)
router.get('/:orgId', requireAuth, async (req, res) => {
    try {
        const { orgId } = req.params;
        const orgIds = await resolveUserOrgIds(req);
        const isMember = orgIds === null || (orgIds && orgIds.has(orgId));
        if (!isMember) return res.status(403).json({ error: 'Not a member of this organization' });

        const stored = await configStore.getConfig(`${CONFIG_KEY_PREFIX}${orgId}`);
        res.json({
            ...normalizePolicy(stored),
            // Lets the SPA distinguish "never configured" from "explicitly off".
            configured: !!stored,
            // So the screen can show what a percentage means in real tokens
            // without shipping a second copy of the context-window table.
            contextWindowExamples: contextWindowExamples(),
            contextBudgetRange: {
                min: MIN_CONTEXT_BUDGET_PERCENT,
                max: MAX_CONTEXT_BUDGET_PERCENT,
            },
        });
    } catch (err) {
        log.error('[OrgAiContext] GET failed:', err.message);
        res.status(500).json({ error: 'Failed to load AI context settings' });
    }
});

// PUT /:orgId — save (org admin or super admin only)
router.put('/:orgId', requireAuth, validate({ body: PolicyBody }), async (req, res) => {
    try {
        const { orgId } = req.params;
        if (!(await isOrgAdmin(req, orgId))) {
            return res.status(403).json({ error: 'Only organization admins can change AI context settings' });
        }

        const { compactionEnabled, compactionThreshold, recentWindow, contextBudgetPercent } = req.body;
        // normalizePolicy clamps the numbers and resolves the default of an
        // absent one, so a hand-rolled body can never write an unusable row.
        const policy = normalizePolicy({
            compactionEnabled,
            compactionThreshold,
            recentWindow,
            contextBudgetPercent,
        });

        await configStore.setConfig(`${CONFIG_KEY_PREFIX}${orgId}`, {
            ...policy,
            updatedAt: new Date().toISOString(),
            updatedBy: req.session?.user?.id || null,
        });
        // The runtime memoises the policy for 30 s; drop it so the admin sees
        // the change take effect on their very next message.
        invalidateContextPolicy(orgId);

        log.info(`[OrgAiContext] org ${orgId}: compaction ${policy.compactionEnabled ? 'ENABLED' : 'disabled'}`
            + `, context budget ${policy.contextBudgetPercent}%`);
        res.json({
            ...policy,
            configured: true,
            contextWindowExamples: contextWindowExamples(),
            contextBudgetRange: {
                min: MIN_CONTEXT_BUDGET_PERCENT,
                max: MAX_CONTEXT_BUDGET_PERCENT,
            },
        });
    } catch (err) {
        log.error('[OrgAiContext] PUT failed:', err.message);
        res.status(500).json({ error: 'Failed to save AI context settings' });
    }
});

module.exports = router;
