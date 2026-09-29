/**
 * Studio Playbooks — phased AI builds the user watches and consents to.
 *
 * Mounted at /api/playbooks (index.js). The CLIENT drives the two AI builders
 * (routine, app) by mounting them; THIS router owns the entity, composes every
 * phase's brief from the recipe with real artifacts, runs the two phases no
 * model touches (`table`, `fill`), pre-creates the app for the `app` phase,
 * and checks every transition. Owner-only: a playbook's artifacts are the
 * owner's routine and app; another user gets 404, never 403 on existence.
 *
 *   GET    /recipes                         { recipes, approvalsAllowed }
 *   GET    /                                { playbooks:[…] }
 *   POST   /                                { recipeId, title?, options } → 201 { playbook }
 *   GET    /:id                             { playbook }   (refreshes a running `fill`)
 *   PATCH  /:id                             { expectedVersion, title?, status?:'stopped'|'active' (resume), phases:[{ key, status?, brief?, artifacts?, summary?, error? }] }
 *   POST   /:id/phases/:key/run             the server-run kinds: table → { playbook };
 *                                           fill → 200 { playbook } | 202 { playbook, pending:true };
 *                                           design → { playbook } (one designer call, then the app brief carries the design;
 *                                           body { feedback } on a design that has LANDED revises it in place — same phase,
 *                                           still awaiting, new design, the app brief recomposed)
 *   POST   /recipes/compose                 { description, locale } → { recipe, warnings } (the AI writes a recipe document)
 *   POST   /:id/phases/:key/access-plan     { message } → { plan } — who may use the app, PROPOSED; writes nothing
 *   POST   /:id/phases/:key/register        { registration, risks[] } → { written, failed } — the ONE write of the
 *                                           compliance phase: the table's legal basis + retention (which is what puts
 *                                           it in the processing register), a risk per kept finding, and the review
 *                                           itself on the evidence chain
 *   POST   /:id/phases/:key/skip            { expectedVersion }
 *   POST   /:id/phases/:key/retry           { expectedVersion, resetBrief? }
 *   DELETE /:id                             → 204 (artifacts untouched)
 *
 * Errors: 400 { error, code } (recipe_unknown, bad_options, version_required,
 * bad_patch), 403 (manage_datatables_required, not_owner, tier_not_permitted:
 * compose, create and every model call a phase makes run on a tier the
 * caller's groups allow), 404, 409
 * (version_conflict {currentVersion, playbook}, illegal_transition {from,to},
 * routine_not_finalized, capability_missing, artifacts_missing, phase_not_ready,
 * key_taken), 422 (table_unusable {missing}, table_read_only, trigger_not_manual).
 *
 * The handlers live in routes/playbooks/ per resource group; this file is the
 * router that mounts them. THE MOUNTING ORDER BELOW IS THE MATCHING ORDER —
 * `/recipes` before `/:id`, and DELETE /:id last, where it has always been.
 */

'use strict';

const express = require('express');
const { requireAuth, requirePermission, Permissions } = require('../../auth/permissions');
const { perUserRateLimit } = require('../../utils/perUserRateLimit');
const { checkElementWords } = require('../../playbooks/phases/designPhase');
const { makeDefaultDeps } = require('./deps');
const { makeFlow } = require('./phaseFlow');
const { summarise } = require('./phaseList');

// The designer's words are checked against App Studio's REAL catalog here, not
// in the phase: playbooks/ may not require appStudio/ (one feature never
// requires another — layering.test.js), and a route may require both.
checkElementWords(require('../../appStudio/componentSpecs').COMPONENT_TYPES);

function createPlaybooksRouter(deps = null) {
    const d = deps || makeDefaultDeps();
    const router = express.Router();
    router.use(requireAuth);
    router.use(perUserRateLimit({ windowMs: 60_000, max: 60, name: 'playbooks' }));
    const runLimiter = perUserRateLimit({ windowMs: 60_000, max: 10, name: 'playbooks-run' });
    const requireManageApps = requirePermission(Permissions.MANAGE_APPS);
    const ctx = { d, flow: makeFlow(d), requireManageApps, runLimiter };

    require('./recipeRoutes').register(router, ctx);
    require('./playbookRoutes').register(router, ctx);
    require('./serverPhaseRoutes').register(router, ctx);
    require('./accessPhaseRoutes').register(router, ctx);
    require('./complianceRoutes').register(router, ctx);
    require('./skipRetryRoutes').register(router, ctx);
    require('./playbookRoutes').registerDelete(router, ctx);

    return router;
}

const router = createPlaybooksRouter();
module.exports = router;
module.exports.createPlaybooksRouter = createPlaybooksRouter;
module.exports._test = { summarise };
