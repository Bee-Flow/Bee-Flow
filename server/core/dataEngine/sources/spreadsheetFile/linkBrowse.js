const datatableStore = require('../../../../stores/datatableStore');
const { SpreadsheetSourceError, providerName } = require('./errors');
const reading = require('./reading');
const { KIND, PROVIDERS } = require('./index');
const { integrationClient } = require('../../../integrations/integrationClients');

/** Folder crumbs on Drive/OneDrive are probed upwards; a tree deeper than this shows its last levels. */
const MAX_CRUMB_DEPTH = 8;

function deps() {
    // Lazily required: the pure modules beside this one must stay loadable in
    // suites that stub the database, and these pull in stores at load time.
    return {
        providers: require('./providers'),
        credentials: require('./credentials'),
        // Injected by integrations/ (core/integrations/integrationClients.js); a getter,
        // so only a call that uses it needs the registration.
        get ncClient() { return integrationClient('nextcloud'); },
        isIntegrationPermittedForUser: require('../../../integrations/integrationTools').isIntegrationPermittedForUser,
        userStore: require('../../../../stores/userStore'),
    };
}

function rejected(status, code, message, extra) {
    return new SpreadsheetSourceError(status, code, message, extra);
}

function assertProvider(provider) {
    if (!PROVIDERS.includes(provider)) {
        throw rejected(400, 'spreadsheet_rejected', `Say which storage to use (${PROVIDERS.join(', ')}).`);
    }
}

/**
 * The caller's own storage client, after the gates. Throws the
 * SpreadsheetSourceError the route answers with.
 */
async function callerApi(session, principal, provider) {
    assertProvider(provider);
    const d = deps();
    let mod;
    try {
        mod = d.providers.providerFor(provider);
    } catch (e) {
        if (e && e.code === 'unknown_provider') throw rejected(422, 'spreadsheet_rejected', `${providerName(provider)} is not available on this server.`);
        throw e;
    }
    const userId = principal && principal.userId;
    const orgId = (principal && principal.orgId) || null;
    if (!userId) throw rejected(403, 'provider_not_connected', 'Sign in to link a spreadsheet.');
    const permitted = await d.isIntegrationPermittedForUser({ userId, appId: mod.integrationAppIds[0], session, isAdmin: !!(session && session.isAdmin) });
    if (!permitted) {
        throw rejected(403, 'provider_integration_off', `${providerName(provider)} is switched off for this account.`);
    }
    const ctx = { userId, orgId, session };
    if (provider === 'nextcloud_files') {
        let auth = null;
        try { auth = await d.ncClient.resolveAuth(session, userId); } catch (_) { auth = null; }
        if (!auth || !auth.baseUrl || typeof auth.fetch !== 'function') {
            throw rejected(403, 'provider_not_connected', (auth && auth.authError) || 'This account is not connected to Nextcloud.');
        }
        return { api: mod.forCaller(auth, ctx), mod, d, ctx };
    }
    const cred = await d.credentials.resolveProviderCredential(userId, mod.oauthProvider, { session, orgId });
    return { api: mod.forCaller(cred, ctx), mod, d, ctx };
}

/** Which mirrors in `scope` already copy a sheet of which file: fileKey → [{ datatableId, sheet }]. */
async function linkedIn(scope) {
    const out = new Map();
    if (!scope) return out;
    const mirrors = await datatableStore.listSourceMirrorsInScope(scope, { kind: KIND });
    for (const m of mirrors) {
        const src = m.source || {};
        const key = reading.fileKeyOf(src.provider, src.file);
        const list = out.get(key) || [];
        list.push({ datatableId: m.id, sheet: (src.sheet && src.sheet.name) || null });
        out.set(key, list);
    }
    return out;
}

function truthy(v) {
    return v === true || v === 'true' || v === '1' || v === 1;
}

/** A FileRef → the browser's item. */
function toItem(ref, linked) {
    const item = {
        id: reading.wireIdOf(ref),
        name: ref.name || '',
        kind: ref.isFolder ? 'folder' : 'file',
    };
    if (!ref.isFolder && ref.format) item.format = ref.format;
    if (ref.size != null) item.size = ref.size;
    if (ref.modifiedAt) item.modifiedAt = ref.modifiedAt;
    if (ref.webUrl) item.webUrl = ref.webUrl;
    if (ref.path) item.path = ref.path;
    if (ref.owned !== undefined) item.owned = !!ref.owned;
    if (ref.driveId) item.driveId = ref.driveId;
    if (!ref.isFolder) item.linkedAs = linked.get(reading.fileKeyOf(ref.provider, { id: ref.fileId, path: ref.path })) || [];
    return item;
}

/**
 * One folder of one storage: sub-folders and spreadsheet files, with which
 * mirrors in `scope` already copy a sheet of each. `folderId` is `'root'`,
 * `'shared'` (Drive/OneDrive shared-with-me; Nextcloud has none) or the
 * storage's own id — on Nextcloud the id IS the path.
 */
async function browse(session, principal, scope, { provider, folderId = null, q = null, shared = null, pageToken = null } = {}) {
    assertProvider(provider);
    const term = typeof q === 'string' ? q.trim() : '';
    const id = folderId === undefined || folderId === null || folderId === '' ? 'root' : String(folderId);
    const wantShared = id === 'shared' || (id === 'root' && truthy(shared));
    if (wantShared && !term && provider === 'nextcloud_files') {
        throw rejected(400, 'no_shared_root', 'Nextcloud has no "shared with me" folder — shared folders appear among your files.');
    }
    const ctx = await callerApi(session, principal, provider);
    let view = 'mine';
    let parentId = null;
    let path = '/';
    if (term) {
        view = 'search';
    } else if (wantShared) {
        view = 'shared';
    } else if (id !== 'root') {
        if (provider === 'nextcloud_files') {
            path = id.startsWith('/') ? id : `/${id}`;
        } else if (provider === 'onedrive') {
            const ref = reading.fileRefOf(provider, { fileId: id });
            parentId = ref.driveId ? { id: ref.fileId, driveId: ref.driveId } : ref.fileId;
        } else {
            parentId = id;
        }
    }
    const res = await ctx.api.list({ view, parentId, path, q: term || null, pageToken: pageToken || null });
    const linked = await linkedIn(scope);
    const items = (res.items || []).map(ref => toItem(ref, linked));
    let folder;
    if (view === 'shared') {
        folder = { id: 'shared', name: 'Shared with me', path: [] };
    } else if (id === 'root' || view === 'search') {
        folder = { id: 'root', name: '', path: [] };
    } else if (provider === 'nextcloud_files') {
        folder = { id, name: path.split('/').pop() || '', path: crumbs(path) };
    } else {
        const trail = await folderTrail(ctx, provider, typeof parentId === 'object' ? parentId : { id: parentId, driveId: null });
        folder = { id, name: trail.length ? trail[trail.length - 1].name : '', path: trail };
    }
    return { provider, folder, items, nextPageToken: res.nextPageToken || null };
}

/** `/Documents/Q3` → [{ id:'/Documents', name:'Documents' }, { id:'/Documents/Q3', name:'Q3' }]. */
function crumbs(path) {
    const parts = String(path || '').split('/').filter(Boolean);
    const out = [];
    let acc = '';
    for (const p of parts) { acc += `/${p}`; out.push({ id: acc, name: p }); }
    return out;
}

/**
 * The crumbs of a Drive/OneDrive folder — [{ id, name }] from the top down.
 * Neither storage names a folder in its children listing, so the folder is
 * probed, then its parent, and so on up to the drive's root (the item with
 * no parent of its own — the client calls that one "All files" and it is
 * not a crumb). A probe that fails (an ancestor of a shared folder the
 * account cannot see) ends the trail where it is; the folder that was
 * opened is always the first probe, so at worst the trail is that folder
 * alone. Every crumb has a name, and its id is the browser's own (a foreign
 * OneDrive folder keeps its `drive|item` spelling).
 */
async function folderTrail(ctx, provider, first) {
    const up = [];
    const seen = new Set();
    let cur = first && first.id ? { fileId: String(first.id), driveId: first.driveId || null } : null;
    for (let depth = 0; cur && depth < MAX_CRUMB_DEPTH; depth += 1) {
        const key = `${cur.driveId || ''}|${cur.fileId}`;
        if (seen.has(key)) break;
        seen.add(key);
        let p = null;
        try { p = await ctx.api.probe({ provider, fileId: cur.fileId, driveId: cur.driveId }); } catch (_) { break; }
        const file = (p && p.file) || {};
        const parentId = file.parentId || null;
        // An ancestor without a parent is the drive root, not a crumb.
        if (depth > 0 && !parentId) break;
        const name = String(p.name || file.name || '').trim();
        if (!name) break;
        up.push({ id: reading.wireIdOf({ ...file, provider, fileId: file.fileId || cur.fileId, driveId: file.driveId || cur.driveId }), name });
        cur = parentId ? { fileId: String(parentId), driveId: file.driveId || cur.driveId || null } : null;
    }
    return up.reverse();
}

module.exports = { MAX_CRUMB_DEPTH, deps, rejected, assertProvider, callerApi, linkedIn, browse };
