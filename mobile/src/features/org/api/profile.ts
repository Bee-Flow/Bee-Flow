/**
 * Organisation Info beyond the record itself: the logo and the default
 * language for new users.
 *
 * Verified against server/auth/admin/orgRoutes.js (POST/DELETE
 * /auth/organizations/:id/logo: multer `single('logo')`, 2 MB, PNG/JPEG/SVG/WebP,
 * answers `{ success, logo }`) and server/routes/admin/languageRoutes.js
 * (GET/PUT /api/languages/org/default: `{ defaultLocale, locales }` in,
 * `{ defaultLocale }` out, a locale the server does not list is a 400).
 */

import { api } from '@/core/api/client';
import { apiUrl } from '@/core/api/server';
import { setAuthHeaders, uploadError } from '@/core/api/xhrUpload';

import { readLogoUpload, readOrgLanguages } from './sectionReaders';
import type { OrgLanguages } from '../model/sectionTypes';

const logoPath = (orgId: string) => `/auth/organizations/${encodeURIComponent(orgId)}/logo`;

/** The server's `limits.fileSize`; checked here so the bytes never leave. */
export const LOGO_MAX_BYTES = 2 * 1024 * 1024;

export interface LogoFile {
    uri: string;
    name: string;
    mimeType: string;
}

/**
 * Upload a new logo. XHR rather than `api.upload`: expo/fetch cannot send a
 * React Native `{ uri, name, type }` part, and XHR streams it from disk.
 * setAuthHeaders adds the SSO token for sign-ins that have no cookie.
 */
export function uploadOrgLogo(orgId: string, file: LogoFile): Promise<{ logo: string | null }> {
    const path = logoPath(orgId);
    return new Promise((resolve, reject) => {
        const form = new FormData();
        form.append('logo', { uri: file.uri, name: file.name, type: file.mimeType } as unknown as Blob);
        const xhr = new XMLHttpRequest();
        xhr.open('POST', apiUrl(path));
        xhr.responseType = 'text';
        xhr.withCredentials = true;
        setAuthHeaders(xhr);
        xhr.onload = () => {
            let body: unknown = null;
            try {
                body = JSON.parse(xhr.responseText) as unknown;
            } catch {
                /* the status speaks for itself */
            }
            if (xhr.status >= 200 && xhr.status < 300) resolve(readLogoUpload(body));
            else reject(uploadError(path, xhr.status, body));
        };
        xhr.onerror = () => reject(uploadError(path, 0, null));
        xhr.send(form);
    });
}

export async function deleteOrgLogo(orgId: string): Promise<void> {
    await api.delete(logoPath(orgId));
}

export async function getOrgLanguages(signal?: AbortSignal): Promise<OrgLanguages> {
    return readOrgLanguages(await api.get<unknown>('/api/languages/org/default', { signal }));
}

export async function setOrgDefaultLanguage(defaultLocale: string): Promise<void> {
    await api.put('/api/languages/org/default', { defaultLocale });
}
