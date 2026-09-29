/**
 * WHO A PLAYBOOK'S ASSISTANTS MAY NAME — the people and groups handed to a
 * model that proposes access (accessPhaseRoutes: the access assistant) or a
 * fix for a compliance finding (complianceRoutes: resolve-plan). One rule for
 * both, because both put the directory into a model's prompt and both can
 * resolve a name or an e-mail from it into a user id in the plan they return.
 */

'use strict';

function groupIdsOf(u) {
    if (Array.isArray(u.groups)) return u.groups;
    try {
        const parsed = JSON.parse(u.groups || '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
}

/**
 * For an organisation's playbook, the rule GET /auth/users applies to "which
 * people may this person see" (auth/admin/userRoutes.js): the organisation's
 * own groups, its members and the people in those groups -- and the owner. A
 * playbook with NO organisation belongs to an account with none: the
 * installation's own operator, who may see everyone there too, or a consumer,
 * whose directory is themselves and no groups. Who is ASKING never widens an
 * organisation's directory: an operator's org playbook is scoped like
 * anyone's, because what is in the directory goes into a model's prompt.
 *
 * Both routes used `!orgId || !x.organizationId || x.organizationId === orgId`,
 * which read a missing organisation as a missing FILTER. A consumer account's
 * playbook (accountProvisioning: a consumer IS an account with no
 * organisation) handed every person and every group in the installation --
 * other tenants included -- to the model, up to forty names in its prompt,
 * and any of them could be resolved by name or e-mail into the plan that came
 * back with its user id. The same clause admitted every account and every
 * group WITHOUT an organisation into every organisation's directory: consumer
 * accounts, and global groups, which are shared across organisations -- so
 * proposing one for this org's app proposed people from other tenants
 * (routes/ai/config/integrations.js refuses an org admin that group for the
 * same reason). The access assistant was fixed first; resolve-plan kept the
 * old clause until it was moved here.
 *
 * @returns {{ groups: object[], users: object[] }}
 */
function directoryFor(pb, session, groups, users) {
    const orgId = pb.organizationId || null;
    if (!orgId) {
        const operator = !!(session && (session.isAdmin || session.user?.role === 'admin'));
        if (operator) return { groups, users };
        return { groups: [], users: users.filter((u) => u && u.id === pb.userId) };
    }
    const orgGroups = groups.filter((g) => g && g.organizationId === orgId);
    const orgGroupIds = new Set(orgGroups.map((g) => g.id));
    const people = users.filter((u) => u && (
        u.id === pb.userId
        || u.organizationId === orgId
        || groupIdsOf(u).some((gid) => orgGroupIds.has(gid))
    ));
    return { groups: orgGroups, users: people };
}

module.exports = { directoryFor };
