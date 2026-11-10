// @typecheck strict
/**
 * App Studio background actions: the routes, mounted on the action-run router
 * (routes/studioAppsRun.js) so they share its body parser and gates.
 *
 *   POST /:id/actions/:actionId/background  start the server job of a sequence with
 *                                           background: true -> 202 { jobId, status }
 *   GET  /:id/actions/jobs                  the caller's own jobs (?active=1, ?actionId)
 *   GET  /:id/actions/jobs/:jobId           one job: its progress and, at the end, its result
 *
 * The job itself is appStudio/backgroundRun.mts: it runs detached from the request, so
 * leaving or closing the page does not stop it. Readers of a job are whoever started it and
 * the app owner; anyone else gets a uniform 404. Non-owners always run the published
 * definition (?draft=1 is the owner's).
 */

'use strict';

const { validate } = require('../core/http/validate');
const { sessionUser } = require('../core/http/sessionUser');
const R = require('./studio/appRuntimeSchemas');
const { loadVisibleApp, assertActionRoleAccess, visibleFormValues, pickDefinition, resolveViewerRole } = require('./studioAppRunGate');
const { sanitizeBag, flattenSteps, normalizeSequence } = require('../appStudio/actionSequence');
const { HEAVY_STEP_KINDS } = require('./studioAppStepBudget.mts');

/** @typedef {{ kind?: unknown, background?: unknown, lockKey?: unknown, steps?: unknown }} RunAction  an action of the definition, as far as these routes read it */
/** @typedef {{ actions?: Record<string, RunAction>, [key: string]: unknown }} RunDef  the definition a request runs */
/** @typedef {import('../appStudio/backgroundRunParts.mts').App & { definitionVersion?: number | null, publishedVersion?: number | null }} RunApp */

/** @returns {typeof import('../appStudio/backgroundRun.mts')} */
const backgroundRun = () => require('../appStudio/backgroundRun.mts');

/**
 * The scope roots a start or a step carries (bounded by the 64KB body guard).
 * The form values go without the fields the viewer's role does not see (studioAppRunGate).
 * @param {import('express').Request} req
 * @param {{ def: RunDef | null, actionId: string, role: string | null }} gate
 */
function clickScope(req, gate) {
    const loopIndex = Number(req.body?.index);
    return {
        formValues: visibleFormValues(gate.def, gate.actionId, gate.role, sanitizeBag(req.body?.formValues)),
        vars: sanitizeBag(req.body?.vars),
        item: req.body?.item,
        index: Number.isInteger(loopIndex) && loopIndex >= 0 ? loopIndex : undefined,
        value: req.body?.value,
    };
}

/**
 * @param {import('express').Request} req
 * @param {RunApp} app
 * @param {{ def: RunDef | null, dataModel: unknown, actionId: string, role: string | null, isOwner: boolean, draft?: boolean }} o
 */
function startInput(req, app, o) {
    const user = sessionUser(req);
    return {
        app, def: o.def || {}, model: o.dataModel, actionId: o.actionId, role: o.role, isOwner: o.isOwner, draft: !!o.draft,
        definitionVersion: o.draft ? (app.definitionVersion ?? null) : (app.publishedVersion ?? null),
        viewer: { id: user.id, name: user.name || null, email: user.email || null, organizationId: user.organizationId || null },
        scope: clickScope(req, o),
    };
}

/**
 * /step of a background action whose lockKey a running job holds: answer 409 and return true.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {{ app: RunApp, def: RunDef | null, dataModel: unknown, actionId: string, role: string | null, isOwner: boolean }} o
 */
async function refuseLocked(req, res, o) {
    if (!hasLockKey(o.def, o.actionId)) return false;
    return answerIfLocked(res, startInput(req, o.app, o));
}

/**
 * The public twin of refuseLocked (issue #590): a visitor walks a background action in the
 * foreground (public pages ship it without its run options), so its /step must be refused
 * while a job holds the same key, as the signed-in /step is. The viewer is the anonymous
 * visitor id: no name, no e-mail, no organisation, never the owner; the published definition.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {{ app: RunApp, definition: RunDef | null }} found  the public page's app and its published definition
 * @param {{ model: unknown, role: string | null, viewerId: string }} ctx  the visitor's data context
 * @param {string} actionId
 */
async function refusePublicLocked(req, res, found, ctx, actionId) {
    if (!hasLockKey(found.definition, actionId)) return false;
    return answerIfLocked(res, {
        app: found.app, def: found.definition || {}, model: ctx.model, actionId, role: ctx.role, isOwner: false, draft: false,
        definitionVersion: found.app.publishedVersion ?? null,
        viewer: { id: ctx.viewerId, name: null, email: null, organizationId: null },
        scope: clickScope(req, { def: found.definition, actionId, role: ctx.role }),
    });
}

/**
 * @param {RunDef | null} def
 * @param {string} actionId
 */
function hasLockKey(def, actionId) {
    const action = def && def.actions && Object.hasOwn(def.actions, actionId) ? def.actions[actionId] : null;
    return !!action && action.kind === 'sequence' && action.background === true && !!action.lockKey;
}

/**
 * @param {import('express').Response} res
 * @param {Parameters<ReturnType<typeof backgroundRun>['lockHolderFor']>[0]} input
 */
async function answerIfLocked(res, input) {
    const holder = await backgroundRun().lockHolderFor(input);
    if (!holder) return false;
    res.status(409).json({ error: backgroundRun().lockedMessage(holder, Date.now()), code: 'action_locked' });
    return true;
}

/**
 * The background sequence `actionId` of `def`, or null after answering 404 / 400.
 * @param {import('express').Response} res
 * @param {RunDef | null} def
 * @param {string} actionId
 * @returns {RunAction | null}
 */
function backgroundActionOf(res, def, actionId) {
    const action = def && def.actions && typeof def.actions === 'object' && Object.hasOwn(def.actions, actionId) ? def.actions[actionId] : null;
    if (!action || typeof action !== 'object') {
        res.status(404).json({ error: 'Action not found' });
        return null;
    }
    if (action.kind !== 'sequence' || action.background !== true) {
        res.status(400).json({ error: 'This action does not run in the background.', code: 'not_background' });
        return null;
    }
    return action;
}

/** @param {RunAction} action */
function hasHeavyStep(action) {
    return flattenSteps(normalizeSequence(/** @type {Parameters<typeof normalizeSequence>[0]} */ (/** @type {unknown} */ (action)))).some((/** @type {{ kind?: string }} */ st) => HEAVY_STEP_KINDS.includes(String(st && st.kind)));
}

/**
 * Mount the three routes on `router` with the action-run router's middleware.
 * @param {import('express').Router} router
 * @param {{ requireAuth: import('express').RequestHandler, actionRunLimiter: import('express').RequestHandler, jobStatusLimiter: import('express').RequestHandler, jsonBody: import('express').RequestHandler, bodySizeGuard: import('express').RequestHandler }} mw
 */
function mountBackgroundRoutes(router, mw) {
    router.post('/:id/actions/:actionId/background', mw.requireAuth, mw.actionRunLimiter, mw.jsonBody, mw.bodySizeGuard, validate({ query: R.DraftQuery, body: R.BackgroundBody }), /** @param {import('express').Request<{ id: string, actionId: string }>} req */ async (req, res) => {
        const userId = sessionUser(req).id;
        const actionId = req.params.actionId;
        const app = await loadVisibleApp(req, res);
        if (!app) return;
        const { def, isOwner, draft } = pickDefinition(app, req, userId);
        const action = backgroundActionOf(res, def, actionId);
        if (!action) return;
        const { role, model } = await resolveViewerRole(req, app, userId);
        if (!assertActionRoleAccess(res, def, actionId, role, { isOwner })) return;
        // The heavy-step gate up front (the job re-checks it per step, callees included).
        if (!isOwner && !role && hasHeavyStep(action)) {
            return res.status(403).json({ error: 'You do not have access to this app yet' });
        }
        const started = await backgroundRun().startBackgroundRun(startInput(req, app, { def, dataModel: model, actionId, role, isOwner, draft }));
        if (!started.ok) {
            const refused = /** @type {{ status: number, code: string, error: string, jobId?: string }} */ (started);
            return res.status(refused.status).json({ error: refused.error, code: refused.code, ...(refused.jobId ? { jobId: refused.jobId } : {}) });
        }
        return res.status(202).json({ jobId: started.jobId, status: 'running' });
    });

    router.get('/:id/actions/jobs', mw.requireAuth, mw.jobStatusLimiter, validate({ query: R.JobsQuery }), /** @param {import('express').Request<{ id: string }>} req */ async (req, res) => {
        const app = await loadVisibleApp(req, res);
        if (!app) return;
        const { actionRunStore } = require('../stores/studioAppData/actionRuns.mts');
        const rows = await actionRunStore().listRunsForViewer(app.id, sessionUser(req).id, {
            activeOnly: req.query?.active === '1',
            actionId: typeof req.query?.actionId === 'string' ? req.query.actionId : null,
            limit: 20,
        });
        res.json({ jobs: rows.map(backgroundRun().toJobView) });
    });

    router.get('/:id/actions/jobs/:jobId', mw.requireAuth, mw.jobStatusLimiter, validate({ params: R.JobParams }), /** @param {import('express').Request<{ id: string, jobId: string }>} req */ async (req, res) => {
        const app = await loadVisibleApp(req, res);
        if (!app) return;
        const { RUN_ID_RE } = require('../stores/studioAppData/runPolicy.mts');
        if (!RUN_ID_RE.test(req.params.jobId)) return res.status(404).json({ error: 'Run not found' }); // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- RUN_ID_RE is the fixed /^sar_[0-9a-f]{32}$/, linear on any input
        const { actionRunStore } = require('../stores/studioAppData/actionRuns.mts');
        const row = await actionRunStore().getRun(app.id, req.params.jobId);
        const userId = sessionUser(req).id;
        if (!row || row.origin !== 'background' || (row.viewerUserId !== userId && app.userId !== userId)) {
            return res.status(404).json({ error: 'Run not found' });
        }
        res.json(backgroundRun().toJobView(row));
    });
}

module.exports = { mountBackgroundRoutes, refuseLocked, refusePublicLocked };
