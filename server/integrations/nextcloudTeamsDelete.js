// @typecheck noImplicitAny
'use strict';
const { extractReason } = require('./nextcloudHttpError');
const log = require('../telemetry/log');

// Circles can finish a destroy a moment after it answers; read back once more before giving up.
const SETTLE_MS = 1500;
const OWNER_LEVEL = 9;
/**
 * @param {number} ms
 */
const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/**
 * teams_delete, apart from nextcloudTeamsTools.js (which only dispatches).
 *
 * A write reaches Circles through the connector tunnel (POST + method
 * override), and a 200 there was once enough to report success while the team
 * lived on. So the answer is checked twice: the OCS status inside the body
 * (it can disagree with the HTTP status) and then the team is read back, which
 * must be gone (404). Anything else is reported, never claimed as done.
 */

/** @param {string} text */
function parseJson(text) {
    try { return JSON.parse(text); } catch (err) { log.debug('[teams] read-back was not JSON', { reason: err instanceof Error ? /** @type {Error} */ (err).message : String(err) }); return null; }
}

/**
 * Nextcloud's refusal inside an HTTP-2xx answer, or '' when the body does not say no.
 * @param {{ meta?: { statuscode?: number|string, message?: string } } | null} ocs
 */
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
 * @param {{ api: string, ncFetch: Function, authError: string, handle: Function, HEADERS: Record<string,string>, sleep?: (ms: number) => Promise<void> }} deps
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
    const readBack = async () => {
        const res = await ncFetch(teamPath, { headers: HEADERS });
        const text = await res.text().catch(() => '');
        const body = parseJson(text);
        return { status: res.status, ok: res.ok, level: Number(body?.ocs?.data?.initiator?.level) };
    };
    let check = await readBack();
    if (check.ok) {
        await (deps.sleep || sleepMs)(SETTLE_MS);
        check = await readBack();
    }
    if (check.status === 404) return { success: true, teamId: args.teamId };
    if (check.status === 401) return { error: authError };
    if (check.ok) {
        const level = Number.isFinite(check.level) ? check.level : null;
        log.warn('[teams] delete answered success but the team still exists', { status: out.ocs?.meta?.statuscode ?? null, message: extractReason(JSON.stringify({ ocs: { meta: { message: out.ocs?.meta?.message } } })).slice(0, 200), initiatorLevel: level });
        const why = level !== null && level < OWNER_LEVEL
            ? ' Only the owner of a team can delete it, and this account is not the owner (membership level ' + level + ').'
            : '';
        return { error: 'Nextcloud answered the delete with success, but the team still exists. It was not deleted.' + why };
    }
    return { error: `The team delete could not be confirmed: reading the team back failed (${check.status}). Check with nextcloud_teams_get before relying on it.` };
}

module.exports = { deleteTeam, ocsRefusal };
