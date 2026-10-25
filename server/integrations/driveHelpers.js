// @typecheck noImplicitAny
/**
 * Pure helpers of the Drive tools (driveTools.js): MIME inference, the file
 * shape handed to the model, and the paged "recent files" query.
 */

/**
 * The Drive v3 file fields these tools ask for (googleapis is untyped for the check: types/shims).
 * @typedef {{ id?: string, name?: string, mimeType?: string, size?: string, modifiedTime?: string, createdTime?: string,
 *   webViewLink?: string, iconLink?: string, parents?: string[], shared?: boolean, description?: string,
 *   owners?: Array<{ emailAddress?: string }>, sharingUser?: { emailAddress?: string },
 *   permissions?: Array<{ role?: string, type?: string, emailAddress?: string, displayName?: string }>,
 *   ownedByMe?: boolean, lastModifyingUser?: { me?: boolean } }} DriveFile
 * The part of a googleapis drive v3 client these tools call.
 * @typedef {{ files: {
 *   list(params: object): Promise<{ data: { files?: DriveFile[], nextPageToken?: string } }>,
 *   get(params: object): Promise<{ data: DriveFile }>,
 *   get(params: object, options: { responseType: 'arraybuffer' }): Promise<{ data: ArrayBuffer }>,
 *   get(params: object, options: { responseType: 'text' }): Promise<{ data: string }>,
 *   update(params: object): Promise<{ data: DriveFile }>,
 *   create(params: object): Promise<{ data: DriveFile }>,
 *   export(params: object): Promise<{ data: unknown }> } }} DriveClient
 */

// ─── MIME inference ────────────────────────────────────────────

/** @type {Record<string, string>} */
const EXT_TO_MIME = {
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    csv: 'text/csv',
    txt: 'text/plain',
    md: 'text/markdown',
    html: 'text/html',
    json: 'application/json',
    xml: 'application/xml',
    zip: 'application/zip',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** @param {{ mimeArg?: string, handleMime?: string, filename?: string }} params */
function inferMimeType({ mimeArg, handleMime, filename }) {
    if (mimeArg) return mimeArg;
    if (handleMime) return handleMime;
    const ext = String(filename || '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
    return (ext && EXT_TO_MIME[ext]) || 'application/octet-stream';
}

// ─── Format File ───────────────────────────────────────────────

/** @param {DriveFile} file */
function formatFile(file) {
    return {
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        size: file.size ? `${(parseInt(file.size) / 1024).toFixed(1)} KB` : null,
        modifiedTime: file.modifiedTime,
        createdTime: file.createdTime,
        webViewLink: file.webViewLink,
        iconLink: file.iconLink,
        parents: file.parents,
        shared: file.shared,
        owners: file.owners?.map(o => o.emailAddress),
        sharingUser: file.sharingUser?.emailAddress,
    };
}

// ─── Recent files ──────────────────────────────────────────────

const RECENT_DEFAULT_DAYS = 30;
const RECENT_MAX_RESULTS = 200;
const RECENT_PAGE_SIZE = 100;
const RECENT_MAX_PAGES = 4;

/**
 * drive_list_recent: files (never folders, never content) modified since a
 * date, newest first, capped at 200. `modifiedByMe` comes from Drive's own
 * lastModifyingUser.me flag, so a caller can keep only the user's own edits
 * without any name or address passing through.
 *
 * @param {{ files: { list(params: object): Promise<{ data: { files?: Array<{ id?: string, name?: string, mimeType?: string, parents?: string[], modifiedTime?: string, createdTime?: string, ownedByMe?: boolean, lastModifyingUser?: { me?: boolean } }>, nextPageToken?: string } }> } }} drive - a googleapis drive v3 client (injected in tests)
 * @param {{ since?: string|number|null, maxResults?: number|string }} [args] - { since?, maxResults? }
 * @param {{ now?: number }} [options]
 */
async function listRecentDriveFiles(drive, args, { now = Date.now() } = {}) {
    /** @type {string} */
    let sinceIso;
    if (args?.since === undefined || args?.since === null || args?.since === '') {
        sinceIso = new Date(now - RECENT_DEFAULT_DAYS * 86400000).toISOString();
    } else {
        const ms = Date.parse(String(args.since));
        if (!Number.isFinite(ms)) throw new Error('since must be an ISO date/time');
        sinceIso = new Date(ms).toISOString();
    }
    const want = Math.min(Math.max(parseInt(args?.maxResults) || 50, 1), RECENT_MAX_RESULTS);

    const files = [];
    /** @type {string | undefined} */
    let pageToken;
    let pages = 0;
    do {
        const res = await drive.files.list({
            q: `modifiedTime >= '${sinceIso}' and trashed = false and mimeType != 'application/vnd.google-apps.folder'`,
            pageSize: Math.min(want - files.length, RECENT_PAGE_SIZE),
            pageToken,
            fields: 'nextPageToken, files(id, name, mimeType, modifiedTime, createdTime, parents, ownedByMe, lastModifyingUser(me))',
            orderBy: 'modifiedTime desc',
        });
        pages++;
        for (const f of (res.data.files || [])) files.push(f);
        pageToken = res.data.nextPageToken;
    } while (pageToken && files.length < want && pages < RECENT_MAX_PAGES);

    return {
        since: sinceIso,
        resultCount: Math.min(files.length, want),
        hasMore: !!pageToken || files.length > want,
        results: files.slice(0, want).map(f => ({
            id: f.id,
            name: f.name,
            mimeType: f.mimeType,
            parentId: Array.isArray(f.parents) && f.parents.length ? f.parents[0] : null,
            modifiedTime: f.modifiedTime,
            createdTime: f.createdTime,
            ownedByMe: f.ownedByMe === true,
            modifiedByMe: f.lastModifyingUser?.me === true,
        })),
    };
}

module.exports = { inferMimeType, formatFile, listRecentDriveFiles };
