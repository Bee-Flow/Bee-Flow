import { API_BASE, getSessionToken } from '../../../utils/helpers';

/**
 * Upload to the CMS with real progress.
 *
 * fetch() cannot report upload progress, and a clip is up to 500 MB, so the
 * clip path goes through XMLHttpRequest. Authentication is what authFetch does:
 * the session cookie (withCredentials) plus the X-Session-Token fallback used
 * in embedded iframes, and the client name header.
 */

export type CmsUploadPath = 'upload' | 'upload-clip';

export interface CmsUploadResult {
    key: string;
    url: string;
}

export const CLIP_MAX_BYTES = 500 * 1024 * 1024;

interface UploadOptions {
    path?: CmsUploadPath;
    /** Called with 0..100 while the request body is being sent. */
    onProgress?: (percent: number) => void;
    signal?: AbortSignal;
}

export function uploadCmsFile(file: File, { path = 'upload', onProgress, signal }: UploadOptions = {}): Promise<CmsUploadResult> {
    return new Promise((resolve, reject) => {
        if (path === 'upload-clip' && file.size > CLIP_MAX_BYTES) {
            reject(new Error('File too large (max 500 MB)'));
            return;
        }
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${API_BASE}/api/cms/admin/${path}`);
        xhr.withCredentials = true;
        xhr.setRequestHeader('X-Beeflow-Client', 'web');
        const token = getSessionToken();
        if (token) xhr.setRequestHeader('X-Session-Token', token);
        xhr.responseType = 'text';

        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable && onProgress) onProgress(Math.min(100, Math.round((e.loaded / e.total) * 100)));
        };
        xhr.onerror = () => reject(new Error('Upload failed: the connection was interrupted'));
        xhr.onabort = () => reject(new Error('Upload cancelled'));
        xhr.ontimeout = () => reject(new Error('Upload timed out'));
        xhr.onload = () => {
            let data: { error?: string; url?: string; key?: string } = {};
            try { data = JSON.parse(xhr.responseText); } catch { /* non-JSON body, e.g. a proxy error page */ }
            if (xhr.status >= 200 && xhr.status < 300 && data.url) {
                resolve({ key: data.key || '', url: data.url });
                return;
            }
            const fallback = xhr.status === 413
                ? 'File too large for this server\'s upload limit'
                : `Upload failed (${xhr.status})`;
            reject(new Error(data.error || fallback));
        };
        if (signal) {
            if (signal.aborted) { reject(new Error('Upload cancelled')); return; }
            signal.addEventListener('abort', () => xhr.abort(), { once: true });
        }

        const fd = new FormData();
        fd.append('file', file);
        xhr.send(fd);
    });
}
