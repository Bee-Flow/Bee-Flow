/**
 * Building a page: its knowledge sources (routes/webpages/sources.js), its
 * version history (versions.js) and the builder chat's stored history
 * (chat.js). Every route here is owner-only; the server answers 404 to an
 * org viewer, so the screens do not offer them.
 */

import { api } from '@/core/api/client';
import { pick } from '@/core/api/contract';
import type { UploadTarget } from '@/features/knowledge';

import { readFiles, readSource, readSources, readVersionPage } from './buildReaders';
import { pagePath } from './endpoints';
import type { VersionPage, WebpageFiles, WebpageSource } from '../model/buildTypes';

const sourcesPath = (id: string) => `${pagePath(id)}/sources`;
const sourcePath = (id: string, sourceId: string) => `${sourcesPath(id)}/${encodeURIComponent(sourceId)}`;
const versionsPath = (id: string) => `${pagePath(id)}/versions`;
const versionPath = (id: string, versionId: string) => `${versionsPath(id)}/${encodeURIComponent(versionId)}`;

// ── Sources ──────────────────────────────────────────────────────────────

export async function listSources(id: string, signal?: AbortSignal): Promise<WebpageSource[]> {
    return readSources(await api.get<unknown>(sourcesPath(id), { signal }));
}

/**
 * Where a picked file goes: `upload.single('file')` under the router's 50 MB
 * multer limit. The server answers at once and reads the file afterwards, so
 * the new source arrives as `processing`.
 */
export function sourceUploadTarget(id: string): UploadTarget {
    return {
        path: `${sourcesPath(id)}/file`,
        field: 'file',
        maxBytes: 50 * 1024 * 1024,
        accepts: 'PDF, Word, Excel, CSV or text',
    };
}

/** A public web address; a private or local one is refused with a 400 that says so. */
export async function addUrlSource(id: string, url: string): Promise<WebpageSource> {
    return readSource(pick(await api.post<unknown>(`${sourcesPath(id)}/url`, { url: url.trim() }), 'source'));
}

export async function addTextSource(id: string, text: string, name?: string): Promise<WebpageSource> {
    const body = { text, ...(name?.trim() ? { name: name.trim() } : {}) };
    return readSource(pick(await api.post<unknown>(`${sourcesPath(id)}/text`, body), 'source'));
}

/** Only a url source or an uploaded file can be read again (see canRetrySource). */
export async function retrySource(id: string, sourceId: string): Promise<void> {
    await api.post(`${sourcePath(id, sourceId)}/retry`);
}

/** Marks a stuck source as failed ("Cancelled by user"); the reading itself is not interrupted. */
export async function cancelSource(id: string, sourceId: string): Promise<void> {
    await api.post(`${sourcePath(id, sourceId)}/cancel`);
}

export async function deleteSource(id: string, sourceId: string): Promise<void> {
    await api.delete(sourcePath(id, sourceId));
}

// ── Versions ─────────────────────────────────────────────────────────────

export const VERSION_PAGE_SIZE = 50;

export async function listVersions(id: string, offset = 0, signal?: AbortSignal): Promise<VersionPage> {
    const query = { limit: VERSION_PAGE_SIZE, offset };
    return readVersionPage(await api.get<unknown>(versionsPath(id), { signal, query }));
}

/** A manual snapshot. The server refuses an empty page with a 400. */
export async function createVersion(id: string, summary?: string): Promise<void> {
    await api.post(versionsPath(id), summary?.trim() ? { summary: summary.trim() } : {});
}

/**
 * Put a snapshot back. The server first snapshots what is there now, so a
 * restore can itself be undone; the answer carries the restored bodies.
 */
export async function restoreVersion(id: string, versionId: string): Promise<WebpageFiles> {
    return readFiles(await api.post<unknown>(`${versionPath(id, versionId)}/restore`));
}

export async function deleteVersion(id: string, versionId: string): Promise<void> {
    await api.delete(versionPath(id, versionId));
}

// ── The builder chat ─────────────────────────────────────────────────────

/**
 * Store the whole transcript. `messages` is required on the server because
 * a PUT without it used to save an empty list over the history; clearing is
 * DELETE. Rows are sent as the web wrote them (see model/chat.ts toStored).
 */
export async function saveChat(id: string, messages: Record<string, unknown>[]): Promise<void> {
    await api.put(`${pagePath(id)}/chat`, { messages });
}

export async function clearChat(id: string): Promise<void> {
    await api.delete(`${pagePath(id)}/chat`);
}
