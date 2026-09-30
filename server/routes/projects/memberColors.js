// @typecheck
/**
 * The colour of a person in a project.
 *
 * PUT /:id/members/:userId/color   viewer   { color: '#hex' | null }
 *
 * The project's owner gives anyone a colour; everybody else may set their own.
 * The person has to be on the project (its owner, or a member by name). The
 * colour is one of projects/memberColors' fixed hues, or null for the
 * automatic one. The live feed says which person changed (`member_color`,
 * ids only), so every open chat and task list repaints.
 *
 * Built by a factory so the test hands in the store and the role gate.
 */

'use strict';

const express = require('express');
const { validate } = require('../../core/http/validate');
const { bodyOf, worded } = require('../../core/http/schemaParts');
const { lazyProjectRoleGate } = require('./roleGate');
const { forbidden, notFound, badRequest } = require('../../core/http/errors');
const { isMemberColor, MEMBER_COLORS } = require('../../projects/memberColors');

const COLOR_TEXT = 'color is one of the project colours, like #3b82f6, or null for the automatic one.';
const Body = bodyOf({ color: worded(COLOR_TEXT).trim().max(16, COLOR_TEXT).nullable() }, 'Colouring a person');

/**
 * @param {object} [deps]
 * @param {Function} [deps.requireProjectRole]
 * @param {Function} [deps.getProject]   (id) => project row
 * @param {Function} [deps.getShares]    (projectId) => share rows
 * @param {object}   [deps.store]        stores/projectMemberColorStore surface
 * @param {Function} [deps.emit]         (projectId, event) => durable event
 */
function makeMemberColorsRouter(deps = {}) {
    const router = express.Router({ mergeParams: true });
    const requireRole = deps.requireProjectRole || lazyProjectRoleGate;
    const getProject = deps.getProject || ((id) => require('../../stores/projectStore').getProject(id));
    const getShares = deps.getShares || ((id) => require('../../stores/projectStore').getProjectShares(id));
    const store = () => deps.store || require('../../stores/projectMemberColorStore');
    const emit = deps.emit
        || ((projectId, event) => require('../../core/projectFeed').emitProjectEvent(projectId, event, { label: 'ProjectMemberColors' }));

    router.put('/:id/members/:userId/color', requireRole('viewer'), validate({ body: Body }), async (req, res) => {
        const me = req.session.user.id;
        const target = req.params.userId;
        if (req.projectRole !== 'owner' && target !== me) {
            throw forbidden('not_your_colour', 'You can change your own colour; the project owner can change anyone\'s.');
        }
        const project = await getProject(req.params.id);
        if (!project) throw notFound('not_found', 'Not found');
        const shares = await getShares(project.id);
        const onProject = project.ownerId === target || shares.some((s) => s.sharedWithType === 'user' && s.sharedWithId === target);
        if (!onProject) throw notFound('member_not_found', 'That person is not on this project.');
        const { color } = req.body;
        if (color !== null && !isMemberColor(color)) throw badRequest('invalid_color', `color is one of ${MEMBER_COLORS.join(', ')}, or null.`);
        const saved = await store().setColor(project.id, target, color === null ? null : color.toLowerCase());
        await emit(project.id, { kind: 'member_color', actorId: me, targetType: 'user', targetId: target, payload: { userId: target } });
        res.json({ userId: target, color: saved });
    });

    return router;
}

const router = makeMemberColorsRouter();

module.exports = router;
module.exports.makeMemberColorsRouter = makeMemberColorsRouter;
