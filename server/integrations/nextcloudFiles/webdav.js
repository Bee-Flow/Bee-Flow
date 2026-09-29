/**
 * Nextcloud WebDAV plumbing shared by the file tools — the multistatus XML
 * parser, the PROPFIND body, path building and the binary upload helper.
 */

const ncClient = require('../nextcloudClient');
const { XMLParser } = require('fast-xml-parser');

const MAX_TEXT_BYTES = 200 * 1024;          // 200 KB cap on file reads
const REQUEST_TIMEOUT_MS = ncClient.REQUEST_TIMEOUT_MS;

// Shared parser. removeNSPrefix collapses d:/oc:/nc:/s: namespace prefixes so
// <d:response> → response, <oc:fileid> → fileid. Tag values stay as strings;
// callers parseInt where needed.
const xmlParser = new XMLParser({
    ignoreAttributes: false,
    removeNSPrefix: true,
    parseTagValue: false,
    trimValues: true,
});

// Normalize a WebDAV multistatus response into [{ href, props, status }] where
// props is the merged successful prop bag. Sabre/DAV returns either an array
// or a single object for response/propstat depending on cardinality, so this
// flattens both shapes.
function parseMultistatus(xml) {
    const parsed = xmlParser.parse(xml);
    const ms = parsed?.multistatus;
    if (!ms) return [];
    const responses = Array.isArray(ms.response) ? ms.response : (ms.response ? [ms.response] : []);
    return responses.map((r) => {
        const propstats = Array.isArray(r.propstat) ? r.propstat : (r.propstat ? [r.propstat] : []);
        const props = {};
        for (const ps of propstats) {
            // Only merge 2xx propstat blocks; 404s carry empty placeholders.
            const status = ps.status || '';
            if (status && !/\b2\d\d\b/.test(status)) continue;
            Object.assign(props, ps.prop || {});
        }
        return { href: r.href || '', props, status: r.status || '' };
    });
}

function isCollectionProp(props) {
    const rt = props.resourcetype;
    if (!rt) return false;
    // <d:resourcetype><d:collection/></d:resourcetype> → { collection: '' }
    return rt.collection !== undefined;
}
const PROPFIND_BODY = `<?xml version="1.0"?>
<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns">
  <d:prop>
    <d:displayname/>
    <d:getcontentlength/>
    <d:getcontenttype/>
    <d:getlastmodified/>
    <d:resourcetype/>
    <oc:fileid/>
    <oc:size/>
    <d:getetag/>
    <oc:permissions/>
    <oc:owner-id/>
  </d:prop>
</d:propfind>`;
// The last three were added for the spreadsheet mirror (dataEngine/sources/
// spreadsheetFile): the etag is the change marker a PUT is guarded with
// (If-Match), the permission string says whether the file may be written at
// all (a 'W' in it), and the owner id says whose storage a write would land
// in. They are harmless for the list tool: Nextcloud answers what it has and
// a 404 propstat for the rest, which parseMultistatus already drops.

// ─── Helpers ──────────────────────────────────────────────────────

function joinDavPath(root, path) {
    const cleaned = String(path || '/').replace(/^\/+/, '').replace(/\/+$/, '');
    if (!cleaned) return root + '/';
    const encoded = cleaned.split('/').map(encodeURIComponent).join('/');
    return `${root}/${encoded}`;
}

// Create each ancestor folder of `filePath` top-down (NC 30/31 has no
// auto-mkcol). MKCOL is idempotent enough: 201=created, 405=already exists —
// both fine. We walk parents in order so a 409 (missing grandparent) can't
// happen. Best-effort: a failure here surfaces later as the PUT's own error.
async function ensureParentFolders(ncFetch, root, filePath) {
    const segs = String(filePath || '').replace(/^\/+/, '').split('/');
    segs.pop(); // drop the filename
    let acc = '';
    for (const seg of segs) {
        if (!seg) continue;
        acc += `/${seg}`;
        try { await ncFetch(joinDavPath(root, acc), { method: 'MKCOL' }); } catch (_) { /* best-effort */ }
    }
}

// Upload a binary Buffer to a WebDAV path (PUT), creating parent folders first.
// Mirrors nextcloud_upload_file but for generated office files. `OC-Total-Length`
// lets Nextcloud validate quota up front.
//
// `fileId` rides along when Nextcloud answers the PUT with an `OC-FileId`
// header (`<8-digit zero-padded id><instance id>`); a caller that needs it —
// to build the `/f/<id>` deep link that opens the file in Nextcloud Office —
// passes `wantFileId` and gets one PROPFIND when the header is missing (the
// connector hop does not forward it). Header access is defensive: the fake
// responses in older tests carry no `headers` at all.
async function uploadBinaryFile(ncFetch, root, path, buffer, contentType, authError, opts = {}) {
    await ensureParentFolders(ncFetch, root, path);
    const res = await ncFetch(joinDavPath(root, path), {
        method: 'PUT',
        headers: { 'Content-Type': contentType, 'OC-Total-Length': String(buffer.length) },
        body: buffer,
    });
    if (res.status === 401) return { error: authError };
    if (!res.ok && res.status !== 201 && res.status !== 204) {
        const text = await res.text().catch(() => '');
        return { error: `Upload failed (${res.status}): ${text.slice(0, 200)}` };
    }
    let fileId = parseOcFileId(res.headers && typeof res.headers.get === 'function' ? res.headers.get('oc-fileid') : null);
    if (!fileId && opts.wantFileId) {
        try {
            const stat = await statFile(ncFetch, root, path, opts.baseUrl, opts.uid);
            fileId = stat && stat.fileId ? String(stat.fileId) : null;
        } catch (_) { fileId = null; }
    }
    const out = { success: true, path, contentType, bytes: buffer.length, created: res.status === 201, updated: res.status === 204 };
    if (fileId) out.fileId = fileId;
    return out;
}

/** The numeric file id out of an `OC-FileId` header value, or null. */
function parseOcFileId(value) {
    const v = String(value || '').trim();
    const m = /^(\d{8})/.exec(v);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    return Number.isFinite(n) && n > 0 ? String(n) : null;
}

/** One file's PROPFIND entry (Depth 0), or null when Nextcloud has no such path. */
async function statFile(ncFetch, root, path, baseUrl, uid) {
    const res = await ncFetch(joinDavPath(root, path), {
        method: 'PROPFIND',
        headers: { Depth: '0', 'Content-Type': 'application/xml' },
        body: PROPFIND_BODY,
    });
    if (!res.ok && res.status !== 207) return null;
    const xml = await res.text();
    const entries = parsePropfind(xml, baseUrl, uid);
    return entries[0] || null;
}

function relativeFromRoot(href, baseUrl, uid) {
    // Convert WebDAV href like "/remote.php/dav/files/alice/Documents/foo.md"
    // to "/Documents/foo.md" (the user-facing path).
    try {
        const decoded = decodeURIComponent(href);
        const rootPath = `/remote.php/dav/files/${decodeURIComponent(uid)}`;
        const idx = decoded.indexOf(rootPath);
        if (idx === -1) return decoded;
        return decoded.slice(idx + rootPath.length) || '/';
    } catch (_) {
        return href;
    }
}

function parsePropfind(xml, baseUrl, uid) {
    return parseMultistatus(xml).map(({ href, props }) => {
        if (!href) return null;
        const isCollection = isCollectionProp(props);
        const size = parseInt(props.getcontentlength || '0', 10);
        const contentType = props.getcontenttype || null;
        const lastMod = props.getlastmodified || null;
        const fileId = props.fileid || null;
        // Kept verbatim, quotes included — it goes back to Nextcloud as-is in
        // an If-Match header, and Sabre compares the quoted form.
        const etag = props.getetag || null;
        const permissions = props.permissions || null;
        // removeNSPrefix turns <oc:owner-id> into the key 'owner-id'.
        const ownerId = props['owner-id'] || null;
        const path = relativeFromRoot(href, baseUrl, uid);
        const name = path.replace(/\/$/, '').split('/').pop() || '/';
        return {
            name,
            path: path.replace(/\/$/, '') || '/',
            type: isCollection ? 'folder' : 'file',
            size: isCollection ? undefined : size,
            contentType: isCollection ? undefined : contentType,
            modified: lastMod,
            fileId,
            etag,
            permissions,
            ownerId,
        };
    }).filter(Boolean);
}

module.exports = {
    MAX_TEXT_BYTES,
    REQUEST_TIMEOUT_MS,
    parseOcFileId,
    statFile,
    parseMultistatus,
    isCollectionProp,
    PROPFIND_BODY,
    joinDavPath,
    ensureParentFolders,
    uploadBinaryFile,
    relativeFromRoot,
    parsePropfind,
};
