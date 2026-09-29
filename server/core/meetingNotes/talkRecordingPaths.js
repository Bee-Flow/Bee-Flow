// @typecheck
/**
 * Where Nextcloud Talk actually puts call recordings.
 *
 * Talk does NOT write recordings into the attachment folder — it writes them
 * into a `Recording` subfolder of it, one folder per room token:
 *
 *     <attachmentFolder>/Recording/<roomToken>/<file>
 *
 * Verified against nextcloud/spreed on Nextcloud 34 (Hub 26 Spring):
 *   - `Config::getRecordingFolder($user)` returns the user preference
 *     `recording_folder`, defaulting to `getAttachmentFolder($user) . '/Recording'`.
 *   - `Config::getAttachmentFolder($user)` returns the user preference
 *     `attachment_folder`, defaulting to the app value `default_attachment_folder`,
 *     which `ConfigLexicon` declares as `/Talk`.
 *   - `RecordingService::getRecordingFolder()` then does
 *     `$recordingRootFolder->get($token)` — the room token is the LAST folder
 *     level, and conversation subfolders (`<name>-<token>`, an attachments-only
 *     feature) never apply to recordings.
 *
 * So the default is `/Talk/Recording/<token>/<file>`, not `/Talk/<token>/<file>`.
 *
 * This lives in its own module (no store/db imports) so both the ingest
 * pipeline and the HTTP routes can share one definition — and so it can be
 * unit-tested without a database.
 */

const DEFAULT_ATTACHMENT_FOLDER = '/Talk';
const RECORDING_SUBFOLDER = 'Recording';
const DEFAULT_RECORDING_FOLDER = `${DEFAULT_ATTACHMENT_FOLDER}/${RECORDING_SUBFOLDER}`;

/** Collapse a path to a leading-slash, no-trailing-slash form ('/' stays '/'). */
function normalizeFolder(p) {
    return '/' + String(p == null ? '' : p).split('/').filter(Boolean).join('/');
}

/** The path prefix a child of `folder` starts with (handles the root folder). */
function folderPrefix(folder) {
    return folder === '/' ? '/' : `${folder}/`;
}

/** Whether `folder`'s last segment is already the Talk `Recording` subfolder. */
function isRecordingRoot(folder) {
    const last = normalizeFolder(folder).split('/').filter(Boolean).pop() || '';
    return last.toLowerCase() === RECORDING_SUBFOLDER.toLowerCase();
}

/**
 * Candidate roots that hold `<roomToken>/<file>`, deepest first.
 *
 * A configured folder that already ends in `/Recording` is used as-is.
 * Anything else yields both `<folder>/Recording` (what Talk does by default)
 * and `<folder>` itself — the latter so a tenant whose stored setting predates
 * this fix, or an admin who pointed Talk's `recording_folder` preference
 * straight at the attachment folder, keeps working.
 *
 * Deepest-first matters: `/Talk/Recording/abc/x.ogg` must be claimed by
 * `/Talk/Recording` (token `abc`), never by `/Talk` (which would read the
 * literal folder name `Recording` as the room token).
 */
function talkRecordingRoots(recordingFolder = DEFAULT_RECORDING_FOLDER) {
    const folder = normalizeFolder(recordingFolder || DEFAULT_RECORDING_FOLDER);
    const roots = [folder];
    if (!isRecordingRoot(folder)) {
        roots.push(normalizeFolder(`${folderPrefix(folder)}${RECORDING_SUBFOLDER}`));
    }
    return Array.from(new Set(roots)).sort((a, b) => b.length - a.length);
}

/**
 * If `ncPath` is a Talk call recording under one of the roots derived from
 * `recordingFolder`, return its room token; else null.
 *
 * The deepest matching root decides — and it must be followed by EXACTLY
 * `<token>/<file>`. The old `>= 2 segments, take the first` rule silently
 * turned `/Talk/Recording/<token>/<file>` into the room token `"Recording"`,
 * which then failed every downstream lookup that used it (armed-token check,
 * participant roster, Talk write-back).
 *
 * @param {string} ncPath          user-relative Nextcloud Files path
 * @param {string} recordingFolder configured Talk recordings folder
 * @returns {string|null}
 */
function parseTalkRoomToken(ncPath, recordingFolder = DEFAULT_RECORDING_FOLDER) {
    if (!ncPath) return null;
    const full = normalizeFolder(ncPath);
    for (const root of talkRecordingRoots(recordingFolder)) {
        const prefix = folderPrefix(root);
        if (!full.toLowerCase().startsWith(prefix.toLowerCase())) continue;
        const rest = full.slice(prefix.length).split('/').filter(Boolean);
        // The deepest matching root is the only one allowed to claim this path.
        if (rest.length !== 2) return null;
        return /^[A-Za-z0-9]+$/.test(rest[0]) ? rest[0] : null;
    }
    return null;
}

module.exports = {
    DEFAULT_ATTACHMENT_FOLDER,
    RECORDING_SUBFOLDER,
    DEFAULT_RECORDING_FOLDER,
    normalizeFolder,
    folderPrefix,
    isRecordingRoot,
    talkRecordingRoots,
    parseTalkRoomToken,
};
