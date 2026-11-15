/**
 * The Files half of ncVisibility.mts, split out by responsibility: find a
 * file by its id in a subscriber's own Files tree (WebDAV SEARCH) and give
 * the payload keys of that file as the subscriber sees it.
 */

type Payload = Record<string, unknown>;

function xmlEscape(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** WebDAV SEARCH body: the node with this file id anywhere in the user's Files tree. */
export function fileIdSearchBody(uid: string, fileId: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<d:searchrequest xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:basicsearch>
    <d:select><d:prop><oc:fileid/></d:prop></d:select>
    <d:from><d:scope><d:href>/files/${xmlEscape(uid)}</d:href><d:depth>infinity</d:depth></d:scope></d:from>
    <d:where><d:eq><d:prop><oc:fileid/></d:prop><d:literal>${xmlEscape(fileId)}</d:literal></d:eq></d:where>
    <d:limit><d:nresults>1</d:nresults></d:limit>
  </d:basicsearch>
</d:searchrequest>`;
}

/** The user-relative path of the first SEARCH hit in `uid`'s Files tree, or null. */
export function pathFromSearch(xml: string, uid: string): string | null {
    const prefix = `/remote.php/dav/files/${uid}`;
    for (const m of xml.matchAll(/<(?:[A-Za-z0-9_-]+:)?href>([^<]*)<\/(?:[A-Za-z0-9_-]+:)?href>/g)) {
        let href = m[1].trim();
        try { href = decodeURIComponent(href); } catch { continue; }
        const at = href.indexOf(prefix);
        if (at < 0) continue;
        const rest = href.slice(at + prefix.length);
        if (rest !== '' && !rest.startsWith('/')) continue; // another user whose uid starts with ours
        const path = rest.replace(/\/+$/, '');
        if (path) return path;
    }
    return null;
}

function dirOf(path: string): string {
    const i = path.lastIndexOf('/');
    return i <= 0 ? '/' : path.slice(0, i);
}

function baseOf(path: string): string {
    return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * The subscriber-view payload keys for a file found at `path`. A rename's
 * `oldPath` is translated only when the file stayed in the same folder; after
 * a move the old folder is the actor's business, so it is dropped.
 */
export function fileOverrides(payload: Payload, path: string, uid: string): Payload {
    const name = baseOf(path);
    const dot = name.lastIndexOf('.');
    const extension = dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : null;
    const out: Payload = { path, name, extension, owner: uid };
    if (typeof payload.oldPath === 'string' && typeof payload.path === 'string') {
        out.oldPath = dirOf(payload.oldPath) === dirOf(payload.path) ? `${dirOf(path) === '/' ? '' : dirOf(path)}/${baseOf(payload.oldPath)}` : null;
    }
    if (typeof payload.objectName === 'string') out.objectName = path;
    return out;
}

