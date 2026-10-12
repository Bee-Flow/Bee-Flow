/**
 * POST /automations/:id/activate and /publish — the HTTP side of going live.
 *
 * The decisions and side effects live in automation/goLive.js (activateCore,
 * planGoLive, checkBeforeLiveCore, convergeAfterPublish), so the Solution
 * deploy engine switches an automation on and live through the same gates. What
 * stays here is what is HTTP-shaped: the access check, the `version` the
 * person reviewed, the session the permission catalog may use, and turning a
 * core's refusal into the response the builder renders.
 *
 * `agentsFor`, `kbFindingsFor` and `wakeComplianceReview` are injected by
 * crud.js (they come from automation/liveSideEffects.js, which the save and
 * import paths use too): an automation must never be able to resolve an agent
 * catalog or an organisation differently depending on which route asked.
 */

const automationStore = require('../../stores/automationStore');
const { syncSchedules } = require('../../automation/scheduleSync');
const { syncAppEventSubscription } = require('../../automation/subscriptionSync');
const { definitionForRun } = require('../../core/automationRunner/definitionForRun');
const { isManagedAutomation } = require('../../core/automationRunner/stageVars');
const { projectForViewer } = require('../../automation/access');
const { activateCore, checkBeforeLiveCore, convergeAfterPublish, planGoLive, refusalError } = require('../../automation/goLive');

/**
 * The core's dependencies for a request: the route's own, with the
 * request-shaped `kbFindingsFor(def, req, userId, stage)` adapted to the
 * core's `(def, { userId, stage })` — the route's helper resolves the
 * organisation from the request itself.
 */
function coreDeps(req, deps) {
    const { kbFindingsFor } = deps;
    return {
        ...deps,
        kbFindingsFor: (def, { userId, stage }) => kbFindingsFor(def, req, userId, stage),
    };
}

/** Answer a core's refusal: the AI Act gate throws (terminal handler), the rest is a JSON body. */
function answerRefusal(res, r) {
    if (r.raise) throw refusalError(r);
    return res.status(r.status).json(r.body);
}

/**
 * The checks a DEFINITION must pass before it runs unattended, for a request
 * (automation/goLive.checkBeforeLiveCore does the work).
 *
 * Answers `{ ok: true, warnings }` or `{ ok: false, status, body }`; the
 * caller writes the response. The AI Act gate is the one refusal that THROWS
 * (HttpError 409 `ai_act_check_required` / `ai_act_prohibited`, with
 * `details.aiAct`); the terminal error handler answers it.
 */
async function checkBeforeLive(req, a, definition, deps) {
    // The OWNER's catalog: steps run as them. The presser's session only
    // stands in when the presser IS the owner (the core decides that).
    const ownerId = a?.userId || req.session.user.id;
    const r = await checkBeforeLiveCore({
        automation: a, definition, ownerId, session: req.session, deps: coreDeps(req, deps),
    });
    if (r.ok) return r;
    if (r.raise) throw refusalError(r);
    return { ok: false, status: r.status, body: r.body };
}

/**
 * The caller's access for activate/publish: `edit` or more (handoff 5
 * sharing). `deps.access` is automation/access.js's guard; without it (a
 * direct handler test) the owner alone. Answers null after writing the 403.
 */
async function editAccess(req, res, a, deps) {
    if (deps.access) return deps.access.guard(req, res, a, 'edit');
    if (a.userId === req.session.user.id) return { role: 'owner', via: 'owner' };
    res.status(403).json({ error: 'Forbidden' });
    return null;
}

/** The automation as the caller may see it, with their role on it. */
function forViewer(automation, access) {
    if (!automation) return automation;
    return projectForViewer(automation, access);
}

/**
 * POST /:id/activate — switch an automation on (automation/goLive.activateCore).
 *
 * Never live yet: the working copy is checked and becomes the live version in
 * the same write that sets is_active. Already has a live version (a paused
 * automation): only switches it back on; pending changes stay pending — going
 * live with them is POST /:id/publish.
 */
async function activateAutomation(req, res, deps) {
    const store = deps.store || automationStore;
    const a = await store.getAutomation(req.params.id);
    if (!a) return res.status(404).json({ error: 'Not found' });
    const access = await editAccess(req, res, a, deps);
    if (!access) return;

    const r = await activateCore({
        automation: a,
        actorId: req.session.user.id,
        session: req.session,
        deps: {
            ...coreDeps(req, deps),
            store,
            syncAppEventSubscription: deps.syncAppEventSubscription || syncAppEventSubscription,
            syncSchedules: deps.syncSchedules || syncSchedules,
        },
    });
    if (!r.ok) return answerRefusal(res, r);
    res.json({ automation: forViewer(r.automation, access), warnings: r.warnings });
}

/**
 * POST /:id/publish — "Make vN live": the working copy becomes the live
 * version (handoff 5).
 *
 * Exactly as strict as activation (checkBeforeLive). Body `{ version? }`: the
 * version the person is looking at; when given and it is no longer the
 * working version (a save landed in between) the answer is 409
 * `version_changed` instead of publishing something they did not see. The
 * copy is also exact at the database: the store only publishes the version
 * this handler checked.
 *
 * The trigger-derived columns move with the live copy, in the same statement
 * (goLive.planGoLive). On an ACTIVE automation the triggers are re-registered
 * from the new live definition, each only when its configuration changed
 * (goLive.convergeAfterPublish). A paused automation stays paused; a never-live
 * one becomes live without being switched on.
 */
async function publishAutomation(req, res, deps) {
    const store = deps.store || automationStore;
    const a = await store.getAutomation(req.params.id);
    if (!a) return res.status(404).json({ error: 'Not found' });
    const access = await editAccess(req, res, a, deps);
    if (!access) return;
    const ownerId = a.userId || req.session.user.id;

    const asked = req.body?.version;
    if (asked !== undefined && asked !== null && asked !== a.version) {
        return res.status(409).json({
            error: `Version ${asked} is no longer the latest; the automation is at version ${a.version} now. Review it and publish again.`,
            code: 'version_changed', version: a.version,
        });
    }

    const def = a.definition || {};
    const verdict = await checkBeforeLive(req, a, def, deps);
    if (!verdict.ok) return res.status(verdict.status).json(verdict.body);

    // Only an active automation is armed; a paused one is re-armed by activate.
    const plan = planGoLive(a, def, { willBeActive: !!a.isActive, verb: 'publish' });
    if (!plan.ok) return answerRefusal(res, plan);

    // An automation in a Solution stage reads its settings from the live copy too (D17).
    const previousLive = a.liveVersion == null ? null
        : definitionForRun(a, { mode: 'live', managed: await isManagedAutomation(a) }).definition;
    const u = await store.publishWorkingCopy(a.id, { expectedVersion: a.version, columns: plan.columns });
    if (!u) {
        return res.status(409).json({
            error: 'The automation changed while it was being checked. Review it and publish again.',
            code: 'version_changed',
        });
    }

    // The working copy was saved through PATCH, which already ran the
    // save-time syncs on this definition: `saveSyncs: false`.
    await convergeAfterPublish({
        automation: a, definition: def, previousLive, isActive: !!u.isActive, ownerId,
        reason: 'publish', saveSyncs: false,
        deps: {
            syncAppEventSubscription: deps.syncAppEventSubscription || syncAppEventSubscription,
            syncSchedules: deps.syncSchedules || syncSchedules,
            ensureFormPages: typeof deps.ensureFormPages === 'function' ? deps.ensureFormPages : null,
            wakeComplianceReview: deps.wakeComplianceReview,
        },
    });
    res.json({ automation: forViewer(u, access), warnings: verdict.warnings });
}

module.exports = { activateAutomation, publishAutomation, checkBeforeLive };
