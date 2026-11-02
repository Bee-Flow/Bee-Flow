/**
 * The delete token of an unlinked public App Studio upload. The upload answer
 * carries it; DELETE /:token/data/attachments/:fileId requires it, so only
 * the visitor who received the upload answer can discard that upload.
 *
 * The token is an HMAC over the app and attachment ids under the server
 * secret: nothing to store, and it cannot be derived from the ids alone.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const DELETE_TOKEN_HEADER = 'x-upload-delete-token';

function secret(): string {
    const value = process.env.SESSION_SECRET || '';
    if (value.length < 32) throw new Error('SESSION_SECRET must be set (>=32 chars) for upload delete tokens.');
    return value;
}

export function uploadDeleteToken(appId: string, attachmentId: string): string {
    return createHmac('sha256', secret())
        .update(`studio-public-upload-delete:${appId}:${attachmentId}`)
        .digest('base64url');
}

export function isValidUploadDeleteToken(appId: string, attachmentId: string, presented: unknown): boolean {
    if (typeof presented !== 'string' || !presented) return false;
    const expected = Buffer.from(uploadDeleteToken(appId, attachmentId));
    const given = Buffer.from(presented);
    return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Whether the request carries the delete token of this upload. */
export function presentedFor(req: { get(name: string): string | undefined }, appId: string, attachmentId: string): boolean {
    return isValidUploadDeleteToken(appId, attachmentId, req.get(DELETE_TOKEN_HEADER));
}
