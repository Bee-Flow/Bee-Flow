/**
 * Evidence upload: POST /api/compliance/iso/evidence/upload (multer, field
 * `file`, 15 MB; routes/compliance/evidence.js), answering
 * `{ uploaded, sha256, filename }`. An attestation then carries only the
 * allow-listed ref `{ sha256, filename }` — never the file itself (web:
 * pages/custom/AttestDrawer.uploadEvidence / evidenceRef).
 *
 * XHR, not `api.upload`: expo/fetch cannot send a React Native
 * `{ uri, name, type }` part, and XHR streams the picked file from disk.
 * core/api/xhrUpload supplies the headers every request carries (the SSO
 * token) and turns a refusal into an ApiError.
 */

import { apiUrl } from '@/core/api/server';
import { setAuthHeaders, uploadError } from '@/core/api/xhrUpload';

import { readUpload } from './readers';
import { COMPLIANCE } from '../model/paths';

export const EVIDENCE_UPLOAD_PATH = `${COMPLIANCE}/iso/evidence/upload`;
export const EVIDENCE_MAX_BYTES = 15 * 1024 * 1024;

export interface PickedFile {
    uri: string;
    name: string;
    mimeType: string;
}

export interface EvidenceMeta {
    subjectType: string;
    subjectId?: string | null;
    checkId?: string | null;
}

export interface EvidenceRef {
    sha256: string;
    filename: string | null;
}

function parseBody(text: string): unknown {
    try {
        return JSON.parse(text) as unknown;
    } catch {
        return null;
    }
}

function evidenceForm(file: PickedFile, meta: EvidenceMeta): FormData {
    const form = new FormData();
    form.append('file', { uri: file.uri, name: file.name, type: file.mimeType } as unknown as Blob);
    form.append('subject_type', meta.subjectType);
    if (meta.subjectId) form.append('subject_id', meta.subjectId);
    if (meta.checkId) form.append('check_id', meta.checkId);
    return form;
}

/** Upload one file; resolves to the ref an attestation carries. */
export function uploadEvidence(file: PickedFile, meta: EvidenceMeta): Promise<EvidenceRef> {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', apiUrl(EVIDENCE_UPLOAD_PATH));
        xhr.responseType = 'text';
        xhr.withCredentials = true;
        setAuthHeaders(xhr);
        xhr.onerror = () => reject(uploadError(EVIDENCE_UPLOAD_PATH, 0, null));
        xhr.onload = () => {
            const body = parseBody(xhr.responseText);
            const read = readUpload(body);
            if (xhr.status >= 200 && xhr.status < 300 && read.sha256) {
                resolve({ sha256: read.sha256, filename: read.filename });
                return;
            }
            reject(uploadError(EVIDENCE_UPLOAD_PATH, xhr.status, body));
        };
        xhr.send(evidenceForm(file, meta));
    });
}
