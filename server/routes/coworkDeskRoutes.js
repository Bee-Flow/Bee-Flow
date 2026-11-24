// @typecheck strict
/**
 * Desks: coworks of different owners that hand work to each other (usecases/coworkDesks.mts), under /api/cowork:
 *
 *   GET /desks                                     → the desks the caller is on, made, holds a role on or is invited to
 *   POST /desks                                    → { name }: make one in the caller's organisation
 *   GET /desks/:id                                 → the desk: its coworks in the order work moves, roles, last status
 *   DELETE /desks/:id                              → remove it (its maker)
 *   PUT /desks/:id/roles                           → { roles: [{ role, holderId, standInId?, awayUntil? }] } (its maker)
 *   POST /desks/:id/members                        → { scheduleId }: put my cowork on it, or invite one shared with me
 *   POST /desks/:id/members/:scheduleId/accept     → the owner of an invited cowork accepts it
 *   PUT /desks/:id/members/:scheduleId             → { deskRole }: the role that decides that cowork's questions (its owner)
 *   DELETE /desks/:id/members/:scheduleId          → take a cowork off (its owner, or the desk's maker)
 *   GET /:id/desk                                  → the desk my cowork is on or invited to (its owner)
 *
 * Mounted by ./coworkSideRoutes.js, before the item routes and behind routes/cowork.js's requireAuth.
 */

const { validate } = require('../core/http/validate');
const { z } = require('../core/http/schemaParts');
const { loadOwnedItem } = require('../usecases/coworkItems.mts');

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
const DeskParams = z.object({ id }).strict();
const MemberParams = z.object({ id, scheduleId: id }).strict();

/** Mounted behind routes/cowork.js's requireAuth, which guarantees the session user. @param {import('express').Request} req */
const userIdOf = (req) => /** @type {NonNullable<Express.Session['user']>} */ (req.session.user).id;

/**
 * @param {import('express').Router} router
 * @param {{ loadItem?: typeof loadOwnedItem, desks?: () => typeof import('../usecases/coworkDesks.mts') }} [overrides]
 */
function mountDeskRoutes(router, overrides = {}) {
    const loadItem = overrides.loadItem ?? loadOwnedItem;
    const useCase = overrides.desks ?? (() => require('../usecases/coworkDesks.mts'));
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
    router.get('/:id/desk', async (req, res) => {
        res.json(await useCase().itemDesk(await loadItem(req.params.id, userIdOf(req))));
    });
}

module.exports = { mountDeskRoutes };
