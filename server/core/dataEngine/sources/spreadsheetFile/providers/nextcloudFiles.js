// @typecheck noImplicitAny
/**
 * Nextcloud Files (WebDAV) as a spreadsheet-mirror storage.
 *
 * The "credential" here is what integrations/nextcloudClient.resolveAuth
 * hands out — { baseUrl, uid, fetch } routed through the ExApp connector, an
 * OAuth bearer, or an app password; this module never sees which. Files are
 * addressed by PATH (what the user's per-folder scope is defined on — the
 * fileId-indirect tools are denied under a 'selected' scope), and the
 * oc:fileid rides along as identity only.
 *
 * Every call runs under the SAME guard the Nextcloud file tools run under:
 * browsing is `nextcloud_list_files` (a 'selected' scope trims the listing
 * to ancestors + subtree), search is `nextcloud_search_files` (filtered to
 * the selection), reading a file is `nextcloud_read_file` and writing one is
 * `nextcloud_upload_file` — both path policies, checked before any fetch, so
 * a denial never reaches Nextcloud.
 *
 * The deep link (`webUrl`, the "Open in Nextcloud" affordance) is built from
 * the org's PUBLIC Nextcloud URL — never from `auth.baseUrl`: in connector
 * mode that is the ExApp proxy route (`…/index.php/apps/app_api/proxy/…/nc`),
 * which forwards nothing but the API prefixes, so a link under it 404s. A
 * bearer or app-password auth's baseUrl IS the public URL. When no public
 * URL is known the link is null and the card renders a plain name.
 *
 * The change marker is the WebDAV etag (PROPFIND Depth 0 with d:getetag);
 * a write is a PUT with `If-Match: <etag>` — Sabre answers 412 when the file
 * moved (→ spreadsheet_conflict), 423 while Nextcloud Office holds an edit
 * lock (→ spreadsheet_locked). The Buffer body satisfies ncSigning's
 * hashableBody on the connector hop. No cell API, no ensureParentFolders:
 * the file exists or the mirror is wrong. No SEARCH-by-fileid resolver in
 * v1 — a 404 on the path is spreadsheet_not_found and the owner re-points.
 */

'use strict';

const { SpreadsheetSourceError, fromHttp } = require('../errors');
const { formatOf, isSpreadsheetName } = require('./index');

/** @typedef {import('./index').FileRef} FileRef */
/**
 * A webdav.parsePropfind entry (integrations/nextcloudFiles/webdav.js).
 * @typedef {{ name?: string, path: string, type?: string, size?: number, contentType?: string|null, modified?: string|null,
 *             fileId?: string|number|null, etag?: string|null, permissions?: string|null, ownerId?: string|null }} NcEntry
 */
/** @typedef {{ etag: string|null, modified: string|null, size: number|null, fileId: string|null }} NcMarker */
/**
 * The context makeApi builds (see "The FileApi's operations").
 * @typedef {{ d: ReturnType<typeof deps>, auth: NcAuth, baseUrl: string, uid: string, root: string,
 *             guardCtx: { userId: string, session: object|null, orgId: string|null },
 *             linkBase: () => Promise<string|null>,
 *             propfind: (path: string, depth: string) => Promise<Response>,
 *             assertScope: (toolName: string, path: string, file?: { path?: string|null }) => Promise<void>,
 *             stat: (file: FileRef) => Promise<NcEntry>,
 *             probe: (file: FileRef) => Promise<{ marker: NcMarker, name: string, size: number|null, mimeType: string|null, format: string|null, path: string, webUrl: string|null, owned: boolean, writable: boolean, file: FileRef }> }} NcCtx
 */
/** @typedef {{ baseUrl: string, uid: string, fetch: (url: string, init?: object) => Promise<Response>, authError?: string, session?: { connectorOrgId?: string, user?: { organizationId?: string } }, mode?: string, publicBaseUrl?: string }} NcAuth */

const provider = 'nextcloud_files';
const oauthProvider = 'nextcloud';
const integrationAppIds = ['nextcloud'];

const DOWNLOAD_TIMEOUT_MS = 60_000;
const SEARCH_LIMIT = 50;

const { integrationClient } = require('../../../../integrations/integrationClients');
const { fallback } = require('../../../../../utils/bestEffort');

function deps() {
    return {
        // Injected by integrations/ (core/integrations/integrationClients.js); getters,
        // so only a call that uses one needs the registration.
        get webdav() { return integrationClient('nextcloudWebdav'); },
        get ncClient() { return integrationClient('nextcloud'); },
        guard: require('../../../../integrations/ncScopeGuard'),
        officegen: require('../../../../documents/office/officegen'),
    };
}

// ─── Small helpers ──────────────────────────────────────────────────────

/**
 * @param {string} p
 */
function normalizePath(p) {
    const s = ('/' + String(p || '')).replace(/\/+/g, '/').replace(/\/+$/, '');
    return s || '/';
}

/**
 * The ref a refusal carries. On Nextcloud the wire id IS the path (what the browser hands out and a wizard keys on).
 * @param {{ path?: string|null }} file
 */
function refOf(file) {
    const path = file && file.path || null;
    return { provider, fileId: path, path };
}

/**
 * RFC 1123 (getlastmodified) → ISO, or null when unparsable.
 * @param {string | number | Date} rfc
 */
function isoOf(rfc) {
    if (!rfc) return null;
    const d = new Date(rfc);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * @param {NcEntry} entry
 * @returns {NcMarker}
 */
function markerOf(entry) {
    return {
        etag: entry.etag || null,
        modified: isoOf(entry.modified),
        size: entry.size != null && !Number.isNaN(entry.size) ? Number(entry.size) : null,
        fileId: entry.fileId != null ? String(entry.fileId) : null,
    };
}

/**
 * @param {{ etag?: string|null }} a
 * @param {{ etag?: string|null }} b
 */
function markerEquals(a, b) {
    return !!a && !!b && a.etag != null && a.etag === b.etag;
}

/**
 * A parsePropfind entry → FileRef. Non-spreadsheet files are dropped. `linkBase` is the public URL (null = no deep link).
 * @param {NcEntry} entry
 * @param {{ baseUrl: string, uid: string, linkBase?: string|null }} opts
 */
function toFileRef(entry, { baseUrl, uid, linkBase = baseUrl }) {
    if (!entry) return null;
    const isFolder = entry.type === 'folder';
    const format = isFolder ? null : formatOf({ name: entry.name, mimeType: entry.contentType });
    if (!isFolder && !format) return null;
    const path = normalizePath(entry.path);
    const parent = path.slice(0, path.lastIndexOf('/')) || '/';
    return {
        provider,
        fileId: entry.fileId != null ? String(entry.fileId) : null,
        driveId: /** @type {string|null} */ (null),
        path,
        name: entry.name || path.split('/').pop() || '',
        mimeType: entry.contentType || null,
        format,
        size: isFolder || entry.size == null ? null : Number(entry.size),
        modifiedAt: isoOf(entry.modified),
        etag: entry.etag || null,
        webUrl: linkBase && entry.fileId != null ? `${linkBase}/f/${entry.fileId}` : null,
        parentId: parent,
        isFolder,
        owned: !!entry.ownerId && entry.ownerId === uid,
        // Nextcloud's permission string carries a W when the file may be
        // written (a folder says C/K: files may be created in it).
        writable: entry.permissions == null ? true : (isFolder ? /[CK]/ : /W/).test(entry.permissions),
    };
}

/**
 * @param {{ path?: string|null }} source
 * @param {string} verb
 */
function scopeDenied(source, verb) {
    return new SpreadsheetSourceError(403, 'nc_scope_denied',
        verb === 'write'
            ? 'This folder is not shared for writing with Bee Flow by the account that linked this table.'
            : 'This file is not shared with Bee Flow by the account that linked this table.',
        { ref: refOf(source) });
}

// ─── The FileApi's operations ───────────────────────────────────────────
//
// They take the context `n` makeApi builds:
//   { d, auth, baseUrl, uid, root, guardCtx, linkBase(), propfind(), assertScope(), stat(), probe() }

/**
 * One folder, listed whole through the scope guard (WebDAV has no pages).
 * @param {NcCtx} n
 * @param {{ view?: string, path?: string, parentId?: string|null, q?: string|null, pageToken?: string|null }} [opts]
 */
async function listFolder(n, { view = 'mine', path = '/', parentId = null, q = null, pageToken = null } = {}) {
    void pageToken;   // WebDAV lists a folder whole
    if (view === 'shared') {
        throw new SpreadsheetSourceError(400, 'no_shared_root', 'Nextcloud has no "shared with me" root — shared folders appear in your files.');
    }
    if (view === 'search') {
        return searchFiles(n, q);
    }
    const folder = normalizePath(parentId || path);
    const answer = await n.d.guard.guardedNcCall('nextcloud_list_files', { path: folder }, n.guardCtx, async () => {
        const res = await n.propfind(folder, '1');
        if (res.status === 404) throw new SpreadsheetSourceError(404, 'spreadsheet_not_found', `Nextcloud has no folder ${folder}.`, { ref: { provider, path: folder } });
        if (!res.ok) throw fromHttp(provider, res.status, await res.text().catch(() => ''), 'folder', { ref: { provider, path: folder } });
        const all = n.d.webdav.parsePropfind(await res.text(), n.baseUrl, n.uid);
        // The first entry is the folder itself — the same shape as the
        // list tool, so the guard's filter finds `items` and each `path`.
        const items = all.filter((/** @type {NcEntry} */ e) => normalizePath(e.path) !== folder);
        return { path: folder, count: items.length, items };
    });
    if (answer && answer.error) {
        if (answer.nc_scope_denied) throw scopeDenied({ path: folder }, 'read');
        throw new SpreadsheetSourceError(503, 'spreadsheet_unavailable', String(answer.error).slice(0, 200), { ref: { provider, path: folder } });
    }
    const base = await n.linkBase();
    const items = (answer.items || []).map((/** @type {NcEntry} */ e) => toFileRef(e, { baseUrl: n.baseUrl, uid: n.uid, linkBase: base })).filter(Boolean);
    items.sort((/** @type {FileRef} */ a, /** @type {FileRef} */ b) => (a.isFolder === b.isFolder ? a.name.localeCompare(b.name) : (a.isFolder ? -1 : 1)));
    return { items, nextPageToken: null };
}

/**
 * The files search provider, through the scope guard; spreadsheets only.
 * @param {NcCtx} n
 * @param {string|null} q
 */
async function searchFiles(n, q) {
    const term = String(q || '').trim();
    if (!term) return { items: [], nextPageToken: null };
    const answer = await n.d.guard.guardedNcCall('nextcloud_search_files', { query: term }, n.guardCtx, async () => {
        const url = `${n.baseUrl}/ocs/v2.php/search/providers/files/search?term=${encodeURIComponent(term)}&limit=${SEARCH_LIMIT}&format=json`;
        const res = await n.auth.fetch(url, { headers: { 'OCS-APIRequest': 'true', 'Accept': 'application/json' } });
        if (!res.ok) throw fromHttp(provider, res.status, await res.text().catch(() => ''), 'search');
        const data = /** @type {{ ocs?: { data?: { entries?: Array<{ title?: string, attributes?: { path?: string, fileId?: string|number } }> } } }|null} */ (await res.json().catch(/** @returns {null} */ () => null));
        const entries = (data && data.ocs && data.ocs.data && data.ocs.data.entries) || [];
        const items = entries.map((/** @type {{ title?: string, attributes?: { path?: string, fileId?: string|number } }} */ e) => ({
            name: e.title || '',
            path: (e.attributes && e.attributes.path) || null,
            fileId: (e.attributes && e.attributes.fileId) || null,
        })).filter((/** @type {{ name: string, path: string|null }} */ e) => e.path && isSpreadsheetName(e.name));
        return { query: term, count: items.length, items };
    });
    if (answer && answer.error) {
        if (answer.nc_scope_denied) throw scopeDenied({ path: '/' }, 'read');
        throw new SpreadsheetSourceError(503, 'spreadsheet_unavailable', String(answer.error).slice(0, 200));
    }
    const base = await n.linkBase();
    const items = (answer.items || []).map((/** @type {{ name: string, path: string, fileId: string|number|null }} */ e) => {
        const path = normalizePath(e.path);
        return {
            provider, fileId: e.fileId != null ? String(e.fileId) : null, driveId: /** @type {string|null} */ (null), path,
            name: e.name || path.split('/').pop(), mimeType: /** @type {string|null} */ (null), format: formatOf({ name: e.name }),
            size: /** @type {number|null} */ (null), modifiedAt: /** @type {string|null} */ (null), etag: /** @type {string|null} */ (null),
            webUrl: base && e.fileId != null ? `${base}/f/${e.fileId}` : null,
            parentId: path.slice(0, path.lastIndexOf('/')) || '/', isFolder: false, owned: false,
        };
    });
    return { items, nextPageToken: /** @type {string|null} */ (null) };
}

/**
 * @param {NcCtx} n
 * @param {FileRef} file
 * @param {{ maxBytes?: number|null }} [opts]
 */
async function downloadFile(n, file, { maxBytes = null } = {}) {
    const p = await n.probe(file);
    if (maxBytes && p.size != null && p.size > maxBytes) {
        throw new SpreadsheetSourceError(413, 'spreadsheet_too_large', `"${p.name}" is ${Math.round(p.size / 1048576)} MB; the limit is ${Math.round(maxBytes / 1048576)} MB.`, { ref: refOf(file) });
    }
    /** @type {Response} */
    let res;
    try {
        res = await n.auth.fetch(n.d.webdav.joinDavPath(n.root, p.path), { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    } catch (e) {
        throw new SpreadsheetSourceError(503, 'spreadsheet_unavailable', `Nextcloud did not deliver the file (${e && /** @type {Error} */ (e).name === 'TimeoutError' ? 'timeout' : 'network error'}).`, { ref: refOf(file) });
    }
    if (res.status === 404) throw new SpreadsheetSourceError(404, 'spreadsheet_not_found', `Nextcloud no longer has ${p.path}.`, { ref: refOf(file) });
    if (!res.ok) throw fromHttp(provider, res.status, await res.text().catch(() => ''), 'file', { ref: refOf(file) });
    const buffer = Buffer.from(await res.arrayBuffer());
    if (maxBytes && buffer.length > maxBytes) {
        throw new SpreadsheetSourceError(413, 'spreadsheet_too_large', `"${p.name}" is larger than ${Math.round(maxBytes / 1048576)} MB.`, { ref: refOf(file) });
    }
    return { buffer, marker: p.marker };
}

/**
 * PUT the new bytes over the file, guarded by `If-Match: <etag>`. The
 * new etag comes from the response header; Nextcloud omits it on some
 * paths (the connector hop, older Sabre), then one PROPFIND fetches it.
 * @param {NcCtx} n
 * @param {FileRef} file
 * @param {Buffer} buffer
 * @param {{ ifMatch?: Partial<NcMarker>|null, contentType?: string|null }} [opts]
 */
async function uploadFile(n, file, buffer, { ifMatch = null, contentType = null } = {}) {
    const path = normalizePath(file && file.path);
    if (!file || !file.path) throw new SpreadsheetSourceError(422, 'spreadsheet_rejected', 'A Nextcloud file needs a path.');
    await n.assertScope('nextcloud_upload_file', path, file);
    const format = file.format || formatOf({ name: file.name || path });
    /** @type {Record<string, string>} */
    const headers = {
        'Content-Type': contentType || /** @type {Record<string, string>} */ (n.d.officegen.CONTENT_TYPES)[format] || 'application/octet-stream',
        'OC-Total-Length': String(buffer.length),
    };
    if (ifMatch && ifMatch.etag) headers['If-Match'] = ifMatch.etag;
    /** @type {Response} */
    let res;
    try {
        res = await n.auth.fetch(n.d.webdav.joinDavPath(n.root, path), {
            method: 'PUT', headers, body: buffer, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        });
    } catch (e) {
        throw new SpreadsheetSourceError(503, 'spreadsheet_unavailable', `Nextcloud did not take the upload (${e && /** @type {Error} */ (e).name === 'TimeoutError' ? 'timeout' : 'network error'}).`, { ref: refOf(file) });
    }
    if (!res.ok && res.status !== 201 && res.status !== 204) {
        throw fromHttp(provider, res.status, await res.text().catch(() => ''), 'file', { ref: refOf(file) });
    }
    const etag = (res.headers && (res.headers.get('oc-etag') || res.headers.get('etag'))) || null;
    if (etag) {
        return { marker: { etag, modified: new Date().toISOString(), size: buffer.length, fileId: (ifMatch && ifMatch.fileId) || file.fileId || null } };
    }
    return { marker: markerOf(await n.stat(file)) };
}

// ─── The FileApi ────────────────────────────────────────────────────────

/**
 * @param {NcAuth} auth  resolveAuth's answer
 * @param {{ userId?: string, session?: { connectorOrgId?: string, user?: { organizationId?: string } }, orgId?: string }} [ctx]   who the scope guard asks about
 */
function makeApi(auth, ctx = {}) {
    const d = deps();
    const baseUrl = auth.baseUrl;
    const uid = auth.uid;
    const root = d.ncClient.webdavRoot(baseUrl, uid);
    const guardCtx = { userId: ctx.userId, session: ctx.session || auth.session || null, orgId: ctx.orgId || null };
    const scopeOrg = () => guardCtx.orgId || (guardCtx.session && (guardCtx.session.connectorOrgId || (guardCtx.session.user && guardCtx.session.user.organizationId))) || null;

    // The base of every deep link (see the header). Resolved once per api:
    // an explicit `auth.publicBaseUrl` wins; a proxied (connector) auth
    // looks the org's public URL up — the same `nc_base_url` the Tables
    // mirror ships as its `ncUrl` — and ships null when there is none; any
    // other auth's baseUrl is the public URL already.
    const proxied = auth.mode === 'connector' || /\/apps\/app_api\/proxy\//.test(String(baseUrl || ''));
    /**
     * @param {string} u
     */
    const trim = (u) => (u ? String(u).replace(/\/+$/, '') : null);
    /** @type {Promise<string | null>} */
    let linkBasePromise = null;
    function linkBase() {
        if (!linkBasePromise) {
            linkBasePromise = (async () => {
                if (auth.publicBaseUrl) return trim(auth.publicBaseUrl);
                if (!proxied) return trim(baseUrl);
                const orgId = scopeOrg();
                if (!orgId) return null;
                const org = await require('../../../../../stores/userStore').getOrganization(orgId);
                return trim(org && (org.nc_base_url || org.ncBaseUrl));
            })().catch((e) => fallback('core/dataEngine/sources/spreadsheetFile/providers/nextcloudFiles:linkBase', e, null));
        }
        return linkBasePromise;
    }

    /**
     * @param {string} toolName
     * @param {string} path
     * @param {{ path?: string|null }} [file]
     */
    async function assertScope(toolName, path, file) {
        if (!guardCtx.userId) return;   // no principal → nothing to gate on (a test double)
        const denial = await d.guard.checkToolCall({ toolName, toolArgs: { path }, userId: guardCtx.userId, orgId: scopeOrg() });
        if (denial) throw scopeDenied(file || { path }, toolName === 'nextcloud_upload_file' ? 'write' : 'read');
    }

    /**
     * @param {string} path
     * @param {string} depth
     */
    async function propfind(path, depth) {
        const dav = d.webdav.joinDavPath(root, path);
        const url = depth === '1' ? (dav.endsWith('/') ? dav : `${dav}/`) : dav;
        return auth.fetch(url, {
            method: 'PROPFIND',
            headers: { 'Depth': depth, 'Content-Type': 'application/xml; charset=utf-8', 'Accept': 'application/xml' },
            body: d.webdav.PROPFIND_BODY,
        });
    }

    /**
     * PROPFIND Depth 0 → the entry, or a spreadsheet_not_found.
     * @param {FileRef} file
     * @returns {Promise<NcEntry>}
     */
    async function stat(file) {
        const path = normalizePath(file && file.path);
        if (!file || !file.path) throw new SpreadsheetSourceError(422, 'spreadsheet_rejected', 'A Nextcloud file needs a path.');
        await assertScope('nextcloud_read_file', path, file);
        const res = await propfind(path, '0');
        if (res.status === 404) throw new SpreadsheetSourceError(404, 'spreadsheet_not_found', `Nextcloud no longer has ${path}.`, { ref: refOf(file) });
        if (!res.ok && res.status !== 207) throw fromHttp(provider, res.status, await res.text().catch(() => ''), 'file', { ref: refOf(file) });
        const entry = d.webdav.parsePropfind(await res.text(), baseUrl, uid)[0];
        if (!entry) throw new SpreadsheetSourceError(404, 'spreadsheet_not_found', `Nextcloud no longer has ${path}.`, { ref: refOf(file) });
        return entry;
    }

    /** @param {FileRef} file */
    async function probe(file) {
        const entry = await stat(file);
        const ref = toFileRef(entry, { baseUrl, uid, linkBase: await linkBase() });
        if (!ref || ref.isFolder) {
            throw new SpreadsheetSourceError(415, 'format_unsupported', `"${entry.name}" is not a spreadsheet Bee Flow can read.`, { ref: refOf(file) });
        }
        return {
            marker: markerOf(entry),
            name: ref.name,
            size: ref.size,
            mimeType: ref.mimeType,
            format: ref.format,
            path: ref.path,
            webUrl: ref.webUrl,
            owned: ref.owned,
            writable: ref.writable,
            file: ref,
        };
    }

    /**
     * Identity on Nextcloud IS the path; this is probe() by another name.
     * @param {string} path
     */
    async function resolveByPath(path) {
        try {
            return (await probe({ path })).file;
        } catch (e) {
            if (e && e.code === 'spreadsheet_not_found') return null;
            throw e;
        }
    }

    const n = { d, auth, baseUrl, uid, root, guardCtx, linkBase, propfind, assertScope, stat, probe };
    return {
        provider,
        /** @param {Parameters<typeof listFolder>[1]} [opts] */
        list: (opts) => listFolder(n, opts),
        probe,
        /** @param {FileRef} file @param {Parameters<typeof downloadFile>[2]} [opts] */
        download: (file, opts) => downloadFile(n, file, opts),
        /** @param {FileRef} file @param {Buffer} buffer @param {Parameters<typeof uploadFile>[3]} [opts] */
        upload: (file, buffer, opts) => uploadFile(n, file, buffer, opts),
        markerEquals, resolveByPath, root, baseUrl, uid,
    };
}

/** Cheap and network-free: connector binding, OAuth session or app password. */
/**
 * @param {{ userId?: string, session?: object|null }} [opts]
 */
async function isConnected({ userId, session = null } = {}) {
    const { ncClient } = deps();
    const connected = await ncClient.isConnected(session, userId).catch(() => false);
    return { connected: !!connected, reason: connected ? null : 'not_connected' };
}

module.exports = {
    provider, oauthProvider, integrationAppIds,
    isConnected,
    forCaller: makeApi,
    forLinker: makeApi,
    markerEquals,
    // exported for tests
    toFileRef, markerOf, normalizePath, isoOf,
};
