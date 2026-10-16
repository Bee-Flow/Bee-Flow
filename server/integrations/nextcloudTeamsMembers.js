// @typecheck
'use strict';
/**
 * teams_add_members, apart from nextcloudTeamsTools.js (which only dispatches):
 * Circles reports success for ids it did not add, so the result is read back.
 */

/** Lower-cased Nextcloud user ids currently in a team, or `{ error }`. */
async function memberUserIds(ncFetch, teamPath, authError, handle, HEADERS) {
    const out = await handle(await ncFetch(`${teamPath}/members`, { headers: HEADERS }), authError, 'member list');
    if (out.error) return out;
    const set = new Set();
    for (const m of Array.isArray(out.data) ? out.data : []) {
        // Only user members: a group or team member carries another userType.
        if (m && m.userId && (m.userType === undefined || m.userType === 1)) set.add(String(m.userId).toLowerCase());
    }
    return set;
}

/**
 * @param {{ api: string, ncFetch: Function, authError: string, handle: Function, HEADERS: Record<string,string> }} deps
 * @param {any} args
 */
async function addMembers(deps, args) {
    const { api, ncFetch, authError, handle, HEADERS } = deps;
    if (!args.teamId) return { error: 'teamId is required' };
    const ids = Array.isArray(args.userIds) ? args.userIds.filter(Boolean) : [];
    if (!ids.length) return { error: 'userIds must be a non-empty array of Nextcloud user ids' };
    const teamPath = `${api}/${encodeURIComponent(args.teamId)}`;
    // Circles answers /members/multi with success even for ids it did
    // not add, so the outcome is read from the member list, before and
    // after, per user.
    const before = await memberUserIds(ncFetch, teamPath, authError, handle, HEADERS);
    if (before.error) return before;
    const wanted = [...new Set(ids.map(String))];
    const skipped = wanted.filter(id => before.has(id.toLowerCase()));
    const toAdd = wanted.filter(id => !before.has(id.toLowerCase()));
    if (!toAdd.length) return { success: true, teamId: args.teamId, added: [], skipped, errors: [] };
    // The /members/multi endpoint takes [{id, type}] with type 1 = user.
    const out = await handle(
        await ncFetch(`${teamPath}/members/multi`, {
            method: 'POST', headers: HEADERS,
            body: JSON.stringify({ members: toAdd.map(id => ({ id, type: 1 })) }),
        }),
        authError, 'member add',
    );
    if (out.error) return out;
    const after = await memberUserIds(ncFetch, teamPath, authError, handle, HEADERS);
    if (after.error) {
        return { error: `The add was sent but could not be verified: ${after.error}`, teamId: args.teamId };
    }
    const added = toAdd.filter(id => after.has(id.toLowerCase()));
    const failed = toAdd.filter(id => !after.has(id.toLowerCase()));
    const errors = failed.map(id => ({ userId: id, error: 'not added: the user does not exist or may not be added by this account' }));
    if (failed.length) {
        // `error` is what makes an automation step fail; the per-user detail stays alongside.
        return {
            error: `Not added: ${failed.join(', ')}. The user does not exist or may not be added by this account.`,
            teamId: args.teamId, added, skipped, errors,
        };
    }
    return { success: true, teamId: args.teamId, added, skipped, errors };
}

module.exports = { addMembers };
