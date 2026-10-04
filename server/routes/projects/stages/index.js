'use strict';
/**
 * The licensed stage API (design 8): everything under /api/projects/:id that
 * is about the Dev / UAT / PRD pipeline of a Solution.
 *
 *   stageRoutes.js       pipeline overview, create / remove / read a stage
 *   settingsRoutes.js    stage settings and approval gate, requirements,
 *                        bindings, variables, parts on / off, pause / resume,
 *                        part options
 *   releaseRoutes.js     cut and read releases, plan, release-and-deploy
 *   deploymentRoutes.js  deploy, history, one deployment, cancel, retry
 *   stageSchemas.js      the closed request schemas
 *
 * `:id` is always the Dev Solution; a stage project id there answers 404. The
 * drain-exempt operations (reading a stage, on / off, pause / resume,
 * non-steering values, detach) are ALSO served by routes/solutionStages.js on
 * `/api/solution-stages`, which needs no licence: a lapse never strands
 * production.
 *
 * A factory over `deps` (see stageRoutes.resolveDeps): the engine, the stores
 * and the licence gates come in as arguments, so a route test serves the
 * router with doubles and replaces no module. routes/projects.js mounts it
 * beside the other project routers; nothing is loaded until a request needs it.
 *
 * Licence gates are PER ROUTE, never `router.use`: this router shares the
 * `/api/projects` mount with routes that have nothing to do with stages
 * (see routes/projects/packaging.js for the failure a path-less gate caused).
 */

const express = require('express');
const { resolveDeps, makeStageRouter } = require('./stageRoutes');
const { makeSettingsHandlers, makeSettingsRouter } = require('./settingsRoutes');
const { makeReleaseRouter } = require('./releaseRoutes');
const { makeDeploymentRouter } = require('./deploymentRoutes');

/**
 * @param {object} [deps]  see stageRoutes.resolveDeps
 * @returns {import('express').Router}
 */
function makeStagesRouter(deps = {}) {
    const d = resolveDeps(deps);
    const router = express.Router({ mergeParams: true });
    router.use('/', makeStageRouter(d));
    router.use('/', makeSettingsRouter(d, makeSettingsHandlers(d)));
    router.use('/', makeReleaseRouter(d));
    router.use('/', makeDeploymentRouter(d));
    return router;
}

module.exports = { makeStagesRouter };
