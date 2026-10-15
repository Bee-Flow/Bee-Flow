/**
 * Pure helpers of the Drive tools (driveTools.js): MIME inference, the file
 * shape handed to the model, and the paged "recent files" query.
 */

// ─── MIME inference ────────────────────────────────────────────

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

function inferMimeType({ mimeArg, handleMime, filename }) {
    if (mimeArg) return mimeArg;
    if (handleMime) return handleMime;
    const ext = String(filename || '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
    return (ext && EXT_TO_MIME[ext]) || 'application/octet-stream';
}

// ─── Format File ───────────────────────────────────────────────

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
 * @param {object} drive - a googleapis drive v3 client (injected in tests)
 * @param {object} args - { since?, maxResults? }
 */
async function listRecentDriveFiles(drive, args, { now = Date.now() } = {}) {
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
