// @typecheck strict
/**
 * "Has anything changed under this folder since `cursor`?" for the knowledge-base
 * folder source: Graph's delta feed for the folder (`…/items/{id}/delta`, or the
 * drive root without a folder id). The cursor is the `@odata.deltaLink`; without
 * one, `token=latest` anchors the feed without walking the tree. A delta link is
 * only ever followed when it is a Graph URL (it is sent with the bearer).
 *
 * Delta on a folder other than the root is not offered by every kind of
 * account (OneDrive for Business answers an error): the caller treats any
 * throw as "changed", which costs a listing, never a missed file.
 */

'use strict';

/** Pages of delta one check reads before it gives up and says "changed". */
const DELTA_PAGES_MAX = 20;

/**
 * @typedef {{ json: (path: string) => Promise<{ value?: unknown[], '@odata.nextLink'?: string, '@odata.deltaLink'?: string }>,
 *             ownDriveId: () => Promise<string|null>, graphBase: string }} Graph
 */

/**
 * The Graph path of the folder whose delta feed is asked for: the item, the root of a named
 * drive, or the own drive's root.
 * @param {Graph} g
 * @param {{ folderId?: string|null, driveId?: string|null }} folder
 */
async function deltaBase(g, folder) {
    const id = folder && folder.folderId;
    const drive = (folder && folder.driveId) || null;
    if (id) return `/drives/${encodeURIComponent(drive || (await g.ownDriveId()) || '')}/items/${encodeURIComponent(id)}`;
    return drive ? `/drives/${encodeURIComponent(drive)}/root` : '/me/drive/root';
}

/**
 * @param {Graph} g
 * @param {{ folderId?: string|null, driveId?: string|null }} [folder]
 * @param {string|null} [cursor]
 * @returns {Promise<{ changed: boolean, cursor: string|null }>}
 */
async function changeCursor(g, folder = {}, cursor = null) {
    const base = await deltaBase(g, folder);
    const anchor = async () => {
        const data = await g.json(`${base}/delta?token=latest`);
        return data['@odata.deltaLink'] ? String(data['@odata.deltaLink']) : null;
    };
    if (!cursor || !String(cursor).startsWith(g.graphBase)) return { changed: true, cursor: await anchor() };
    let path = String(cursor);
    let changed = false;
    for (let pages = 0; pages < DELTA_PAGES_MAX; pages += 1) {
        const data = await g.json(path);
        if (Array.isArray(data.value) && data.value.length > 0) changed = true;
        const next = data['@odata.nextLink'];
        if (next && String(next).startsWith(g.graphBase)) { path = String(next); continue; }
        const link = data['@odata.deltaLink'];
        return { changed, cursor: link ? String(link) : String(cursor) };
    }
    return { changed: true, cursor: await anchor() };
}

/**
 * `changeCursor` bound to one api instance's Graph access.
 * @param {Graph} g
 * @returns {(folder?: { folderId?: string|null, driveId?: string|null }, cursor?: string|null) => Promise<{ changed: boolean, cursor: string|null }>}
 */
function bindChangeCursor(g) {
    return (folder, cursor) => changeCursor(g, folder, cursor);
}

module.exports = { changeCursor, bindChangeCursor, DELTA_PAGES_MAX };
