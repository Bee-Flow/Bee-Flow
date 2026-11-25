// @typecheck strict
/**
 * "It notices what you repeat" for the signed-in person (core/cowork/habits/habitSignals.mts), under /api/cowork:
 *
 *   GET /habits  → { on, allowed }: whether this person switched it on, and whether their organisation allows it
 *   PUT /habits  → { on }: switch it on or off; off forgets everything it noted
 *
 * Only ever about the caller. Mounted by ./coworkSideRoutes.js, behind routes/cowork.js's requireAuth.
 */

const { validate } = require('../core/http/validate');
const { z, flag } = require('../core/http/schemaParts');

const HabitsBody = z.object({ on: flag('on is true or false.') }).strict();

/** Mounted behind routes/cowork.js's requireAuth, which guarantees the session user. @param {import('express').Request} req */
const userIdOf = (req) => /** @type {NonNullable<Express.Session['user']>} */ (req.session.user).id;

/** @param {import('express').Router} router */
function mountHabitRoutes(router) {
    const useCase = () => require('../usecases/coworkHabits.mts');
    router.get('/habits', async (req, res) => {
        res.json(await useCase().habitsOf(userIdOf(req)));
    });
    router.put('/habits', validate({ body: HabitsBody }), async (req, res) => {
        res.json(await useCase().setHabits(userIdOf(req), req.body.on === true));
    });
}

module.exports = { mountHabitRoutes };
