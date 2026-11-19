// @typecheck
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
const { SkillStructureError } = require('../../core/skills/skillStructure');
const {
    parseSkillDraft,
    buildDraftMessages,
    buildImproveMessages,
    MAX_SENTENCE_CHARS,
} = require('../../core/skills/skillDraft');
// The model call itself (fast tier, forced tool, one usage row) is shared
// with the agent wizard, so both draft a skill the same way.
const { askForDraft, resolveDraftModel: resolveModel } = require('../../core/skills/skillDraftCall.mts');
const { HttpError } = require('../../core/http/errors');
const { sessionUser } = require('../../core/http/sessionUser');

/**
 * A drafting call is one model call on somebody's keystroke. Ten a minute is
 * generous for a person and useless for a script. Unnamed on purpose:
 * per-replica is the right shape for a cost brake (see perUserRateLimit).
 */
const limiter = perUserRateLimit({ windowMs: 60_000, max: 10 });

/** @param {import('express').Request} req */
async function orgIdOf(req) {
    const userStore = require('../../stores/userStore');
    const user = await userStore.getUser(sessionUser(req).id);
    return user?.organizationId || null;
}

// Two failures the editor names rather than calling them a server fault: no
// model to ask, and a model that answered with something unusable.
function unavailable() {
    return new HttpError(503, 'no_model', 'No AI model is configured for this workspace.');
}

function unusable() {
    return new HttpError(502, 'ai_unusable',
        'The model did not return a usable skill. Try again, or describe it more concretely.');
}

// ── POST /api/skills/ai/draft ────────────────────────────────────────
// One sentence in, a whole skill out. NOT stored: the caller decides what to
// keep, and a route that created a skill as a side effect of a suggestion
// would leave a trail of half-written rows behind every abandoned attempt.
/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function draft(req, res) {
    const sentence = String(req.body?.sentence || '').trim().slice(0, MAX_SENTENCE_CHARS);
    if (!sentence) {
        return res.status(400).json({ error: 'Describe in one sentence what the skill should do.', code: 'no_sentence' });
    }
    const userId = sessionUser(req).id;
    const userOrgId = await orgIdOf(req);

    const answer = await askForDraft({
        messages: buildDraftMessages(sentence),
        userId,
        userOrgId,
        source: 'skill_ai_draft',
    });
    if (!answer) throw unavailable();

    const parsed = parseSkillDraft(answer.structured, { mode: 'draft' });
    if (!parsed) throw unusable();
    return res.json({ draft: parsed });
}

// ── POST /api/skills/:id/ai/improve ──────────────────────────────────
/**
 * @param {import('express').Request<{ id: string }>} req
 * @param {import('express').Response} res
 */
async function improve(req, res) {
    try {
        const skillStore = require('../../stores/skillStore');
        const { hasPermission } = require('../../auth/permissions');
        const userId = sessionUser(req).id;
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
        if (!answer) throw unavailable();

        const parsed = parseSkillDraft(answer.structured, { mode: 'improve', current: skill });
        if (!parsed) throw unusable();

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
        if (err instanceof SkillStructureError || /** @type {Error} */ (err)?.name === 'SkillStructureError') {
            // Our own validators refused the model's shape after the clamps —
            // a model failure, not the caller's malformed request.
            throw unusable();
        }
        throw err;
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
