// @typecheck
/**
 * Pure, DB-free org-membership resolution for a THIRD PARTY.
 *
 * `resolveUserOrgIds(req)` (permissions.js:642) answers a different question:
 * "which orgs may the CALLER see". It takes a request, hits the DB, and returns
 * `null` — meaning "no filter, see everything" — for super-admin sessions. So it
 * cannot answer "which orgs is THAT user in", and its `null` would read as
 * "unrestricted" rather than "all of them". These helpers answer the
 * third-party question over rows the caller already holds, mirroring
 * resolveUserOrgIds' union semantics exactly:
 *
 *   membership = users.organizationId  UNION  { g.organizationId | g ∈ user.groups }
 *
 * There is no join table — `users.groups` is a JSON-encoded TEXT column — so
 * both paths are required, and a user can legitimately belong to several orgs.
 *
 * MIRRORED in agent-hub/src/components/admin/security/people/orgMembership.js:
 * the frontend cannot import this CJS module into its Vite bundle, and the
 * People directory must group by the same rule the server filters by. The two
 * copies are pinned by a behavioural lockstep test (orgMembershipLockstep.test.js)
 * that runs both over one fixture matrix. Change both, or the build goes red.
 * Same duplicate-plus-lockstep idiom as server/learning/courseCatalog.js and
 * server/i18n/defaults/en.js.
 */

/**
 * `users.groups` is a TEXT column holding a JSON array, but getUser() may have
 * already parsed it. Accept either, and never throw on malformed JSON —
 * permissions.js:657-662 and loginRoutes.js:56 both parse defensively.
 */
function parseGroupIds(userRow) {
    const raw = userRow && userRow.groups;
    if (Array.isArray(raw)) return raw;
    try {
        const parsed = JSON.parse(raw || '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
        return [];
    }
}

/**
 * Every org this user reaches, and how. One entry per (org, path), so a user
 * attached both directly and through a group yields two entries for that org —
 * the "Via" filter needs that distinction. Callers wanting a plain set want
 * orgIdsForUser().
 *
 * @returns {Array<{ orgId: string, via: 'direct' | `group:${string}` }>}
 */
function membershipFor(userRow, allGroups = []) {
    const out = [];
    const seen = new Set();
    const add = (orgId, via) => {
        // `users.organizationId` DEFAULTs to '' (userStore.js:38) and a global
        // group's organizationId is NULL — both falsy, and neither is an org.
        if (!orgId) return;
        const key = `${orgId}|${via}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ orgId, via });
    };

    add(userRow && userRow.organizationId, 'direct');
    for (const gid of parseGroupIds(userRow)) {
        const group = allGroups.find((g) => g.id === gid);
        add(group && group.organizationId, `group:${gid}`);
    }
    return out;
}

/** The distinct orgs this user reaches, by either path. */
function orgIdsForUser(userRow, allGroups = []) {
    return new Set(membershipFor(userRow, allGroups).map((m) => m.orgId));
}

/** Does this user reach `orgId` by either path? */
function isMemberOfOrg(userRow, allGroups, orgId) {
    if (!orgId) return false;
    return orgIdsForUser(userRow, allGroups).has(orgId);
}

module.exports = { parseGroupIds, membershipFor, orgIdsForUser, isMemberOfOrg };
