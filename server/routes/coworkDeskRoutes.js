// @typecheck strict
/**
 * Desks: coworks of different owners that hand work to each other (usecases/coworkDesks.mts), under /api/cowork:
 *
 *   GET /desks                                     → the desks the caller is on, made, holds a role on or is invited to
 *   POST /desks                                    → { name }: make one in the caller's organisation
 *   GET /desks/:id                                 → the desk: its coworks in the order work moves, roles, last status
 *   DELETE /desks/:id                              → remove it (its maker)
 *   PUT /desks/:id/roles                           → { roles: [{ role, holderId, standInId?, awayUntil? }] } (its maker;
 *                                                    the owners of coworks using a role that changed hands are told)
 *   POST /desks/:id/members                        → { scheduleId }: put my cowork on it, or invite one shared with me
 *   POST /desks/:id/members/:scheduleId/accept     → the owner of an invited cowork accepts it
 *   PUT /desks/:id/members/:scheduleId             → { deskRole }: the role that decides that cowork's questions (its owner)
 *   DELETE /desks/:id/members/:scheduleId          → take a cowork off (its owner, or the desk's maker)
 *   POST /desks/:id/members/:scheduleId/hand-off   → let that colleague's cowork, which starts after one of mine,
 *                                                    receive its result (the owner of the cowork it follows; once)
 *   DELETE /desks/:id/members/:scheduleId/hand-off → withdraw that again
 *   GET /:id/desk                                  → the desk my cowork is on or invited to (its owner)
 *   POST /desks/helper/draft                       → { text, itemId? }: the Teamwork helper's proposal of a desk from
 *                                                    the caller's own words (usecases/coworkDeskHelper.mts); makes nothing
 *   POST /desks/helper/apply                       → { itemId?, draft }: set that proposal up as the caller, through the
 *                                                    desk's own use cases (usecases/coworkDeskHelperApply.mts)
 *
 * Mounted by ./coworkSideRoutes.js, before the item routes and behind routes/cowork.js's requireAuth.
 */

const { validate } = require('../core/http/validate');
const { z } = require('../core/http/schemaParts');
const { loadOwnedItem } = require('../usecases/coworkItems.mts');
const { perUserRateLimit } = require('../utils/perUserRateLimit');
const { fallback } = require('../utils/bestEffort');

const id = z.string().min(1).max(200);
const NAME_TEXT = 'name is the name of the desk, 1 to 80 characters.';
const ROLE_TEXT = 'roles is a list of { role, holderId, standInId?, awayUntil? }: a role name of 1 to 40 characters, colleagues by id, an ISO time.';
const DeskBody = z.object({ name: z.string({ error: NAME_TEXT }).trim().min(1, { error: NAME_TEXT }).max(80, { error: NAME_TEXT }) }).strict();
const RolesBody = z.object({
    roles: z.array(z.object({
        role: z.string({ error: ROLE_TEXT }).trim().min(1, { error: ROLE_TEXT }).max(40, { error: ROLE_TEXT }),
        holderId: z.string({ error: ROLE_TEXT }).min(1, { error: ROLE_TEXT }).max(200, { error: ROLE_TEXT }),
        standInId: z.string({ error: ROLE_TEXT }).min(1, { error: ROLE_TEXT }).max(200, { error: ROLE_TEXT }).nullable().optional(),
        awayUntil: z.iso.datetime({ offset: true, error: ROLE_TEXT }).nullable().optional(),
    }).strict(), { error: ROLE_TEXT }).max(20, { error: ROLE_TEXT }),
}).strict();
const MemberBody = z.object({ scheduleId: id }).strict();
const ItemRoleBody = z.object({ deskRole: z.string().trim().min(1).max(40).nullable() }).strict();
const AcceptBody = z.object({}).strict();
const HELPER_TEXT = 'text is what should happen, in your own words: 1 to 1000 characters.';
const HelperDraftBody = z.object({
    text: z.string({ error: HELPER_TEXT }).trim().min(1, { error: HELPER_TEXT }).max(1000, { error: HELPER_TEXT }),
    itemId: id.optional(),
}).strict();
const DRAFT_TEXT = 'draft is { deskName, chain, roles }: a name of 1 to 80 characters, 1 to 5 coworks by id, at most one role { role, holderId, standInId? }.';
const HelperApplyBody = z.object({
    itemId: id.optional(),
    draft: z.object({
        deskName: z.string({ error: DRAFT_TEXT }).trim().min(1, { error: DRAFT_TEXT }).max(80, { error: DRAFT_TEXT }),
        chain: z.array(id, { error: DRAFT_TEXT }).min(1, { error: DRAFT_TEXT }).max(5, { error: DRAFT_TEXT }),
        roles: z.array(z.object({
            role: z.string({ error: DRAFT_TEXT }).trim().min(1, { error: DRAFT_TEXT }).max(40, { error: DRAFT_TEXT }),
            holderId: id,
            standInId: id.nullable().optional(),
        }).strict(), { error: DRAFT_TEXT }).max(1, { error: DRAFT_TEXT }),
    }, { error: DRAFT_TEXT }).strict(),
}).strict();
const DeskParams = z.object({ id }).strict();
const MemberParams = z.object({ id, scheduleId: id }).strict();

/** Mounted behind routes/cowork.js's requireAuth, which guarantees the session user. @param {import('express').Request} req */
const userIdOf = (req) => /** @type {NonNullable<Express.Session['user']>} */ (req.session.user).id;

/** The Teamwork helper's per-user limit: each draft is a model call, and each apply a series of changes. */
const HELPER_LIMIT_NAME = 'cowork-desk-helper';
const HELPER_CALLS_PER_MINUTE = 6;

/**
 * @typedef {{
 *   loadItem?: typeof loadOwnedItem,
 *   desks?: () => typeof import('../usecases/coworkDesks.mts'),
 *   helper?: () => Pick<typeof import('../usecases/coworkDeskHelper.mts'), 'draftDesk'> & Pick<typeof import('../usecases/coworkDeskHelperApply.mts'), 'applyDeskDraft'>,
 *   helperLimit?: import('express').RequestHandler,
 *   orgOf?: (req: import('express').Request, userId: string) => Promise<string | null>,
 * }} DeskRouteOverrides
 */

/** @type {NonNullable<DeskRouteOverrides['helper']>} */
const helperUseCases = () => ({ ...require('../usecases/coworkDeskHelper.mts'), ...require('../usecases/coworkDeskHelperApply.mts') });
/** The organisation whose models the helper uses (the composer's rule). @type {NonNullable<DeskRouteOverrides['orgOf']>} */
const orgOfCaller = (req, userId) => require('../core/llm/modelResolver').resolveEffectiveOrgId(req, { userId })
    .catch((/** @type {unknown} */ e) => fallback('routes/coworkDeskRoutes:orgOf', e, null));

/**
 * The Teamwork helper: a proposal from the caller's words, and setting it up.
 * @param {import('express').Router} router
 * @param {DeskRouteOverrides} overrides
 */
function mountHelperRoutes(router, overrides) {
    const helper = overrides.helper ?? helperUseCases;
    const limit = overrides.helperLimit ?? perUserRateLimit({ windowMs: 60_000, max: HELPER_CALLS_PER_MINUTE, name: HELPER_LIMIT_NAME });
    const orgOf = overrides.orgOf ?? orgOfCaller;
    router.post('/desks/helper/draft', limit, validate({ body: HelperDraftBody }), async (req, res) => {
        const userId = userIdOf(req);
        res.json(await helper().draftDesk({ userId, text: req.body.text, itemId: req.body.itemId ?? null, userOrgId: await orgOf(req, userId) }));
    });
    router.post('/desks/helper/apply', limit, validate({ body: HelperApplyBody }), async (req, res) => {
        res.status(201).json(await helper().applyDeskDraft({ userId: userIdOf(req), itemId: req.body.itemId ?? null, draft: req.body.draft }));
    });
}

/**
 * @param {import('express').Router} router
 * @param {DeskRouteOverrides} [overrides]
 */
function mountDeskRoutes(router, overrides = {}) {
    const loadItem = overrides.loadItem ?? loadOwnedItem;
    const useCase = overrides.desks ?? (() => require('../usecases/coworkDesks.mts'));
    mountHelperRoutes(router, overrides);
    router.get('/desks', async (req, res) => {
        res.json({ desks: await useCase().myDesks(userIdOf(req)) });
    });
    router.post('/desks', validate({ body: DeskBody }), async (req, res) => {
        res.status(201).json(await useCase().createDesk({ userId: userIdOf(req), name: req.body.name }));
    });
    router.get('/desks/:id', validate({ params: DeskParams }), async (req, res) => {
        res.json(await useCase().deskView(userIdOf(req), req.params.id));
    });
    router.delete('/desks/:id', validate({ params: DeskParams }), async (req, res) => {
        res.json(await useCase().deleteDesk({ userId: userIdOf(req), deskId: req.params.id }));
    });
    router.put('/desks/:id/roles', validate({ params: DeskParams, body: RolesBody }), async (req, res) => {
        res.json(await useCase().setDeskRoles({ userId: userIdOf(req), deskId: req.params.id, roles: req.body.roles }));
    });
    router.post('/desks/:id/members', validate({ params: DeskParams, body: MemberBody }), async (req, res) => {
        res.json(await useCase().addToDesk({ userId: userIdOf(req), deskId: req.params.id, scheduleId: req.body.scheduleId }));
    });
    router.post('/desks/:id/members/:scheduleId/accept', validate({ params: MemberParams, body: AcceptBody }), async (req, res) => {
        res.json(await useCase().acceptOnDesk({ userId: userIdOf(req), deskId: req.params.id, scheduleId: req.params.scheduleId }));
    });
    router.put('/desks/:id/members/:scheduleId', validate({ params: MemberParams, body: ItemRoleBody }), async (req, res) => {
        res.json(await useCase().setItemRole({ userId: userIdOf(req), deskId: req.params.id, scheduleId: req.params.scheduleId, deskRole: req.body.deskRole }));
    });
    router.delete('/desks/:id/members/:scheduleId', validate({ params: MemberParams }), async (req, res) => {
        res.json(await useCase().leaveDesk({ userId: userIdOf(req), deskId: req.params.id, scheduleId: req.params.scheduleId }));
    });
    router.post('/desks/:id/members/:scheduleId/hand-off', validate({ params: MemberParams, body: AcceptBody }), async (req, res) => {
        res.json(await useCase().allowHandOff({ userId: userIdOf(req), deskId: req.params.id, scheduleId: req.params.scheduleId }));
    });
    router.delete('/desks/:id/members/:scheduleId/hand-off', validate({ params: MemberParams }), async (req, res) => {
        res.json(await useCase().withdrawHandOff({ userId: userIdOf(req), deskId: req.params.id, scheduleId: req.params.scheduleId }));
    });
    router.get('/:id/desk', async (req, res) => {
        res.json(await useCase().itemDesk(await loadItem(req.params.id, userIdOf(req))));
    });
}

module.exports = { mountDeskRoutes, HELPER_LIMIT_NAME, HELPER_CALLS_PER_MINUTE };
