'use strict';
/**
 * The drain-exempt half of the stage API (design 8, D13): `/api/solution-stages`.
 *
 * Whatever keeps a stage that already runs in production operable must not
 * depend on a licence. The whole `/api/projects` mount needs the `projects`
 * capability and module, and `projects` sits in the same tier list as
 * `blueprint_packaging`, so a lapse there would strand production. These routes
 * are mounted in index.js with `requireAuthedUser` and nothing else:
 *
 *   GET    /:stageProjectId                read the stage (settings, parts, addresses)
 *   GET    /:stageProjectId/variables      the variables and what was entered
 *   PATCH  /:stageProjectId/parts/:ref     switch a part on or off (`active` only)
 *   POST   /:stageProjectId/pause          pause every automation, remembering which were on
 *   POST   /:stageProjectId/resume         restore exactly that set
 *   PUT    /:stageProjectId/variables      non-steering values
 *   POST   /:stageProjectId/detach         the escape hatch: the stage becomes an ordinary Solution
 *
 * What a lapse DOES refuse stays on the licensed router (routes/projects/stages):
 * deploying, releases, bindings, steering values, audience, the approval gate,
 * removing a stage with its data. Each handler here is the licensed router's
 * own, so the two cannot drift. The stage is addressed by its own project id
 * and the role is checked on THAT project (projects/stages/stageAuth.js): a Dev
 * role never opens a stage, a stage role never opens Dev. Reading and switching
 * is SE / SV; detach is the Solution owner or an organisation admin, who also
 * may pause and resume (recovery after an offboarding), audited and announced
 * to the owner.
 *
 * A factory over `deps` (routes/projects/stages/stageRoutes.resolveDeps), so a
 * route test serves it with doubles.
 */

const express = require('express');
const { validate } = require('../core/http/validate');
const S = require('./projects/stages/stageSchemas');
const { resolveDeps, makeStageHandlers, authMw } = require('./projects/stages/stageRoutes');
const { makeSettingsHandlers } = require('./projects/stages/settingsRoutes');

/**
 * @param {object} [deps]  see routes/projects/stages/stageRoutes.resolveDeps
 * @returns {import('express').Router}
 */
function makeSolutionStagesDrainRouter(deps = {}) {
    const d = resolveDeps(deps);
    const stage = makeStageHandlers(d);
    const settings = makeSettingsHandlers(d);
    const router = express.Router({ mergeParams: true });

    router.get('/:stageProjectId', authMw(d, { stage: 'viewer' }), stage.getStage);
    router.get('/:stageProjectId/variables', authMw(d, { stage: 'viewer' }), settings.getValues);
    router.patch('/:stageProjectId/parts/:ref', authMw(d, { stage: 'editor' }), validate({ body: S.PatchPartActiveBody }), settings.patchPart);
    router.post('/:stageProjectId/pause', authMw(d, { stage: 'editor', orgAdmin: true }), validate({ body: S.EmptyBody }), settings.pause);
    router.post('/:stageProjectId/resume', authMw(d, { stage: 'editor', orgAdmin: true }), validate({ body: S.EmptyBody }), settings.resume);
    router.put('/:stageProjectId/variables', authMw(d, { stage: 'editor' }), validate({ body: S.PutValuesBody }), settings.putValuesDrain);
    router.post('/:stageProjectId/detach', authMw(d, { stage: 'owner', orgAdmin: true }), validate({ body: S.DetachBody }), stage.removeStage);

    return router;
}

module.exports = { makeSolutionStagesDrainRouter };
