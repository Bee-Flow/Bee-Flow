/**
 * davStatusError.mts: the plain message for the three WebDAV answers a write
 * can get that say nothing about the path being wrong.
 *
 *   423  the file is locked (open in an editor, or locked by another user)
 *   507  the quota of the account or the folder is used up
 *   403  the account may not change it: a read-only share, a team folder
 *        permission or a file access control rule
 *
 * One helper for every write path (create folder, delete, move, copy, upload
 * and the generated office files), so the three read the same everywhere and
 * the classifier (utils/nextcloudErrorClassifier.js) keys on one wording. The
 * status stays in the text: the classifier and the step-error card read it.
 * The response body is not echoed.
 */

/**
 * @param status the HTTP status of the WebDAV answer
 * @param target the path the operation worked on, as the caller named it
 * @returns the message, or null when the status is not one of the three
 */
export function davStatusError(status: number, target: string | null | undefined): string | null {
    const what = target ? String(target) : 'this file or folder';
    if (status === 423) {
        return `${what} is locked in Nextcloud (423): it is open in an editor or locked by another user. Try again later, or ask them to unlock it.`;
    }
    if (status === 507) {
        return `Not enough storage in Nextcloud for ${what} (507): the quota of the account or the folder is used up.`;
    }
    if (status === 403) {
        return `Permission denied in Nextcloud for ${what} (403): the account may not change this file or folder. A read-only share, a team folder permission or a file access control rule can block it.`;
    }
    return null;
}
