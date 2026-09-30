/**
 * A file question's upload (formPublic.js POST /form/:token/upload): one file,
 * scanned and stored at once, answered with a DESCRIPTOR — the bytes never
 * travel with the submission, so a large attachment cannot blow the body
 * limit and a refused submit does not mean picking the file again.
 *
 * The request itself is core/api/xhrUpload.ts `uploadFile`, which every
 * watched upload shares: it reports progress, streams the part from disk, and
 * carries the session token an SSO sign-in has instead of a cookie. This
 * module only declares the target. The multipart field is `file`
 * (uploadGuard's multer); `field`, `csrf` and, on a later page, `sessionId`
 * ride along as text parts.
 */

import { ApiError } from '@/core/api/client';
import { uploadFile, type UploadTarget } from '@/core/api/xhrUpload';
import { translate } from '@/core/i18n';

import { readUploadedFile } from './fillReaders';
import type { FillUploadFile, UploadedFile } from '../model/fillTypes';

export type { FillUploadFile };

export interface FillUploadTarget {
    token: string;
    field: string;
    csrf: string;
    sessionId: string | null;
    maxSizeMb: number;
}

export class FillFileTooLargeError extends ApiError {
    constructor(readonly maxSizeMb: number) {
        super(translate('mobile.forms.fill.file_too_large', 'That file is larger than {mb} MB.', { mb: maxSizeMb }));
        this.name = 'FillFileTooLargeError';
    }
}

/** The form's upload as the shared uploader's target. */
export function fillUploadTarget(target: FillUploadTarget): UploadTarget {
    const extra: Record<string, string> = { field: target.field, csrf: target.csrf };
    if (target.sessionId) extra.sessionId = target.sessionId;
    return {
        path: `/api/automation/form/${encodeURIComponent(target.token)}/upload`,
        field: 'file',
        maxBytes: target.maxSizeMb * 1024 * 1024,
        extra,
    };
}

export async function uploadFillFile(
    target: FillUploadTarget,
    file: FillUploadFile,
    onProgress?: (fraction: number) => void,
): Promise<UploadedFile> {
    // Checked here rather than by uploadFile, so the refusal names the form's own limit.
    if (file.size > 0 && file.size > target.maxSizeMb * 1024 * 1024) throw new FillFileTooLargeError(target.maxSizeMb);
    const body = await uploadFile<unknown>(fillUploadTarget(target), file, {
        onProgress: onProgress
            ? (p) => {
                  if (p.total > 0) onProgress(p.fraction);
              }
            : undefined,
    });
    return readUploadedFile(body);
}
