// @typecheck strict
/**
 * POST /api/skills/from-plan  { skills } → { attachedSkillIds, createdSkills }
 *
 * The skills an agent plan proposed (the agent editor's refine rail), stored
 * with their structured draft and static/dynamic choice. Reuse by id or name,
 * otherwise create, through `usecases/agents/wizardSkills.createPlannedSkills`:
 * the same function POST /agents/wizard/commit uses, so both save paths store
 * a planned skill the same way.
 *
 * Mounted by `routes/skills.js` through `register` (requireAuth, `manage_skills`,
 * the suspended-org block, the `skills` capability at the mount). The body schema
 * lives here and is required eagerly; the usecase is required per request,
 * and the store comes in from the router, so routes/skills.test.js keeps
 * stubbing it through its own resolve hook.
 */

'use strict';

const { z, typeError } = require('../../utils/zod');
const { worded } = require('../../core/http/schemaParts');
const { sessionUser } = require('../../core/http/sessionUser');

const NAME_TEXT = 'A skill needs a name.';
const PLANNED_TEXT = 'skills is the list of skills from an agent plan.';

// Only the plan's own fields: grants, audience and refs are not a plan's to
// set, so a key outside this list is refused rather than dropped. The draft
// is re-checked by the usecase (skillDraft.parseSkillDraft), not here.
const PlannedSkill = z.object({
    id: worded('id is the id of an existing skill, or null for a new one.').nullable().optional(),
    name: worded(NAME_TEXT).trim().min(1, NAME_TEXT),
    description: worded('A description must be text.').optional(),
    instructions: worded('Instructions must be text.').max(4000, 'Instructions too long (max 4000 characters)').optional(),
    activation: z.enum(['static', 'dynamic'], { error: () => 'activation is static or dynamic.' }).optional(),
    draft: z.record(z.string(), z.unknown(), { error: typeError({ invalid: 'draft is a skill draft.' }) }).nullable().optional(),
}).strict();

const FromPlanBody = z.object({
    skills: z.array(PlannedSkill, { error: typeError({ required: PLANNED_TEXT, invalid: PLANNED_TEXT }) }).max(20, 'At most 20 skills at a time.'),
}).strict();

/**
 * @param {import('express').Request} req  body already validated by FromPlanBody
 * @param {import('express').Response} res
 * @param {{ orgId: string | null, store: Parameters<typeof import('../../usecases/agents/wizardSkills.mts').createPlannedSkills>[1]['store'] }} ctx
 */
async function fromPlan(req, res, { orgId, store }) {
    const { createPlannedSkills } = require('../../usecases/agents/wizardSkills.mts');
    const { attachedSkillIds, createdSkills } = await createPlannedSkills(req.body.skills, {
        orgId,
        userId: sessionUser(req).id,
        store,
    });
    res.json({ attachedSkillIds, createdSkills: createdSkills.map((s) => ({ ...s, canEdit: true })) });
}

/**
 * Mount the route on the skills router with ITS gate and helpers (`manage_skills`,
 * validate, the org lookup and the store), so the router's test stubs reach them.
 * @param {import('express').Router} router
 * @param {{ requirePermission: (p: string) => import('express').RequestHandler, validate: typeof import('../../core/http/validate').validate,
 *   getOrgId: (req: import('express').Request) => Promise<string | null>, store: Parameters<typeof fromPlan>[2]['store'] }} deps
 */
function register(router, { requirePermission, validate, getOrgId, store }) {
    router.post('/from-plan', requirePermission('manage_skills'), validate({ body: FromPlanBody }),
        async (req, res) => fromPlan(req, res, { orgId: await getOrgId(req), store }));
}

module.exports = { FromPlanBody, fromPlan, register };
