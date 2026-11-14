// @typecheck strict
/**
 * Knowledge Bases, cloud folders: what the folder picker and the create route
 * ask of a person's own storage.
 *
 * Three storages (Nextcloud Files, OneDrive, Google Drive) behind the spreadsheet
 * mirror's provider layer, in its documents mode (core/dataEngine/sources/
 * spreadsheetFile/providers/documents.js): folders plus every file the text
 * extractor reads. Everything here runs with the CALLER'S session, the same gates
 * the agent tools pass (integration switched on, storage connected, Nextcloud
 * folder scope); the background refresh later runs as the same person (core/kb/
 * sources/cloudFolder.mts).
 *
 * Errors leave as HttpError with three codes a client can act on:
 *   cloud_not_connected      the storage is not connected (or is switched off) for this account
 *   cloud_folder_unreadable  the folder cannot be listed: gone, not a folder, refused
 *   cloud_folder_out_of_scope  a Nextcloud folder outside the folders shared with Bee Flow
 * Anything the storage itself failed at answers 502 cloud_unavailable.
 */

const { HttpError } = require('../../core/http/errors');

const PROVIDERS = Object.freeze(['nextcloud_files', 'onedrive', 'google_drive']);
const ACCEPT = 'documents';

/**
 * @typedef {{ userId?: string | null, orgId?: string | null }} Principal
 * The slice of a storage client this module uses: a listing, in the picker's words.
 * @typedef {{ list: (opts: object) => Promise<{ items?: Array<Record<string, unknown>>, nextPageToken?: string | null }> }} ListApi
 * @typedef {{
 *   callerApi: (session: unknown, principal: Principal, provider: string, opts: { accept: string }) => Promise<{ api: ListApi }>,
 *   providerFor: (provider: string) => { integrationAppIds: string[], isConnected: (opts: { userId?: string | null, session?: unknown }) => Promise<{ connected: boolean, reason?: string | null }> },
 *   isIntegrationPermittedForUser: (opts: { userId?: string | null, appId: string, session: Partial<Express.Session> | null, isAdmin: boolean }) => Promise<boolean>,
 *   resolvePrincipal: (req: import('express').Request) => Promise<Principal>,
 *   checkToolCall: (call: { toolName: string, toolArgs: object, userId?: string | null, orgId?: string | null }) => Promise<object | null>,
 *   friendlyError: (e: unknown, provider: string) => Error,
 * }} CloudDeps
 */

/**
 * The pieces this module reaches for, replaceable in a test. The provider layer is JavaScript
 * with looser types than the slice used here, hence the casts through `unknown`.
 * @returns {CloudDeps}
 */
function defaultDeps() {
    return {
        callerApi: (session, principal, provider, opts) => /** @type {Promise<{ api: ListApi }>} */ (/** @type {unknown} */ (
            require('../../core/dataEngine/sources/spreadsheetFile/linkBrowse').callerApi(session, principal, provider, opts))),
        providerFor: (provider) => /** @type {ReturnType<CloudDeps['providerFor']>} */ (/** @type {unknown} */ (
            require('../../core/dataEngine/sources/spreadsheetFile/providers').providerFor(provider))),
        isIntegrationPermittedForUser: (opts) => require('../../core/integrations/integrationTools').isIntegrationPermittedForUser(opts),
        resolvePrincipal: (req) => require('../../auth/datatableAccess').resolveDatatablePrincipal(req),
        checkToolCall: (call) => require('../../core/integrations/ncScopeGuard').checkToolCall(call),
        friendlyError: (e, provider) => require('../../core/kb/sources/cloudFolder.mts').friendlyError(e, provider),
    };
}

/**
 * A refusal from the provider layer as the HttpError a client reads.
 * @param {unknown} e
 * @param {string} provider
 * @param {CloudDeps} deps
 */
function toHttpError(e, provider, deps) {
    if (e instanceof HttpError) return e;
    const err = /** @type {{ code?: string }} */ (deps.friendlyError(e, provider));
    const message = /** @type {Error} */ (err).message;
    switch (err.code) {
        case 'provider_not_connected':
        case 'provider_integration_off':
        case 'linker_unavailable':
            return new HttpError(400, 'cloud_not_connected', message);
        case 'nc_scope_denied':
            return new HttpError(403, 'cloud_folder_out_of_scope', message);
        case 'spreadsheet_unavailable':
            return new HttpError(502, 'cloud_unavailable', message);
        default:
            return new HttpError(400, 'cloud_folder_unreadable', message);
    }
}

/**
 * Which storages this account could read folders from. Cheap: a vault row, the
 * session's provider, the Nextcloud binding; never a call to the storage.
 * @param {import('express').Request} req
 * @param {CloudDeps} [deps]
 * @returns {Promise<Array<{ provider: string, connected: boolean, reason: string | null }>>}
 */
async function providerStatuses(req, deps = defaultDeps()) {
    const principal = await deps.resolvePrincipal(req);
    const userId = principal && principal.userId;
    const session = req.session || null;
    /** @type {Array<{ provider: string, connected: boolean, reason: string | null }>} */
    const out = [];
    for (const provider of PROVIDERS) {
        /** @type {{ connected: boolean, reason: string | null }} */
        let status = { connected: false, reason: 'not_connected' };
        try {
            const mod = deps.providerFor(provider);
            const found = await mod.isConnected({ userId, session });
            if (found && found.connected) {
                const permitted = await deps.isIntegrationPermittedForUser({
                    userId, appId: mod.integrationAppIds[0], session, isAdmin: !!(session && /** @type {{ isAdmin?: boolean }} */ (session).isAdmin),
                }).catch(() => false);
                status = permitted ? { connected: true, reason: null } : { connected: false, reason: 'integration_off' };
            } else {
                status = { connected: false, reason: (found && found.reason) || 'not_connected' };
            }
        } catch {
            status = { connected: false, reason: 'unavailable' };
        }
        out.push({ provider, ...status });
    }
    return out;
}

/**
 * A listing entry in the shape the picker reads.
 * @param {Record<string, unknown>} ref
 */
function toPickerItem(ref) {
    return {
        provider: ref.provider,
        fileId: ref.fileId != null ? String(ref.fileId) : null,
        driveId: ref.driveId || null,
        path: ref.path || null,
        name: ref.name || '',
        mimeType: ref.mimeType || null,
        isFolder: !!ref.isFolder,
        size: ref.size != null ? Number(ref.size) : null,
        modifiedAt: ref.modifiedAt || null,
        webUrl: ref.webUrl || null,
    };
}

/**
 * How the provider is asked for the children of a folder, from the picker's words.
 * @param {{ provider: string, parentId?: string, path?: string, driveId?: string }} q
 */
function parentFor(q) {
    if (q.provider === 'nextcloud_files') return { path: q.path || q.parentId || '/' };
    if (q.provider === 'onedrive') {
        return { parentId: q.parentId ? (q.driveId ? { id: q.parentId, driveId: q.driveId } : q.parentId) : null };
    }
    return { parentId: q.parentId || null };
}

/**
 * One level of one storage: sub-folders and readable documents.
 * @param {import('express').Request} req
 * @param {{ provider: string, parentId?: string, path?: string, driveId?: string, pageToken?: string, q?: string }} q
 * @param {CloudDeps} [deps]
 */
async function browse(req, q, deps = defaultDeps()) {
    try {
        const principal = await deps.resolvePrincipal(req);
        const api = /** @type {ListApi} */ ((await deps.callerApi(req.session, principal, q.provider, { accept: ACCEPT })).api);
        const term = (q.q || '').trim();
        const res = await api.list({
            view: term ? 'search' : 'mine',
            q: term || null,
            pageToken: q.pageToken || null,
            ...(term ? {} : parentFor(q)),
        });
        return { items: (res.items || []).map(toPickerItem), nextPageToken: res.nextPageToken || null };
    } catch (e) {
        throw toHttpError(e, q.provider, deps);
    }
}

/**
 * Create-time check of a folder: the storage is connected for this person, they can list the
 * folder themselves, and a Nextcloud folder is inside what they shared with Bee Flow.
 * Resolves with the organisation the check ran in.
 * @param {import('express').Request} req
 * @param {{ provider: string, folderId?: string, driveId?: string, path?: string }} cfg
 * @param {{ organization_id?: string | null }} kb
 * @param {CloudDeps} [deps]
 * @returns {Promise<{ orgId: string | null }>}
 */
async function openCloudFolder(req, cfg, kb, deps = defaultDeps()) {
    const principal = await deps.resolvePrincipal(req);
    const orgId = (principal && principal.orgId) || kb.organization_id || null;
    if (cfg.provider === 'nextcloud_files') {
        const denial = await deps.checkToolCall({
            toolName: 'nextcloud_read_file', toolArgs: { path: cfg.path }, userId: principal && principal.userId, orgId,
        });
        if (denial) {
            throw new HttpError(403, 'cloud_folder_out_of_scope', 'That folder is not one of the Nextcloud folders you have shared with Bee Flow.');
        }
    }
    /** @type {ListApi} */
    let api;
    try {
        api = /** @type {ListApi} */ ((await deps.callerApi(req.session, principal, cfg.provider, { accept: ACCEPT })).api);
    } catch (e) {
        throw toHttpError(e, cfg.provider, deps);
    }
    try {
        await api.list({ view: 'mine', ...parentFor({ provider: cfg.provider, parentId: cfg.folderId, path: cfg.path, driveId: cfg.driveId }) });
    } catch (e) {
        throw toHttpError(e, cfg.provider, deps);
    }
    return { orgId };
}

module.exports = { PROVIDERS, providerStatuses, browse, openCloudFolder, toHttpError, toPickerItem, parentFor };
