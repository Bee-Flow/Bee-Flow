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

// ── App visibility ──────────────────────────────────────────────────
// Owner always; everyone else needs is_published plus one audience that
// carries them: their org, one of its shared groups, or a Studio Project the
// app is filed into (canReadStudioAppAsync — the project half is a DB lookup,
// which is why the gate awaits). Failures answer 404 so existence never leaks.
// Responds itself and returns null on failure.
async function loadVisibleApp(req, res) {
    const userId = req.session.user.id;
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
function roleAllows(nodeOrScreen, role) {
    const gate = nodeOrScreen && nodeOrScreen.visibleToRoles;
    if (!Array.isArray(gate) || gate.length === 0) return true;
    return gate.includes(role);
}

// Can `role` reach `actionId` through the UI? Walks screens → sections → node
// trees for an event wiring (EVENT_NAMES) OR a per-row action
// (props.rowActions on data_grid, props.itemActions on repeater) naming the
// action; a wiring counts only when its screen AND every ancestor container
// clear the gate too. referenced:false means NO node wires the action — it is
// programmatic (an action step, an onSuccess chain), which role gating never
// described, so the caller keeps running it.
function actionRoleAccess(def, actionId, role) {
    let referenced = false;
    let allowed = false;
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
 * The role gate for both bridges. Answers 403 itself and returns false when the
 * viewer's role cannot reach the action; returns true otherwise. The owner and
 * any action no node wires (programmatic actions, onSuccess chains) always pass.
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

module.exports = { loadVisibleApp, roleAllows, actionRoleAccess, assertActionRoleAccess };
