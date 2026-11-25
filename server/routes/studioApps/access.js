// @typecheck strict
/**
 * Who may build, and who may read, a Studio app (routes/studioApps/).
 *
 * Shared by every part of the /api/studio-apps router: the manage_apps gate
 * (ONE instance, so every write route goes through the same middleware), the
 * caller's audience, the uniform read refusal, and the owner's organisation.
 */

const userStore = require('../../stores/userStore');
const { resolveAudienceContext } = require('../../auth/audience');
const { requirePermission } = require('../../auth/permissions');
// Publish / unpublish / groups, shared with a Solution stage's on/off.
const appAudience = require('../../appStudio/appAudience');
const studioAppStore = require('../../stores/studioAppStore');
const { HttpError } = require('../../core/http/errors');
const { sessionUser } = require('../../core/http/sessionUser');

// ── Who may BUILD an app, as opposed to use one ──────────────────────
// The mount in server/index.js gates /api/studio-apps on requireModule('apps')
// + requireCapability('app_studio'). Those answer "does this installation have
// App Studio?" — not "may this person build and publish with it". The
// `manage_apps` permission existed in the registry and had no enforcement site
// anywhere, so any signed-in member of an org with the capability could create
// an app and publish it to the whole organisation, or mint a public internet
// URL for it.
//
// It bites hardest on self-hosted, where beta capabilities are granted
// org-wide to every member (core/entitlements/entitlements.js), so narrowing by
// group does not help there.
//
// WHO HOLDS IT — config/orgRoles.json. The gate went in (2026-09-09) on the
// belief that the role policy already handed the permission out; it did not,
// no org role carried it, so until 2026-09-12 only a platform super-admin could
// create, save or publish an app, and an org admin arriving through the
// Nextcloud connector got "Permission 'manage_apps' required" on a blank
// New-app form. Building an app is authoring, so the three authoring roles
// (org_admin, agent_admin, agent_editor — the ones that hold manage_agents)
// carry it and a plain member does not. routes/writeGates.test.js pins both
// halves: the gate on the routes AND a grant in the policy.
//
// Applied to the WRITE and PUBLISH routes only. Reading and running an app stay
// on the capability: using what somebody else built is the ordinary case, and
// the runtime routes have their own per-app access rules.
const requireManageApps = requirePermission('manage_apps');

// The orgs the caller is a MEMBER of, as a plain array for the store predicates
// (auth/audience resolveAudienceContext, memberOrgIds): a super-admin sees what is published to their
// organisations, like any member, in the list and in the single read alike.
/** @param {import('express').Request} req */
async function audienceFor(req) {
    const { userId, orgIds, memberOrgIds, userGroups } = await resolveAudienceContext(req);
    const orgIdArr = [...(memberOrgIds ?? orgIds ?? [])];
    return { userId, orgIdArr, userGroups };
}

/**
 * The refusal for a read the audience check turned down.
 *
 * A stranger gets the uniform 404 — an app must not confirm its existence to
 * someone outside its organisation. A member of the app's own organisation who
 * is simply not in the groups it was published to gets a 403 that says so:
 * they are the intended reader pool, they reached the app by an id that is
 * 122 random bits (nothing to enumerate), and once the app sits in the org's
 * Nextcloud menu its name is in front of them anyway. What they see instead of
 * "not found" is "shared with specific groups — ask the owner", which is the
 * truth and the one thing they can act on. The body carries no name and no
 * owner; a published-to-groups app reveals nothing more than that it exists.
 * @param {import('express').Response} res
 * @param {{ isPublished?: boolean, organizationId?: string | null, sharedGroups?: string[] }} app
 * @param {string[]} orgIdArr
 * @param {string[]} userGroups
 */
function refuseRead(res, app, orgIdArr, userGroups) {
    if (app.isPublished && app.organizationId && orgIdArr.includes(app.organizationId)) {
        if (!app.sharedGroups?.length || app.sharedGroups.some(id => userGroups.includes(id))) {
            return res.status(403).json({ error: "Permission 'use_apps' required" });
        }
        return res.status(403).json({
            error: 'This app is shared with specific groups in your organisation',
            code: 'not_in_audience',
        });
    }
    return res.status(404).json({ error: 'App not found' });
}

// Owner's org: primary organizationId first, then the org of their first
// org-bearing group — mirrors the entire-org publish fallback in webpages.js.
/**
 * @param {string} userId
 */
const resolveOwnerOrgId = (userId) => appAudience.resolveOwnerOrgId(userId, userStore);

// The owner-only routes (triggers, AI capabilities): a trigger and an AI step run as the owner.
/**
 * Middleware: the app when the caller owns it, on `res.locals.ownedApp`; anything else is the 404
 * of an unknown app. Before the body is read, so a stranger learns nothing from a refused body.
 * @param {import('express').Request<{ id: string }>} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
async function gateOwnedApp(req, res, next) {
    const app = await studioAppStore.getStudioApp(req.params.id);
    if (!app || !studioAppStore.canWriteStudioApp(app, sessionUser(req).id)) throw new HttpError(404, 'not_found', 'App not found');
    res.locals.ownedApp = app;
    next();
}

module.exports = {
    requireManageApps,
    gateOwnedApp,
    audienceFor,
    refuseRead,
    resolveOwnerOrgId,
};
