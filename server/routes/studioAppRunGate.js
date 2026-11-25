// @typecheck strict
/**
 * App Studio run-bridge gates — the ONE copy of "may this viewer see this app"
 * and "may this role reach this action".
 *
 * Extracted so the plain step bridge (studioAppsRun.js) and the streaming
 * browse bridge (studioAppBrowse.js) share identical gates. A second copy of
 * the role walk is exactly how one surface drifts wider than the other — the
 * failure this module exists to prevent.
 *
 * The role rules themselves (roleAllows, actionRoleAccess, documentChecks,
 * stepDocumentContext) take no request and are read by a background run too, so
 * they live in appStudio/runGateRules.js; this module answers requests with them
 * and exports them unchanged.
 */

'use strict';

const studioAppStore = require('../stores/studioAppStore');
const { resolveAudienceContext } = require('../auth/audience');
const { roleAllows, actionRoleAccess, documentChecks, stepDocumentContext } = require('../appStudio/runGateRules');
const { sessionUser } = require('../core/http/sessionUser');

// ── App visibility ──────────────────────────────────────────────────
// Owner always; everyone else needs is_published plus one audience that
// carries them: their org, one of its shared groups, or a Studio Project the
// app is filed into (canReadStudioAppAsync — the project half is a DB lookup,
// which is why the gate awaits). Failures answer 404 so existence never leaks.
// Responds itself and returns null on failure.
/**
 * @param {import('express').Request<{ id: string }>} req
 * @param {import('express').Response} res
 */
async function loadVisibleApp(req, res) {
    const userId = sessionUser(req).id;
    const app = await studioAppStore.getStudioApp(req.params.id);
    if (!app) {
        res.status(404).json({ error: 'App not found' });
        return null;
    }
    if (app.userId !== userId) {
        const { orgIds, memberOrgIds, userGroups } = await resolveAudienceContext(req);
        const orgIdArr = [...(memberOrgIds ?? orgIds ?? [])];
        if (!await studioAppStore.canReadStudioAppAsync(app, userId, userGroups, orgIdArr, req.session)) {
            res.status(404).json({ error: 'App not found' });
            return null;
        }
    }
    return app;
}

/** @typedef {{ id?: string, type?: string, props?: { modelTier?: string, knowledgeBaseIds?: string[], systemPrompt?: unknown }, children?: unknown, visibleToRoles?: unknown }} ComponentNode  a component as the definition stores it */

/**
 * A component node by id anywhere in the definition, and whether `role` sees
 * it: its screen, its section and every container above it clear roleAllows
 * (the walk of wiredRoleAccess in appStudio/runGateRules.js).
 * @param {{ screens?: unknown } | null | undefined} def
 * @param {unknown} nodeId
 * @param {string | null | undefined} [role]
 * @returns {{ node: ComponentNode, visible: boolean } | null}
 */
function locateNode(def, nodeId, role = null) {
    if (!def || typeof nodeId !== 'string' || !nodeId) return null;
    /** @param {unknown} children @param {boolean} visible @returns {{ node: ComponentNode, visible: boolean } | null} */
    const walk = (children, visible) => {
        for (const c of (Array.isArray(children) ? children : [])) {
            if (!c || typeof c !== 'object') continue;
            const seen = visible && roleAllows(c, role);
            if (c.id === nodeId) return { node: c, visible: seen };
            const hit = walk(c.children, seen);
            if (hit) return hit;
        }
        return null;
    };
    for (const screen of (Array.isArray(def?.screens) ? def.screens : [])) {
        for (const section of (Array.isArray(screen?.sections) ? screen.sections : [])) {
            const hit = walk(section?.children, roleAllows(screen, role) && roleAllows(section, role));
            if (hit) return hit;
        }
    }
    return null;
}

/**
 * The gate of an ai_chat component for a viewer who is not the owner: the
 * same rule as a wired action. The chat must sit where the viewer's role sees
 * it (a viewer without an app role sees what no role restriction hides).
 * Answers itself (404 for a chat the role does not see, as if it were not
 * there) and returns false; true when the chat may run.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {{ app: { id: string, userId: string }, def: { screens?: unknown } | null | undefined, nodeId: string, userId: string }} chat
 */
async function assertChatAccess(req, res, { app, def, nodeId, userId }) {
    const { role } = await resolveViewerRole(req, app, userId);
    if (role !== 'owner' && !locateNode(def, nodeId, role)?.visible) {
        res.status(404).json({ error: 'Chat component not found' });
        return false;
    }
    return true;
}

/**
 * The role gate for both bridges. Answers 403 itself and returns false when the
 * viewer's role cannot reach the action; returns true otherwise. The owner
 * always passes; anyone else only through a wiring their role sees, or a
 * caller of the action that passes. An action nothing in the app wires is the
 * owner's alone.
 * @param {import('express').Response} res
 * @param {{ screens?: unknown } | null | undefined} def
 * @param {string} actionId
 * @param {string | null | undefined} role
 * @param {{ isOwner: boolean }} opts
 */
function assertActionRoleAccess(res, def, actionId, role, { isOwner }) {
    if (isOwner || role === 'owner') return true;
    if (!actionRoleAccess(def, actionId, role).allowed) {
        res.status(403).json({ error: 'This action is not available for your role' });
        return false;
    }
    return true;
}

/**
 * The form values of a request without the fields this viewer's role does not see in the
 * form that runs `actionId` (appStudio/formFieldGate.mts): the same role rule as the gates
 * above, applied to the submitted bag. The owner submits everything; a bag with nothing to
 * leave out comes back as the same object.
 * @template V
 * @param {unknown} def  the definition the request runs
 * @param {string} actionId
 * @param {string | null | undefined} role
 * @param {V} formValues
 * @returns {V}
 */
function visibleFormValues(def, actionId, role, formValues) {
    if (role === 'owner') return formValues;
    return require('../appStudio/formFieldGate.mts').withoutGatedFormFields(formValues, def, actionId, (/** @type {unknown} */ node) => roleAllows(/** @type {{ visibleToRoles?: unknown } | null} */ (node), role));
}

/**
 * What a step route adds to the executor's ctx for an app with the wide server scope
 * (appStudio/actionExecutor/wideScope.mts): the screen params, the other forms and the action
 * results the request carries. The forms follow the fields this viewer's role sees, as
 * `formValues` does (visibleFormValues); the owner sends everything. Nothing at all for an app
 * without the wide scope.
 * @param {unknown} def  the definition the request runs
 * @param {string | null | undefined} role
 * @param {unknown} body  the request body
 * @returns {{ wideScope?: import('../appStudio/actionExecutor/wideScope.mts').WideScope }}
 */
function wideScopeFor(def, role, body) {
    const input = require('../appStudio/actionExecutor/wideScope.mts').wideScopeInput(def, body);
    if (!input.wideScope || role === 'owner') return input;
    const forms = require('../appStudio/formFieldGate.mts').withoutGatedFormsFields(input.wideScope.forms, def, (/** @type {unknown} */ node) => roleAllows(/** @type {{ visibleToRoles?: unknown } | null} */ (node), role));
    return forms === input.wideScope.forms ? input : { wideScope: { ...input.wideScope, forms } };
}

/**
 * The definition a request runs: non-owners ALWAYS the frozen published one; the working
 * draft only for the owner with ?draft=1 (or true).
 * @template D
 * @param {{ userId: string, definition?: D, publishedDefinition?: D }} app
 * @param {import('express').Request} req
 * @param {string} userId
 * @returns {{ def: D | undefined, isOwner: boolean, draft: boolean }}
 */
function pickDefinition(app, req, userId) {
    const isOwner = app.userId === userId;
    const draft = isOwner && ['1', 'true'].includes(String(req.query?.draft ?? ''));
    return { def: draft ? app.definition : app.publishedDefinition, isOwner, draft };
}

/**
 * The viewer's role in the app (its data model's role mapping) and that model, read once.
 * @param {import('express').Request} req
 * @param {{ id: string, userId: string }} app
 * @param {string} userId
 * @returns {Promise<{ role: string | null, model: unknown }>}
 */
async function resolveViewerRole(req, app, userId) {
    const studioAppDataStore = require('../stores/studioAppDataStore');
    const rlsGateway = require('../appStudio/rlsGateway');
    const { userGroups } = await resolveAudienceContext(req);
    const meta = await studioAppDataStore.getDataModel(app.id, app.userId);
    const model = (meta && meta.model) ? meta.model : null;
    const role = await rlsGateway.resolveViewerRole(app, userId, model, { userGroups });
    return { role: role || null, model };
}

module.exports = { loadVisibleApp, roleAllows, actionRoleAccess, assertActionRoleAccess, locateNode, assertChatAccess, visibleFormValues, wideScopeFor, documentChecks, stepDocumentContext, pickDefinition, resolveViewerRole };
