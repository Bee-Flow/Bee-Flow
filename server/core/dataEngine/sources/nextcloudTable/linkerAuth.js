/**
 * "May this mirror talk to Nextcloud right now, and as whom?"
 *
 * Every Nextcloud call a mirror makes — the refresh, the event patch, the
 * write-through — runs as the account that LINKED it, off any request path,
 * so the session is rebuilt the way the runner rebuilds one for a scheduled
 * automation (sessionResolution.resolveUserSession → nextcloudClient.resolveAuth).
 * For a connector-bound organisation that needs no stored credential at all.
 *
 * Three gates run before the answer is handed out, and they are the SAME three
 * the agent tools pass through, so a table a person cannot reach in chat is
 * one their mirror cannot reach either:
 *   1. the organisation is still bound to Nextcloud (auth/ncAudience.isNcOrg)
 *      and to the SAME instance the table was linked from — and the linker
 *      still belongs to it: resolveAuth routes a connector call on the
 *      SESSION's org, so a linker moved to another connector-bound tenant
 *      would otherwise read (and write) THAT tenant's table of the same id
 *   2. the Tables integration is on for the linker (integrationTools)
 *   3. the linker's per-user Nextcloud scope allows this table (ncScopeGuard —
 *      the same policy nextcloud_tables_list_rows is checked against)
 * A refusal is a NextcloudSourceError the caller records on the sync state or
 * answers with; it is never swallowed into "no rows".
 *
 * Memoised for a minute per linker, like datatableDbStore's access memo: a
 * refresh pass calls this once, but a burst of push events for one table
 * would otherwise rebuild the same session per event.
 */

'use strict';

const { NextcloudSourceError } = require('./errors');

const MEMO_TTL_MS = 60_000;
const _memo = new Map();   // linkedByUserId → { at, value }

function deps() {
    // Lazily required: the pure modules beside this one must stay loadable in
    // suites that stub the database, and these pull in stores at load time.
    return {
        resolveUserSession: require('../../../automationRunner/sessionResolution').resolveUserSession,
        ncClient: require('../../../../integrations/nextcloudClient'),
        isNcOrg: require('../../../../auth/ncAudience').isNcOrg,
        isIntegrationPermittedForUser: require('../../../integrations/integrationTools').isIntegrationPermittedForUser,
        checkToolCall: require('../../../integrations/ncScopeGuard').checkToolCall,
        userStore: require('../../../../stores/userStore'),
    };
}

/**
 * @param {object} source   the mirror's `source` block
 * @param {object} [opts]
 * @param {string|null} [opts.orgId]  the table's organisation (null for a personal mirror)
 * @param {boolean} [opts.fresh]      skip the memo (a re-link, a "try again")
 * @returns {Promise<{ auth:object, userId:string, session:object }>}
 */
async function resolveLinker(source, { orgId = null, fresh = false } = {}) {
    const userId = source && source.linkedByUserId;
    if (!userId) {
        throw new NextcloudSourceError(503, 'linker_unavailable', 'This table has no linking account any more — ask an owner to re-link it.');
    }
    const memoKey = `${userId}|${orgId || ''}|${source.ncTableId || ''}`;
    const hit = _memo.get(memoKey);
    if (!fresh && hit && Date.now() - hit.at < MEMO_TTL_MS) {
        if (hit.error) throw hit.error;
        return hit.value;
    }

    const d = deps();
    let value = null;
    let error = null;
    try {
        value = await resolveUncached(d, source, userId, orgId);
    } catch (e) {
        error = e;
    }
    // A refusal is memoised too — for the same minute — so a table the linker
    // lost access to is not re-probed on every push event.
    _memo.set(memoKey, { at: Date.now(), value, error });
    if (error) throw error;
    return value;
}

async function resolveUncached(d, source, userId, orgId) {
    // The org, if the mirror has one, must still be a Nextcloud org and still
    // the SAME instance the table was linked from.
    if (orgId) {
        if (!await d.isNcOrg(orgId)) {
            throw new NextcloudSourceError(403, 'not_nc_org', 'This organisation is no longer connected to Nextcloud.');
        }
        if (source.ncInstanceId) {
            const org = await d.userStore.getOrganization(orgId).catch(() => null);
            const current = org && (org.nc_instance_id || org.ncInstanceId);
            if (current && current !== source.ncInstanceId) {
                throw new NextcloudSourceError(503, 'nc_instance_changed',
                    'This organisation is connected to a different Nextcloud than the one this table was linked from — re-link it.');
            }
        }
    }

    const session = await d.resolveUserSession(userId).catch(() => null);
    if (!session) {
        throw new NextcloudSourceError(503, 'linker_unavailable',
            'The account that linked this table could not be signed in to Nextcloud — ask an owner to re-link it.');
    }
    // The linker must still belong to the org that owns the table. The org
    // resolveAuth → resolveNcBinding routes the connector call on is the
    // SESSION's (connectorOrgId → user.organizationId), rebuilt from the
    // user row — the instance check above reads the TABLE's org and cannot
    // see a linker who moved to another connector-bound tenant, whose
    // Nextcloud would then answer for table id `ncTableId` (same twin in
    // ../spreadsheetFile/linkerAuth.js).
    const linkerOrgId = session.connectorOrgId || (session.user && session.user.organizationId) || null;
    if (orgId && linkerOrgId && linkerOrgId !== orgId) {
        throw new NextcloudSourceError(503, 'linker_unavailable',
            'The account that linked this table now belongs to another organisation — ask an owner to re-link it.');
    }

    if (!await d.isIntegrationPermittedForUser({ userId, appId: 'nextcloud-tables', session, isAdmin: !!session.isAdmin })) {
        throw new NextcloudSourceError(403, 'nextcloud_integration_off',
            'Nextcloud Tables is switched off for the account that linked this table.');
    }

    const denial = await d.checkToolCall({
        toolName: 'nextcloud_tables_list_rows',
        toolArgs: { tableId: source.ncTableId },
        userId,
        orgId: orgId || session.connectorOrgId || session.user?.organizationId || null,
    });
    if (denial) {
        throw new NextcloudSourceError(403, 'nc_scope_denied',
            'The account that linked this table no longer shares it with Bee Flow — ask an owner to re-link it.',
            { ncTableId: source.ncTableId });
    }

    const auth = await d.ncClient.resolveAuth(session, userId);
    if (!auth || !auth.baseUrl || typeof auth.fetch !== 'function') {
        throw new NextcloudSourceError(503, 'linker_unavailable',
            auth && auth.authError ? auth.authError : 'The account that linked this table has no working Nextcloud connection.');
    }
    return { auth, userId, session };
}

/** Test/relink hook: forget a linker's memo. */
function forget(userId) {
    for (const k of _memo.keys()) if (k.startsWith(`${userId}|`)) _memo.delete(k);
}

module.exports = { resolveLinker, forget, _memo, MEMO_TTL_MS };
