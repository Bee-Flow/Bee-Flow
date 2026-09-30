/**
 * Template endpoints, under /api/templates.
 *
 * The whole router is behind requireBetaFeature('templates'): it 403s when the
 * flag is off, which is why the screens treat 403 as an explanation rather
 * than a failure (model/availability.ts).
 */

import { api } from '@/core/api/client';
import type { UploadTarget } from '@/features/knowledge';

import { readTemplates } from './readers';
import type { Template } from '../model/types';

export async function listTemplates(signal?: AbortSignal): Promise<Template[]> {
    return readTemplates(await api.get<unknown>('/api/templates', { signal }));
}

export async function deleteTemplate(id: string): Promise<void> {
    await api.delete(`/api/templates/${encodeURIComponent(id)}`);
}

/** The blank .docx, fetched through the session and handed to the share sheet. */
export function templateDownloadPath(id: string): string {
    return `/api/templates/${encodeURIComponent(id)}/download`;
}

/**
 * routes/templates.js — `upload.single('file')`, 20 MB, and the route rejects
 * anything whose name does not end in .docx before it looks at the bytes.
 */
export function templateUploadTarget(extra?: Record<string, string>): UploadTarget {
    return {
        path: '/api/templates/upload',
        field: 'file',
        maxBytes: 20 * 1024 * 1024,
        accepts: 'a Word .docx file',
        ...(extra ? { extra } : {}),
    };
}
