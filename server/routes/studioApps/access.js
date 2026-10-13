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

// resolveUserOrgIds returns null for super-admin; collapse Sets/null to a
// plain array so the store predicates can iterate it (same as webpages.js).
async function audienceFor(req) {
    const { userId, orgIds, userGroups } = await resolveAudienceContext(req);
    const orgIdArr = orgIds instanceof Set ? [...orgIds] : (Array.isArray(orgIds) ? orgIds : []);
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
 */
function refuseRead(res, app, orgIdArr) {
    if (app.isPublished && app.organizationId && orgIdArr.includes(app.organizationId)) {
        return res.status(403).json({
            error: 'This app is shared with specific groups in your organisation',
            code: 'not_in_audience',
        });
    }
    return res.status(404).json({ error: 'App not found' });
}

// Owner's org: primary organizationId first, then the org of their first
// org-bearing group — mirrors the entire-org publish fallback in webpages.js.
const resolveOwnerOrgId = (userId) => appAudience.resolveOwnerOrgId(userId, userStore);

module.exports = {
    requireManageApps,
    audienceFor,
    refuseRead,
    resolveOwnerOrgId,
};
