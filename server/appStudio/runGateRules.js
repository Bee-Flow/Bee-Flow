// @typecheck strict
/**
 * App Studio role rules: the ONE copy of "may this role reach this action" and "which
 * documents does this role see".
 *
 * Pure functions over a definition and a role: no request, no response, no store. The HTTP
 * gates that answer a request with them are in routes/studioAppRunGate.js (which exports
 * these too, so a route file has one place to require). They live here, below the routes,
 * because a background run reads them as well (backgroundRunIdentity.mts when a paused run
 * continues, backgroundRunParts.mts for a copy_document step), and nothing below the API
 * layer may require a router file.
 */

'use strict';

const { nodeActionRefs } = require('./nodeActionRefs.mts');
const { screenTriggerRefs, watchersOf } = require('../shared/appDefinition/clientTriggers.mjs');

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
// (routes/studioAppRunGate.js assertActionRoleAccess). A server trigger or a mailbox hook (its action lives in the data
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
            // Every way a node runs an action, from the one shared reader (nodeActionRefs.mts).
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
    const { callTargets, ownAction } = require('./actionCalls.mts');
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
    return { documentPool: require('./appDocuments/pool.mts').documentPool(def, documentChecks(def, role)) };
}

module.exports = { roleAllows, actionRoleAccess, documentChecks, stepDocumentContext };
