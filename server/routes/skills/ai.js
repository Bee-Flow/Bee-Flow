/**
 * "Let AI fill it in" / "Improve with AI" — the two drafting endpoints.
 * (Bee Flow Builder redesign, Sep 2026, Track S3.)
 *
 *   POST /api/skills/ai/draft       { sentence }        → { draft }
 *   POST /api/skills/:id/ai/improve { note? }           → { skill }
 *
 * Wired into `routes/skills.js`, which owns the router, `requireAuth`, the
 * `manage_skills` gate and the suspended-org block. Plain `(req, res)`
 * functions, required LAZILY there, for the reason `examples.js` records:
 * `routes/skills.test.js` stubs skills.js's dependencies through a
 * parent-keyed resolve hook, so an eager require here would drag the LLM
 * client, the provider adapters and a real database into a DB-free suite.
 *
 * ── THE TWO ARE NOT SYMMETRIC, AND THAT IS THE POINT ────────────────
 * `draft` invents a skill from one sentence and RETURNS it; nothing is
 * stored, because there is nothing yet to store it on — the editor decides
 * what to keep. `improve` rewrites a skill that exists and MUST persist:
 * `SkillDetail.improve()` sets the draft and calls `onSaved`, but never
 * marks the form dirty, so no PUT follows it. An endpoint that only handed
 * back a suggestion would look like it worked and lose the whole rewrite the
 * moment somebody navigated away. So improve writes through
 * `skillStore.updateSkill` — with the same `managerOrgId` widening PUT uses,
 * which refuses a skill of another org by construction — and answers with
 * the STORED row.
 *
 * ── WHAT THE MODEL IS NOT ALLOWED TO CHANGE ─────────────────────────
 * `core/skills/skillDraft.js` holds the schema and the clamps: no grants, no
 * audience, no invented references, examples appended and never rewritten.
 * A payload that survives none of that returns 502 `ai_unusable` — never
 * half a skill saved over somebody's work.
 *
 * No request schema here, and none belongs here: routes/skills.js mounts these
 * handlers behind its own validate() schemas (FromMessageBody, TestBody,
 * DraftBody, ImproveBody), so every body read below has already been checked.
 */

'use strict';

const { perUserRateLimit } = require('../../utils/perUserRateLimit');
const { usageLogFields } = require('../../core/providers/usageNormalizer');
const { SkillStructureError } = require('../../core/skills/skillStructure');
const {
    DRAFT_TOOL,
    parseSkillDraft,
    buildDraftMessages,
    buildImproveMessages,
    MAX_SENTENCE_CHARS,
} = require('../../core/skills/skillDraft');
const log = require('../../telemetry/log');

/**
 * A drafting call is one model call on somebody's keystroke. Ten a minute is
 * generous for a person and useless for a script. Unnamed on purpose:
 * per-replica is the right shape for a cost brake (see perUserRateLimit).
 */
const limiter = perUserRateLimit({ windowMs: 60_000, max: 10 });

const MAX_TOKENS = 2000;

async function orgIdOf(req) {
    const userStore = require('../../stores/userStore');
    const user = await userStore.getUser(req.session.user.id);
    return user?.organizationId || null;
}

/** The fast tier, with the global default behind it — `learning.js`'s resolver. */
async function resolveModel({ userId, userOrgId }) {
    const { resolveModelForTier, resolveModelWithGlobalFallback } = require('../../core/llm/modelResolver');
    try {
        const resolved = await resolveModelForTier('tier:fast', { userOrgId, userId, fallbackTier: 'fast' });
        if (resolved) return resolved;
    } catch (_) { /* fall through */ }
    try {
        return await resolveModelWithGlobalFallback('tier:fast', { userOrgId, userId });
    } catch (_) {
        return null;
    }
}

/**
 * One usage row per drafting call. `chatForcedTool` logs nothing itself, so
 * without this the Test/Improve buttons would spend tokens that never appear
 * in anybody's usage — the one place a self-hosted customer looks to find
 * out what their AI costs.
 */
async function logDraftUsage({ userId, userOrgId, modelId, usage, startMs, source }) {
    try {
        const usageStore = require('../../stores/usageStore');
        await usageStore.logUsage({
            user_id: userId,
            agent_name: 'skill-ai',
            agent_type: 'system',
            model: modelId,
            // Normalised by the adapter (providers/usageNormalizer.js): cache read/write,
            // the 5m/1h split and reasoning tokens ride along.
            ...usageLogFields(usage),
            source,
            duration_ms: Date.now() - startMs,
            organization_id: userOrgId || null,
        });
    } catch (e) {
        log.warn('[Skills/ai] failed to log usage:', e.message);
    }
}

/** Ask the model for a skill. Returns `{ structured, usage, modelId }` or null when no model is configured. */
async function askForDraft({ messages, userId, userOrgId, source }) {
    const modelId = await resolveModel({ userId, userOrgId });
    if (!modelId) return null;
    const llmClient = require('../../core/llm/llmClient');
    const startMs = Date.now();
    const result = await llmClient.chatForcedTool(modelId, messages, DRAFT_TOOL, {
        maxTokens: MAX_TOKENS,
        temperature: 0.4,
    });
    await logDraftUsage({ userId, userOrgId, modelId, usage: result?.usage, startMs, source });
    return { structured: result?.structured || null, modelId };
}

function unavailable(res) {
    return res.status(503).json({
        error: 'No AI model is configured for this workspace.',
        code: 'no_model',
    });
}

function unusable(res) {
    return res.status(502).json({
        error: 'The model did not return a usable skill. Try again, or describe it more concretely.',
        code: 'ai_unusable',
    });
}

// ── POST /api/skills/ai/draft ────────────────────────────────────────
// One sentence in, a whole skill out. NOT stored: the caller decides what to
// keep, and a route that created a skill as a side effect of a suggestion
// would leave a trail of half-written rows behind every abandoned attempt.
async function draft(req, res) {
    try {
        const sentence = String(req.body?.sentence || '').trim().slice(0, MAX_SENTENCE_CHARS);
        if (!sentence) {
            return res.status(400).json({ error: 'Describe in one sentence what the skill should do.', code: 'no_sentence' });
        }
        const userId = req.session.user.id;
        const userOrgId = await orgIdOf(req);

        const answer = await askForDraft({
            messages: buildDraftMessages(sentence),
            userId,
            userOrgId,
            source: 'skill_ai_draft',
        });
        if (!answer) return unavailable(res);

        const parsed = parseSkillDraft(answer.structured, { mode: 'draft' });
        if (!parsed) return unusable(res);
        return res.json({ draft: parsed });
    } catch (err) {
        log.error('[Skills] POST /ai/draft error:', err);
        return res.status(500).json({ error: 'Could not draft this skill' });
    }
}

// ── POST /api/skills/:id/ai/improve ──────────────────────────────────
async function improve(req, res) {
    try {
        const skillStore = require('../../stores/skillStore');
        const { hasPermission } = require('../../auth/permissions');
        const userId = req.session.user.id;
        const orgId = await orgIdOf(req);

        let canManage = false;
        try { canManage = await hasPermission(userId, 'manage_skills', req.session); } catch (_) { canManage = false; }

        const skill = await skillStore.getSkill(req.params.id, orgId, userId, { canManage: canManage === true });
        if (!skill) return res.status(404).json({ error: 'Skill not found' });
        // Visible-but-not-editable is a 403, the same answer PUT gives — this
        // endpoint WRITES, so it may not be softer than the write it performs.
        if (!skill.canEdit) return res.status(403).json({ error: 'You cannot edit this skill', code: 'not_editable' });

        const note = String(req.body?.note || '').trim().slice(0, MAX_SENTENCE_CHARS);

        const answer = await askForDraft({
            messages: buildImproveMessages(skill, note),
            userId,
            userOrgId: orgId,
            source: 'skill_ai_improve',
        });
        if (!answer) return unavailable(res);

        const parsed = parseSkillDraft(answer.structured, { mode: 'improve', current: skill });
        if (!parsed) return unusable(res);

        const updated = await skillStore.updateSkill(skill.id, userId, parsed, {
            // Exactly the widening PUT /:id uses: only ever to the CALLER'S
            // own org, so a manager of another org is refused by the WHERE.
            managerOrgId: skill.orgId && skill.orgId === orgId ? orgId : null,
        });
        if (!updated) return res.status(404).json({ error: 'Skill not found' });

        // Answer with what was STORED, not with what was proposed: the editor
        // adopts this row wholesale, and the two must not be able to differ.
        const fresh = await skillStore.getSkill(skill.id, orgId, userId, { canManage: canManage === true });
        return res.json({ skill: fresh || { ...skill, ...parsed } });
    } catch (err) {
        if (err instanceof SkillStructureError || err?.name === 'SkillStructureError') {
            // Our own validators refused the model's shape after the clamps —
            // a model failure, not the caller's malformed request.
            return unusable(res);
        }
        log.error('[Skills] POST /:id/ai/improve error:', err);
        return res.status(500).json({ error: 'Could not improve this skill' });
    }
}

module.exports = {
    draft,
    improve,
    limiter,
    // Exported for the colocated test.
    resolveModel,
    orgIdOf,
};
