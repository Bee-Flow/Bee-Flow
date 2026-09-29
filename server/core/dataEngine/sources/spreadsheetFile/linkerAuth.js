/**
 * "May this mirror talk to its storage right now, and as whom?"
 *
 * Every storage call a spreadsheet mirror makes — the probe, the download,
 * the write-through — runs as the account that LINKED it, off any request
 * path. The gates in front of the answer are the SAME ones the agent tools
 * pass through, so a file a person cannot reach in chat is one their mirror
 * cannot reach either:
 *   1. the table still has a linker (linkedByUserId)
 *   2. the storage's integration is on for that account (integrationTools —
 *      google-drive / onedrive / nextcloud)
 *   3. Google/Microsoft: a usable credential (credentials.js — vault first,
 *      session second, needs_reauth refused)
 *   3. Nextcloud: a session that resolves to a Nextcloud connection
 *      (connector → bearer → app password), a linker still IN the table's
 *      organisation (the session's org is the one the connector call is
 *      routed on), the SAME instance the table was linked from, and the
 *      linker's per-user Files scope covering the path
 *      (ncScopeGuard — nextcloud_read_file for reads, nextcloud_upload_file
 *      before a write; both are path policies, which is why the mirror stores
 *      the path and keeps the file id only as identity)
 * Each refusal has its own code; a refusal is a SpreadsheetSourceError the
 * caller records on the sync state or answers with, never "no rows".
 *
 * Memoised for a minute per linker+file, refusals too — a burst of pulses or
 * push events for one table would otherwise rebuild the same session each
 * time. Copied from ../nextcloudTable/linkerAuth.js, which set the idiom.
 */

'use strict';

const { SpreadsheetSourceError } = require('./errors');

const MEMO_TTL_MS = 60_000;
const _memo = new Map();   // memoKey → { at, value, error }

function deps() {
    // Lazily required: the pure modules beside this one must stay loadable in
    // suites that stub the database, and these pull in stores at load time.
    return {
        resolveUserSession: require('../../../automationRunner/sessionResolution').resolveUserSession,
        ncClient: require('../../../../integrations/nextcloudClient'),
        isIntegrationPermittedForUser: require('../../../integrations/integrationTools').isIntegrationPermittedForUser,
        checkToolCall: require('../../../integrations/ncScopeGuard').checkToolCall,
        userStore: require('../../../../stores/userStore'),
        credentials: require('./credentials'),
        providers: require('./providers'),
    };
}

const STORAGE_NAME = { google_drive: 'Google Drive', onedrive: 'OneDrive', nextcloud_files: 'Nextcloud' };

function refKeyOf(source) {
    const file = (source && source.file) || {};
    return source && source.provider === 'nextcloud_files' ? (file.path || '') : (file.id || file.fileId || '');
}

function orgForScope(orgId, session) {
    return orgId || (session && (session.connectorOrgId || (session.user && session.user.organizationId))) || null;
}

/**
 * @param {object} source   the mirror's `source` block ({ provider, file:{id,path,…}, linkedByUserId, ncInstanceId })
 * @param {object} [opts]
 * @param {string|null} [opts.orgId]  the table's organisation (null for a personal mirror)
 * @param {boolean} [opts.fresh]      skip the memo (a re-link, a "try again")
 * @param {boolean} [opts.write]      also run the write gate (Nextcloud upload scope) — call this before every write
 * @returns {Promise<{ api:object, userId:string, session:object|null, cred:object }>}
 */
async function resolveLinker(source, { orgId = null, fresh = false, write = false } = {}) {
    const userId = source && source.linkedByUserId;
    if (!userId) {
        throw new SpreadsheetSourceError(503, 'linker_unavailable', 'This table has no linking account any more — ask an owner to re-link it.');
    }
    const memoKey = `${userId}|${orgId || ''}|${source.provider || ''}|${refKeyOf(source)}`;
    const hit = _memo.get(memoKey);
    let value = null;
    if (!fresh && hit && Date.now() - hit.at < MEMO_TTL_MS) {
        if (hit.error) throw hit.error;
        value = hit.value;
    } else {
        const d = deps();
        let error = null;
        try {
            value = await resolveUncached(d, source, userId, orgId, fresh);
        } catch (e) {
            error = e;
        }
        // A refusal is memoised too — for the same minute — so a table the
        // linker lost access to is not re-probed on every push event.
        _memo.set(memoKey, { at: Date.now(), value, error });
        if (error) throw error;
    }
    if (write) await assertWritable(source, value, orgId);
    return value;
}

async function resolveUncached(d, source, userId, orgId, fresh) {
    let mod;
    try {
        mod = d.providers.providerFor(source.provider);
    } catch (_) {
        throw new SpreadsheetSourceError(422, 'spreadsheet_rejected', `This table points at an unknown storage (${String(source.provider).slice(0, 40)}).`);
    }
    const name = STORAGE_NAME[source.provider] || 'the storage';

    // Off the request path the session is rebuilt the way the runner rebuilds
    // one for a scheduled routine: vault tokens plus, for a connector-bound
    // user, the instance binding resolveAuth routes on.
    const session = await d.resolveUserSession(userId).catch(() => null);

    if (!await d.isIntegrationPermittedForUser({ userId, appId: mod.integrationAppIds[0], session, isAdmin: !!(session && session.isAdmin) })) {
        throw new SpreadsheetSourceError(403, 'provider_integration_off',
            `${name} is switched off for the account that linked this table.`);
    }

    const ctx = { userId, orgId, session };

    if (source.provider !== 'nextcloud_files') {
        const cred = await d.credentials.resolveProviderCredential(userId, mod.oauthProvider, { session, orgId, fresh });
        return { api: mod.forLinker(cred, ctx), userId, session, cred };
    }

    if (!session) {
        throw new SpreadsheetSourceError(503, 'linker_unavailable',
            'The account that linked this table could not be signed in to Nextcloud — ask an owner to re-link it.');
    }
    // The linker must still belong to the org that owns the table. The org
    // resolveAuth → resolveNcBinding routes the connector call on is the
    // SESSION's (connectorOrgId → user.organizationId), rebuilt from the
    // user row — a linker moved to another connector-bound tenant would
    // otherwise fetch THAT tenant's file at the same path into this table
    // (and write-through would PUT this table's edits into it). The
    // instance check below reads the TABLE's org, so it cannot see this.
    const linkerOrgId = session.connectorOrgId || (session.user && session.user.organizationId) || null;
    if (orgId && linkerOrgId && linkerOrgId !== orgId) {
        throw new SpreadsheetSourceError(503, 'linker_unavailable',
            'The account that linked this table now belongs to another organisation — ask an owner to re-link it.');
    }
    // The SAME instance the table was linked from — an org re-bound to another
    // Nextcloud would otherwise read a stranger's file at the same path.
    if (orgId && source.ncInstanceId) {
        const org = await d.userStore.getOrganization(orgId).catch(() => null);
        const current = org && (org.nc_instance_id || org.ncInstanceId);
        if (current && current !== source.ncInstanceId) {
            throw new SpreadsheetSourceError(503, 'nc_instance_changed',
                'This organisation is connected to a different Nextcloud than the one this table was linked from — re-link it.');
        }
    }
    await assertScope(d, 'nextcloud_read_file', source, userId, orgForScope(orgId, session));

    let auth = null;
    try {
        auth = await d.ncClient.resolveAuth(session, userId);
    } catch (e) {
        throw new SpreadsheetSourceError(503, 'linker_unavailable',
            'The account that linked this table has no working Nextcloud connection — ask an owner to re-link it.');
    }
    if (!auth || !auth.baseUrl || typeof auth.fetch !== 'function') {
        throw new SpreadsheetSourceError(503, 'linker_unavailable',
            auth && auth.authError ? auth.authError : 'The account that linked this table has no working Nextcloud connection.');
    }
    return { api: mod.forLinker(auth, ctx), userId, session, cred: auth };
}

async function assertScope(d, toolName, source, userId, orgId) {
    const path = source.file && source.file.path;
    const denial = await d.checkToolCall({ toolName, toolArgs: { path }, userId, orgId });
    if (denial) {
        throw new SpreadsheetSourceError(403, 'nc_scope_denied',
            toolName === 'nextcloud_upload_file'
                ? 'The account that linked this table no longer shares this folder for writing with Bee Flow — ask an owner to re-link it.'
                : 'The account that linked this table no longer shares this file with Bee Flow — ask an owner to re-link it.',
            // The ref's id is the wire id (the path, on Nextcloud) — what a client keys on.
            { ref: { provider: source.provider, fileId: path || null, path } });
    }
}

/**
 * The write gate, run before EVERY write (not memoised: the guard's own
 * scope cache makes it cheap, and a scope narrowed a minute ago must bite
 * now). Only Nextcloud has a per-path write policy; Google and Microsoft
 * answer with their own 403 at write time.
 */
async function assertWritable(source, linker, orgId) {
    if (!source || source.provider !== 'nextcloud_files') return;
    const d = deps();
    await assertScope(d, 'nextcloud_upload_file', source, linker.userId, orgForScope(orgId, linker.session));
}

/** Test/relink hook: forget a linker's memo — and their credential memo. */
function forget(userId) {
    for (const k of _memo.keys()) if (k.startsWith(`${userId}|`)) _memo.delete(k);
    try { require('./credentials').forget(userId); } catch (_) { /* pure module — cannot fail */ }
}

module.exports = { resolveLinker, assertWritable, forget, _memo, MEMO_TTL_MS };
