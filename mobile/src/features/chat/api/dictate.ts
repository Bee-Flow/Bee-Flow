/**
 * Dictation: a recording in, its words out — POST /api/dictate (routes/
 * dictate.js), multipart `audio` plus a `language` hint. Local-only on the
 * server by design (a dictated phrase never goes to a cloud ASR vendor), so it
 * works on every install.
 */

import { field, pick } from '@/core/api/contract';
import { uploadFile, type UploadTarget } from '@/core/api/xhrUpload';

/** multer's cap on the route. */
const MAX_BYTES = 25 * 1024 * 1024;

export async function dictate(uri: string, language: string): Promise<string> {
    const target: UploadTarget = { path: '/api/dictate', field: 'audio', maxBytes: MAX_BYTES, extra: { language } };
    const res = await uploadFile<unknown>(target, { uri, name: 'dictation.m4a', mimeType: 'audio/mp4', size: 0 });
    return (field.optStr(pick(res, 'text')) ?? '').trim();
}
