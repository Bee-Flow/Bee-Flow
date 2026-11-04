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
const { EVENT_NAMES } = require('../appStudio/componentSpecs');
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
// trees for an event wiring (EVENT_NAMES) OR a per-row action
// (props.rowActions on data_grid, props.itemActions on repeater) naming the
// action; a wiring counts only when its screen AND every ancestor container
// clear the gate too. referenced:false means NO node wires the action and no
// other action calls it — it is programmatic (an onSuccess chain), which role
// gating never described, so the caller keeps running it.
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
            let wired = EVENT_NAMES.some((ev) => node[ev] === actionId);
            if (!wired) {
                const props = (node.props && typeof node.props === 'object') ? node.props : {};
                for (const listKey of ['rowActions', 'itemActions']) {
                    const entries = props[listKey];
                    if (!Array.isArray(entries)) continue;
                    if (entries.some((e) => e && typeof e === 'object' && e.actionId === actionId)) { wired = true; break; }
                }
            }
            if (wired) {
                referenced = true;
                if (nodeVisible) allowed = true;
            }
            walk(node.children, nodeVisible);
        }
    };
    for (const screen of (Array.isArray(def?.screens) ? def.screens : [])) {
        const screenVisible = roleAllows(screen, role);
        for (const section of (Array.isArray(screen?.sections) ? screen.sections : [])) {
            walk(section?.children, screenVisible);
        }
    }
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
// when at least one caller is allowed (or is itself programmatic). An action
// that something calls is never "programmatic", so a direct POST of a callee
// of an admin-only root is refused like the root. The seen-set bounds a
// hand-written cycle (the validator rejects those); a cycle grants nothing.
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
        const via = actionRoleAccess(def, caller, role, seen);
        if (!via.referenced || via.allowed) return { referenced: true, allowed: true };
    }
    return { referenced, allowed: false };
}

/**
 * The role gate for both bridges. Answers 403 itself and returns false when the
 * viewer's role cannot reach the action; returns true otherwise. The owner and
 * any action no node wires and no action calls (onSuccess chains) always pass;
 * a called action passes when the role can reach one of its callers.
 * @param {import('express').Response} res
 * @param {{ screens?: unknown } | null | undefined} def
 * @param {string} actionId
 * @param {string | null | undefined} role
 * @param {{ isOwner: boolean }} opts
 */
function assertActionRoleAccess(res, def, actionId, role, { isOwner }) {
    if (isOwner || role === 'owner') return true;
    const access = actionRoleAccess(def, actionId, role);
    if (access.referenced && !access.allowed) {
        res.status(403).json({ error: 'This action is not available for your role' });
        return false;
    }
    return true;
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
        actionAllowed: (/** @type {string} */ actionId) => {
            if (everything) return true;
            const access = actionRoleAccess(def, actionId, role);
            return !access.referenced || access.allowed;
        },
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

module.exports = { loadVisibleApp, roleAllows, actionRoleAccess, assertActionRoleAccess, documentChecks, stepDocumentContext, pickDefinition, resolveViewerRole };
