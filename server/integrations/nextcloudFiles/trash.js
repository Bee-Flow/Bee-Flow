// @typecheck strict
/**
 * The trash bin — list deleted items, restore one to its original location, or
 * remove it permanently.
 */

const { parseMultistatus, isCollectionProp } = require('./webdav');

const TRASH_PROPFIND_BODY = `<?xml version="1.0"?>
<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns">
  <d:prop>
    <d:displayname/>
    <d:getcontentlength/>
    <d:getcontenttype/>
    <d:getlastmodified/>
    <d:resourcetype/>
    <oc:fileid/>
    <nc:trashbin-original-location/>
    <nc:trashbin-deletion-time/>
  </d:prop>
</d:propfind>`;

const NOT_IN_TRASH = 'trashPath must be an item inside the trash, as returned by nextcloud_list_trash (it starts with "/trash/").';

/**
 * The segments of a path inside the trash (`trash/<item>[/…]`), or null. A
 * `.` or `..` segment is refused: the URL parser would resolve it, and
 * `../../files/<uid>/x` is a live file, not a trash item.
 * @param {string} trashPath
 * @returns {string[] | null}
 */
function trashSegments(trashPath) {
    const segments = String(trashPath).replace(/^\/+|\/+$/g, '').split('/');
    if (segments.length < 2 || segments[0] !== 'trash') return null;
    if (segments.some((s) => !s || s === '.' || s === '..')) return null;
    return segments;
}

// Returns undefined when the tool belongs to another Nextcloud file family, so
// the facade can hand it to the next handler.
/**
 * @param {string} toolName
 * @param {{ limit?: number, originalPath?: string, trashPath?: string }} args
 * @param {import('./webdav').FilesToolCtx} ctx
 */
async function executeTrashTool(toolName, args, ctx) {
    const { baseUrl, ncFetch, authError, uid } = ctx;

    switch (toolName) {
        case 'nextcloud_list_trash': {
            const limit = Math.min(Math.max(args.limit || 200, 1), 1000);
            const url = `${baseUrl}/remote.php/dav/trashbin/${encodeURIComponent(uid)}/trash/`;
            const res = await ncFetch(url, {
                method: 'PROPFIND',
                headers: { 'Depth': '1', 'Content-Type': 'application/xml; charset=utf-8' },
                body: TRASH_PROPFIND_BODY,
            });
            if (res.status === 401) return { error: authError };
            if (!res.ok) return { error: `Trash list failed (${res.status})` };
            const xml = await res.text();
            const responses = [];
            for (const { href, props } of parseMultistatus(xml)) {
                if (!href) continue;
                const trashPath = decodeURIComponent(href).replace(`/remote.php/dav/trashbin/${decodeURIComponent(uid)}/`, '/');
                if (trashPath.replace(/\/$/, '') === '/trash') continue;
                const isCollection = isCollectionProp(props);
                const size = parseInt(props.getcontentlength || '0', 10);
                const deletionTime = props['trashbin-deletion-time'] || null;
                responses.push({
                    name: props.displayname || '',
                    trashPath,
                    type: isCollection ? 'folder' : 'file',
                    size: isCollection ? undefined : size,
                    fileId: props.fileid || null,
                    originalLocation: props['trashbin-original-location'] || null,
                    deletionTime: deletionTime ? new Date(parseInt(deletionTime, 10) * 1000).toISOString() : null,
                });
                if (responses.length >= limit) break;
            }
            return { count: responses.length, items: responses };
        }

        case 'nextcloud_restore_from_trash': {
            if (!args.trashPath) return { error: 'trashPath is required' };
            const segments = trashSegments(args.trashPath);
            if (!segments) return { error: NOT_IN_TRASH };
            const trashbin = `${baseUrl}/remote.php/dav/trashbin/${encodeURIComponent(uid)}`;
            const sourceUrl = `${trashbin}/${segments.map(encodeURIComponent).join('/')}`;
            // Nextcloud restores to the original location by itself. The restore
            // folder is flat, so the destination is the item's own name: a
            // destination with folders in it has no parent collection (409).
            const destUrl = `${trashbin}/restore/${encodeURIComponent(segments[segments.length - 1])}`;
            const res = await ncFetch(sourceUrl, {
                method: 'MOVE',
                headers: { 'Destination': destUrl },
            });
            if (res.status === 401) return { error: authError };
            if (res.status === 404) return { error: `Trash item not found: ${args.trashPath}` };
            if (!res.ok && res.status !== 201 && res.status !== 204) {
                return { error: `Restore failed (${res.status})` };
            }
            return { success: true, restoredFrom: args.trashPath };
        }

        case 'nextcloud_permanent_delete_trash': {
            if (!args.trashPath) return { error: 'trashPath is required' };
            const segments = trashSegments(args.trashPath);
            if (!segments) return { error: NOT_IN_TRASH };
            const url = `${baseUrl}/remote.php/dav/trashbin/${encodeURIComponent(uid)}/${segments.map(encodeURIComponent).join('/')}`;
            const res = await ncFetch(url, { method: 'DELETE' });
            if (res.status === 401) return { error: authError };
            if (res.status === 404) return { error: `Trash item not found: ${args.trashPath}` };
            if (!res.ok && res.status !== 204) return { error: `Permanent delete failed (${res.status})` };
            return { success: true, deleted: args.trashPath };
        }

        default:
            return undefined;
    }
}

module.exports = { executeTrashTool };
