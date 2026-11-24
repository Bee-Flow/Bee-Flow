// @typecheck strict
/**
 * The goal of a cowork (usecases/coworkGoals.mts), under /api/cowork:
 *
 *   GET    /:id/goal         → the sentence, the target, the check in plain words, the last counts and their trend
 *   PUT    /:id/goal         → write the sentence and the target; a new sentence takes the check off
 *   POST   /:id/goal/check   → have Cowork draft the check from the sentence (a model's time: limited per person, and
 *                              behind the switch of the automation module, as a check is an automation)
 *   POST   /:id/goal/approve → approve the check the caller read (its fingerprint)
 *   DELETE /:id/goal         → take the goal off, with what it measured
 *
 * The owner's own item only (usecases/coworkItems.mts), like every item route. Mounted by ./coworkSideRoutes.js,
 * before the item routes and behind routes/cowork.js's requireAuth.
 */

const { validate } = require('../core/http/validate');
const { z, worded, bodyOf, wholeNumber } = require('../core/http/schemaParts');
const { loadOwnedItem } = require('../usecases/coworkItems.mts');
const { perUserRateLimit } = require('../utils/perUserRateLimit');
const { requireModule } = require('../modules');
const { fallback } = require('../utils/bestEffort');

const SENTENCE_TEXT = 'A goal is one sentence of 1 to 500 characters.';
const TARGET_TEXT = 'The target is a whole percentage from 1 to 100.';
const FINGERPRINT_TEXT = 'fingerprint is the fingerprint of the check you read (64 characters).';
const GoalBody = bodyOf({
    sentence: worded(SENTENCE_TEXT).trim().min(1, SENTENCE_TEXT).max(500, SENTENCE_TEXT),
    targetPercent: wholeNumber(TARGET_TEXT, { min: 1, max: 100 }).optional(),
}, 'A goal');
const ApproveBody = bodyOf({ fingerprint: worded(FINGERPRINT_TEXT).length(64, FINGERPRINT_TEXT) }, 'Approving a check');
const DraftBody = bodyOf({}, 'Drafting a check');
const Params = z.object({ id: z.string().min(1).max(200) }).strict();

/** Mounted behind routes/cowork.js's requireAuth, which guarantees the session user. @param {import('express').Request} req */
const userIdOf = (req) => /** @type {NonNullable<Express.Session['user']>} */ (req.session.user).id;

const DRAFTS_PER_MINUTE = 4;

/**
 * @typedef {{
 *   loadItem: typeof loadOwnedItem,
 *   goals: () => Pick<typeof import('../usecases/coworkGoals.mts'), 'goalOf' | 'saveGoal' | 'draftCheck' | 'approveCheck' | 'removeGoal'>,
 *   orgOf: (req: import('express').Request, userId: string) => Promise<string | null>,
 *   draftLimit: import('express').RequestHandler<{ id: string }>,
 *   moduleGate: import('express').RequestHandler<{ id: string }>,
 * }} GoalRouteDeps
 */

/** @returns {GoalRouteDeps} */
const defaults = () => ({
    loadItem: loadOwnedItem,
    goals: () => require('../usecases/coworkGoals.mts'),
    orgOf: (req, userId) => require('../core/llm/modelResolver').resolveEffectiveOrgId(req, { userId })
        .catch((/** @type {unknown} */ e) => fallback('routes/coworkGoalRoutes:orgOf', e, null)),
    draftLimit: perUserRateLimit({ windowMs: 60_000, max: DRAFTS_PER_MINUTE, name: 'cowork-goal-check' }),
    moduleGate: requireModule('automation'),
});

/**
 * A signal that ends when the caller leaves before the answer: drafting is a model's time nobody waits for any more.
 * @param {import('express').Response} res
 */
function callerSignal(res) {
    const gone = new AbortController();
    res.on('close', () => { if (!res.writableEnded) gone.abort(new Error('the caller left')); });
    return gone.signal;
}

/**
 * @param {import('express').Router} router
 * @param {Partial<GoalRouteDeps>} [overrides]
 */
function mountGoalRoutes(router, overrides = {}) {
    const { loadItem, goals, orgOf, draftLimit, moduleGate } = { ...defaults(), ...overrides };
    router.get('/:id/goal', validate({ params: Params }), async (req, res) => {
        res.json(await goals().goalOf(await loadItem(req.params.id, userIdOf(req))));
    });
    router.put('/:id/goal', validate({ params: Params, body: GoalBody }), async (req, res) => {
        const item = await loadItem(req.params.id, userIdOf(req));
        res.json(await goals().saveGoal({ item, sentence: req.body.sentence, targetPercent: req.body.targetPercent ?? 100 }));
    });
    router.post('/:id/goal/check', moduleGate, draftLimit, validate({ params: Params, body: DraftBody }), async (req, res) => {
        const userId = userIdOf(req);
        const item = await loadItem(req.params.id, userId);
        const userOrgId = await orgOf(req, userId);
        res.json(await goals().draftCheck({ item, session: req.session, userOrgId, signal: callerSignal(res) }));
    });
    router.post('/:id/goal/approve', validate({ params: Params, body: ApproveBody }), async (req, res) => {
        const item = await loadItem(req.params.id, userIdOf(req));
        res.json(await goals().approveCheck({ item, fingerprint: req.body.fingerprint }));
    });
    router.delete('/:id/goal', validate({ params: Params }), async (req, res) => {
        res.json(await goals().removeGoal({ item: await loadItem(req.params.id, userIdOf(req)) }));
    });
}

module.exports = { mountGoalRoutes };
