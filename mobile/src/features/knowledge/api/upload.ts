/**
 * Where the Library's documents go.
 *
 * `api.upload` is the right tool for a small one-shot form, but it cannot
 * report progress, and every upload in the Library is one a person watches:
 * a 40-page PDF on hotel wifi, a photographed contract, a .docx template. A
 * spinner with no number is indistinguishable from a hang, and the honest
 * answer to "is this stuck?" is a percentage. The XMLHttpRequest uploader that
 * gives one is core/api/xhrUpload.ts `uploadFile`; this module only declares
 * the target, and re-exports the uploader for the upload queue.
 *
 * Each target lives with the feature it uploads to: kbIngestTarget here,
 * notebookSourceTarget in notebooks, templateUploadTarget in templates,
 * fillUploadTarget in forms.
 *
 * THE FIELD NAMES AND CAPS BELOW ARE THE CONTRACT. Each one is a multer
 * `upload.single(...)` on the server and a `limits.fileSize` next to it; a
 * mismatch is a 400 "No file uploaded" that looks like a network fault.
 */

import type { UploadTarget } from '@/core/api/xhrUpload';

export { FileTooLargeError, uploadFile, type UploadFile, type UploadProgress, type UploadTarget } from '@/core/api/xhrUpload';

/** routes/knowledgeBases/ingest.js — `upload.single('file')`, 20 MB. */
export function kbIngestTarget(kbId: string): UploadTarget {
    return {
        path: `/api/kb/${encodeURIComponent(kbId)}/ingest/file`,
        field: 'file',
        maxBytes: 20 * 1024 * 1024,
        accepts: 'PDF, Word, Excel, CSV or text',
    };
}
