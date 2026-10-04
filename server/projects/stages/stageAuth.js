/**
 * One resolver for who may do what on a Solution and its stages (design 8,
 * D12). Every stage route starts with it; it answers by throwing an
 * HttpError, or by setting `req.stageCtx` and returning it.
 *
 * Roles. SO = the Solution owner (owner of Dev and of every stage project),
 * SE / SV = editor / viewer of THAT stage project, DE / DV = editor / viewer
 * of Dev, OA = an organisation admin of the Solution's organisation. A role
 * on one project never grants anything on another: a Dev role grants nothing
 * on a stage route and a stage role grants nothing on a Dev route.
 *
 *   stageAuth(req, { dev?, stage?, devStage?, anyStage?, orgAdmin? }, deps)
 *
 *   dev        minimum role ON DEV for a Dev route (no `:stage` in the path)
 *   stage      minimum role ON THE STAGE PROJECT for a stage route (`:stage`
 *              is uat | prd, or the drain router's `:stageProjectId`)
 *   devStage   minimum role on Dev when the path says `:stage = dev`
 *              (variable values exist for Dev too)
 *   anyStage   a Dev route that ALSO admits a holder of this role on any
 *              stage (the pipeline overview, for a stage-only operator)
 *   orgAdmin   also admit an org admin of the Dev project's organisation
 *              (recovery: pause, resume, detach, remove). `ctx.viaOrgAdmin`
 *              says the admission rests on that alone.
 *
 * Resolution. `:id` is always the Dev Solution: a workspace, a stage project
 * or a missing project answers 404, and so does a caller with no role at all
 * (project existence is not probeable). A role that is too low is 403.
 *
 * `req.stageCtx = { userId, dev, devRole, stage, stageName, stageRole,
 *   stageRoles, isSolutionOwner, isOrgAdmin, viaOrgAdmin }`. `stage` is the
 * solution_stages row of the addressed stage (null on a Dev route or for
 * `dev`); `stageRoles` holds the caller's role on each existing stage when
 * the route asked for it (`anyStage`).
 *
 * Every collaborator is injected (`deps`), so a route test serves it with
 * fakes and no module is replaced.
 */

'use strict';

const { HttpError, notFound } = require('../../core/http/errors');

const RANK = Object.freeze({ viewer: 1, editor: 2, owner: 3 });
const rank = (role) => RANK[role] || 0;
const STAGE_NAMES = Object.freeze(['uat', 'prd']);

const dep = (deps, name, load) => (deps && deps[name] !== undefined ? deps[name] : load());

function authDeps(deps = {}) {
    return {
        get stageStore() { return dep(deps, 'stageStore', () => require('../../stores/solutionStageStore')); },
        get projectStore() { return dep(deps, 'projectStore', () => require('../../stores/projectStore')); },
        get getProjectRole() { return dep(deps, 'getProjectRole', () => require('../../auth/projectAccess').getProjectRole); },
        get isOrgAdminForOrg() { return dep(deps, 'isOrgAdminForOrg', () => require('../../auth/permissions').isOrgAdminForOrg); },
    };
}

const refused = (role) => (role
    ? new HttpError(403, 'insufficient_permissions', 'You do not have the role this needs.')
    : notFound());

/**
 * @param {import('express').Request} req
 * @param {{ dev?: 'viewer'|'editor'|'owner', stage?: 'viewer'|'editor'|'owner', devStage?: 'viewer'|'editor'|'owner',
 *   anyStage?: 'viewer'|'editor'|'owner', orgAdmin?: boolean }} [opts]
 * @param {object} [deps]  stageStore, projectStore, getProjectRole(userId, projectId), isOrgAdminForOrg(req, orgId)
 * @returns {Promise<object>} the context (also on `req.stageCtx`)
 * @throws {HttpError} 401, 403 insufficient_permissions, 404
 */
async function stageAuth(req, opts = {}, deps = {}) {
    const d = authDeps(deps);
    const userId = req.session && req.session.user && req.session.user.id;
    if (!userId) throw new HttpError(401, 'unauthorized', 'Not authenticated');
    const params = req.params || {};

    // The drain router addresses a stage by its own project id.
    let stageRow = null;
    let solutionId = params.id;
    if (typeof params.stageProjectId === 'string') {
        stageRow = await d.stageStore.getStage(params.stageProjectId);
        if (!stageRow) throw notFound();
        solutionId = stageRow.solutionId;
    }
    if (typeof solutionId !== 'string' || !solutionId) throw notFound();

    const dev = await d.projectStore.getProject(solutionId);
    if (!dev || dev.stage || dev.stageOf || (dev.kind === 'workspace' && dev.kindGuessed !== true)) throw notFound();

    let stageName = stageRow ? stageRow.stage : null;
    if (!stageRow && params.stage !== undefined) {
        if (params.stage === 'dev') stageName = 'dev';
        else if (STAGE_NAMES.includes(params.stage)) {
            stageName = params.stage;
            stageRow = await d.stageStore.getStageFor(dev.id, params.stage);
            if (!stageRow) throw notFound('stage_not_found', 'This stage does not exist.');
        } else throw notFound();
    }

    const ctx = {
        userId, dev, devRole: null, stage: stageRow, stageName, stageRole: null, stageRoles: {},
        isSolutionOwner: dev.ownerId === userId, isOrgAdmin: false, viaOrgAdmin: false,
    };
    req.stageCtx = ctx;

    let allowed = false;
    let deniedRole = null;
    if (stageRow) {
        ctx.stageRole = await d.getProjectRole(userId, stageRow.projectId);
        ctx.stageRoles[stageRow.stage] = ctx.stageRole;
        allowed = !!opts.stage && rank(ctx.stageRole) >= rank(opts.stage);
        deniedRole = ctx.stageRole;
    } else if (stageName === 'dev') {
        if (!opts.devStage) throw notFound();
        ctx.devRole = await d.getProjectRole(userId, dev.id);
        allowed = !!opts.devStage && rank(ctx.devRole) >= rank(opts.devStage);
        deniedRole = ctx.devRole;
    } else {
        ctx.devRole = await d.getProjectRole(userId, dev.id);
        allowed = !!opts.dev && rank(ctx.devRole) >= rank(opts.dev);
        deniedRole = ctx.devRole;
        if (opts.anyStage) {
            for (const row of await d.stageStore.listStages(dev.id)) {
                ctx.stageRoles[row.stage] = await d.getProjectRole(userId, row.projectId);
                if (rank(ctx.stageRoles[row.stage]) >= rank(opts.anyStage)) allowed = true;
                if (!deniedRole && ctx.stageRoles[row.stage]) deniedRole = ctx.stageRoles[row.stage];
            }
        }
    }

    if (!allowed && opts.orgAdmin && dev.organizationId) {
        ctx.isOrgAdmin = await d.isOrgAdminForOrg(req, dev.organizationId) === true;
        if (ctx.isOrgAdmin) { allowed = true; ctx.viaOrgAdmin = true; }
    }
    if (!allowed) throw refused(deniedRole);
    return ctx;
}

/**
 * The middleware form: `router.get(path, stageAuthMw({ stage: 'viewer' }, deps), handler)`.
 * Named, so a route-table dump shows which routes carry the resolver.
 */
function stageAuthMw(opts = {}, deps = {}) {
    return async function stageAuthMiddleware(req, _res, next) {
        await stageAuth(req, opts, deps);
        next();
    };
}

module.exports = { stageAuth, stageAuthMw, RANK, rank };
