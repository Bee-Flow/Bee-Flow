// @typecheck strict
/**
 * App Studio run-bridge gates — the ONE copy of "may this viewer see this app"
 * and "may this role reach this action".
 *
 * Extracted so the plain step bridge (studioAppsRun.js) and the streaming
 * browse bridge (studioAppBrowse.js) share identical gates. A second copy of
 * the role walk is exactly how one surface drifts wider than the other — the
 * failure this module exists to prevent.
 */

'use strict';

const studioAppStore = require('../stores/studioAppStore');
const { resolveAudienceContext } = require('../auth/audience');
const { nodeActionRefs } = require('../appStudio/nodeActionRefs.mts');
const { screenTriggerRefs, watchersOf } = require('../shared/appDefinition/clientTriggers.mjs');
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
        const { orgIds, userGroups } = await resolveAudienceContext(req);
        const orgIdArr = orgIds instanceof Set ? [...orgIds] : (Array.isArray(orgIds) ? orgIds : []);
        if (!await studioAppStore.canReadStudioAppAsync(app, userId, userGroups, orgIdArr)) {
            res.status(404).json({ error: 'App not found' });
            return null;
        }
    }
    return app;
}

// ── Role gate ───────────────────────────────────────────────────────
// Mirrors runtime/AppRenderer.jsx roleAllows(): a screen/node with no
// visibleToRoles — or an empty one — is open to everyone. DELIBERATE deviation:
// the renderer treats a null role as "no preview selected, show everything",
// which as a server rule would wave through every viewer without a mapped role,
// so here a null role clears open gates only.
/**
 * @param {{ visibleToRoles?: unknown } | null | undefined} nodeOrScreen
 * @param {string | null | undefined} role
 */
function roleAllows(nodeOrScreen, role) {
    const gate = nodeOrScreen && nodeOrScreen.visibleToRoles;
    if (!Array.isArray(gate) || gate.length === 0) return true;
    return gate.includes(role);
}

// Can `role` reach `actionId` through the UI? Walks screens → sections → node
// trees for an event wiring (EVENT_NAMES, one id or a list of them), a screen's
// onOpen or timer, a watcher (every viewer runs those), OR an action a node lists in
// its props (rowActions, itemActions, bulkActions, toolbarActions, addRowActionId, a
// column's actionId) naming the action; a wiring counts only when its screen, its section (section.visibleToRoles)
// AND every ancestor container clear the gate too. referenced:false means NO node wires the action and no
// other action calls it: nothing in the app runs it for a viewer, so only the owner may
// (assertActionRoleAccess). A server trigger or a mailbox hook (its action lives in the data
// model, outside the definition) is such a case: it runs as the owner, never from a viewer.
/**
 * @param {{ screens?: unknown } | null | undefined} def
 * @param {string} actionId
 * @param {string | null | undefined} role
 */
function wiredRoleAccess(def, actionId, role) {
    let referenced = false;
    let allowed = false;
    /**
     * @param {unknown} nodes
     * @param {boolean} visible
     */
    const walk = (nodes, visible) => {
        for (const node of (Array.isArray(nodes) ? nodes : [])) {
            if (!node || typeof node !== 'object') continue;
            const nodeVisible = visible && roleAllows(node, role);
            // Every way a node runs an action, from the one shared reader (appStudio/nodeActionRefs.mts).
            const wired = nodeActionRefs(node).some((/** @type {{ actionId: string }} */ ref) => ref.actionId === actionId);
            if (wired) {
                referenced = true;
                if (nodeVisible) allowed = true;
            }
            walk(node.children, nodeVisible);
        }
    };
    for (const screen of (Array.isArray(def?.screens) ? def.screens : [])) {
        const screenVisible = roleAllows(screen, role);
        // Schema 3: a screen's onOpen and timers run its actions for whoever can open the screen.
        if (screenTriggerRefs(screen).some((ref) => ref.actionId === actionId)) {
            referenced = true;
            if (screenVisible) allowed = true;
        }
        for (const section of (Array.isArray(screen?.sections) ? screen.sections : [])) {
            walk(section?.children, screenVisible && roleAllows(section, role));
        }
    }
    // A watcher (schema 3) runs in every viewer's browser, whatever screen is open.
    if (watchersOf(def).some((w) => w.actionId === actionId)) {
        referenced = true;
        allowed = true;
    }
    // A server trigger (schema 3) names the action: it is the trigger's to start, as the owner. That
    // alone lets no viewer run it; a button that also wires it does, for the roles that see the button.
    const triggers = /** @type {{ triggers?: unknown }} */ (def || {}).triggers;
    if (Array.isArray(triggers) && triggers.some((t) => t && typeof t === 'object' && t.actionId === actionId)) referenced = true;
    return { referenced, allowed };
}

/**
 * The actions that call `actionId` through a call_action step, from the
 * definition's actions map (own properties only).
 * @param {unknown} actions
 * @param {string} actionId
 * @returns {string[]}
 */
function callersOf(actions, actionId) {
    if (!actions || typeof actions !== 'object' || Array.isArray(actions)) return [];
    const { callTargets, ownAction } = require('../appStudio/actionCalls.mts');
    return Object.keys(actions).filter((id) => id !== actionId && ownAction(actions, id)
        && callTargets(ownAction(actions, id)).some((/** @type {{ actionId: string }} */ t) => t.actionId === actionId));
}

// Role access through calls: a called action is as reachable as the actions
// that call it. Its own wiring counts as before; on top of that it is allowed
// when at least one caller is allowed. A direct POST of a callee of an
// admin-only root, or of a root nothing wires, is refused like the root. The
// seen-set bounds a hand-written cycle (the validator rejects those); a cycle
// grants nothing.
/**
 * @param {{ screens?: unknown, actions?: unknown } | null | undefined} def
 * @param {string} actionId
 * @param {string | null | undefined} role
 * @param {Set<string>} [seen]
 * @returns {{ referenced: boolean, allowed: boolean }}
 */
function actionRoleAccess(def, actionId, role, seen = new Set()) {
    seen.add(actionId);
    const wired = wiredRoleAccess(def, actionId, role);
    if (wired.allowed) return wired;
    let referenced = wired.referenced;
    for (const caller of callersOf(def?.actions, actionId)) {
        referenced = true;
        if (seen.has(caller)) continue;
        if (actionRoleAccess(def, caller, role, seen).allowed) return { referenced: true, allowed: true };
    }
    return { referenced, allowed: false };
}

/** @typedef {{ id?: string, type?: string, props?: { modelTier?: string, knowledgeBaseIds?: string[], systemPrompt?: unknown }, children?: unknown, visibleToRoles?: unknown }} ComponentNode  a component as the definition stores it */

/**
 * A component node by id anywhere in the definition, and whether `role` sees
 * it: its screen, its section and every container above it clear roleAllows
 * (the walk of wiredRoleAccess).
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
 * same rules as a heavy step (a chat spends the owner's model budget). The
 * viewer needs a role in the app, and the chat must sit where that role sees
 * it. Answers itself (403 without a role, 404 for a chat the role does not
 * see, as if it were not there) and returns false; true when the chat may run.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {{ id: string, userId: string }} app
 * @param {{ screens?: unknown } | null | undefined} def
 * @param {string} nodeId
 * @param {string} userId
 */
async function assertChatAccess(req, res, app, def, nodeId, userId) {
    const { role } = await resolveViewerRole(req, app, userId);
    if (!role) {
        res.status(403).json({ error: 'You do not have access to this app yet' });
        return false;
    }
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
 * The role checks the app document pool (appDocuments/pool.mts) walks with:
 * which screens and nodes this viewer sees, which actions they can reach.
 * The same rules as the two gates above, so a document behind an admin-only
 * screen is as hidden as the button behind it. The owner sees everything.
 * @param {{ screens?: unknown } | null | undefined} def
 * @param {string | null | undefined} role
 */
function documentChecks(def, role) {
    const everything = role === 'owner';
    return {
        visible: (/** @type {unknown} */ nodeOrScreen) => everything || roleAllows(/** @type {{ visibleToRoles?: unknown } | null} */ (nodeOrScreen), role),
        actionAllowed: (/** @type {string} */ actionId) => everything || actionRoleAccess(def, actionId, role).allowed,
    };
}

/**
 * What a copy_document step adds to its executor ctx: the app's document pool
 * for this viewer. Any other step gets nothing.
 * @param {{ kind?: unknown } | null | undefined} step
 * @param {{ screens?: unknown, actions?: unknown } | null | undefined} def
 * @param {string | null | undefined} role
 */
function stepDocumentContext(step, def, role) {
    if (!step || step.kind !== 'copy_document' || !def) return {};
    return { documentPool: require('../appStudio/appDocuments/pool.mts').documentPool(def, documentChecks(def, role)) };
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
