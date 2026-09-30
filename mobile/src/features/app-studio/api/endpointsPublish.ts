/**
 * Who can reach an app: the publish toggle with its audience, the groups the
 * audience picker offers, and the anonymous public pages
 * (server/routes/studioApps.js).
 */

import { api } from '@/core/api/client';

import { appPath, expectedRefusal } from './paths';
import {
    readCreatedPublicPage,
    readInvalid,
    readPublicPages,
    readPublished,
    readPublishGroups,
} from './readersRuntime';
import type {
    CreatedPublicPage,
    PublicPagesState,
    PublishGroup,
    PublishInput,
    PublishResult,
} from '../model/runtimeTypes';

/**
 * Publish (freezes the current draft) or unpublish. A draft that does not
 * validate answers 422 with the issue list, returned as `outcome: 'invalid'`
 * so the sheet can show what to fix. 400s (unknown group, groups across
 * organisations) and 403 (not the owner) throw.
 */
export async function publishApp(id: string, input: PublishInput): Promise<PublishResult> {
    try {
        return readPublished(await api.patch<unknown>(`${appPath(id)}/publish`, input, { retry: false }));
    } catch (err) {
        return { outcome: 'invalid', ...readInvalid(expectedRefusal(err, [422]).body) };
    }
}

/**
 * The groups a publish may target: the same `GET /auth/groups` the web's
 * PublishModal reads through useOrgDirectory. It needs directory access, so a
 * 403 is an expected answer — the caller then offers "entire organisation"
 * only — and it is never retried.
 */
export async function listPublishGroups(signal?: AbortSignal): Promise<PublishGroup[]> {
    return readPublishGroups(await api.get<unknown>('/auth/groups', { signal, retry: false }));
}

export async function listPublicPages(id: string, signal?: AbortSignal): Promise<PublicPagesState> {
    return readPublicPages(await api.get<unknown>(`${appPath(id)}/public-pages`, { signal }));
}

/** Mint an anonymous URL. 409 at the per-app ceiling (3): revoke one first. */
export async function createPublicPage(id: string): Promise<CreatedPublicPage> {
    return readCreatedPublicPage(await api.post<unknown>(`${appPath(id)}/public-pages`, undefined, { retry: false }));
}

export async function deletePublicPage(id: string, token: string): Promise<void> {
    await api.delete<unknown>(`${appPath(id)}/public-pages/${encodeURIComponent(token)}`);
}
