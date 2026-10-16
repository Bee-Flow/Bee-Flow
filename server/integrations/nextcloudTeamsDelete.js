// @typecheck
'use strict';
const { extractReason } = require('./nextcloudHttpError');
/**
 * teams_delete, apart from nextcloudTeamsTools.js (which only dispatches).
 *
 * A write reaches Circles through the connector tunnel (POST + method
 * override), and a 200 there was once enough to report success while the team
 * lived on. So the answer is checked twice: the OCS status inside the body
 * (it can disagree with the HTTP status) and then the team is read back, which
 * must be gone (404). Anything else is reported, never claimed as done.
 */

/** Nextcloud's refusal inside an HTTP-2xx answer, or '' when the body does not say no. */
function ocsRefusal(ocs) {
    const meta = ocs && typeof ocs === 'object' ? ocs.meta : null;
    if (!meta || meta.statuscode == null) return '';
    const code = Number(meta.statuscode);
    if (code === 100 || (code >= 200 && code < 300)) return '';
    // extractReason strips control characters and caps the length.
    const reason = extractReason(JSON.stringify({ ocs: { meta: { message: meta.message } } }));
    const message = reason ? `: ${reason}` : '';
    return `Nextcloud refused the delete (status ${code})${message}`;
}

/**
 * @param {{ api: string, ncFetch: Function, authError: string, handle: Function, HEADERS: Record<string,string> }} deps
 * @param {any} args
 */
async function deleteTeam(deps, args) {
    const { api, ncFetch, authError, handle, HEADERS } = deps;
    if (!args.teamId) return { error: 'teamId is required' };
    const teamPath = `${api}/${encodeURIComponent(args.teamId)}`;
    const out = await handle(await ncFetch(teamPath, { method: 'DELETE', headers: HEADERS }), authError, 'team delete');
    if (out.error) return out;
    const refusal = ocsRefusal(out.ocs);
    if (refusal) return { error: refusal };
    const check = await ncFetch(teamPath, { headers: HEADERS });
    await check.text().catch(() => '');
    if (check.status === 404) return { success: true, teamId: args.teamId };
    if (check.status === 401) return { error: authError };
    if (check.ok) {
        return { error: 'Nextcloud answered the delete with success, but the team still exists. It was not deleted.' };
    }
    return { error: `The team delete could not be confirmed: reading the team back failed (${check.status}). Check with nextcloud_teams_get before relying on it.` };
}

module.exports = { deleteTeam, ocsRefusal };
