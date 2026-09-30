/**
 * A routine's saved versions (routes/automation/versions.js). None of these
 * routes reads a query, and the restore reads no body: the version is in the
 * path and nothing else about it is negotiable.
 *
 * A RESTORE IS A SAVE: the server validates the old definition again (a
 * version whose step types or tools have since gone answers 400 with
 * `details`), re-derives the trigger columns, and stamps a NEW version.
 */

import { api } from '@/core/api/client';

import { flowPath } from './definition';
import { readRestoreResult } from './readers';
import type { FlowVersion, FlowVersionDiff, FlowVersionSummary, RestoreResult } from './types';
import { readVersionDiff, readVersionList, readVersionResponse } from './versionReaders';

const versionPath = (id: string, versionId: string) => `${flowPath(id)}/versions/${encodeURIComponent(versionId)}`;

export async function listVersions(id: string, signal?: AbortSignal): Promise<FlowVersionSummary[]> {
    return readVersionList(await api.get<unknown>(`${flowPath(id)}/versions`, { signal }));
}

export async function getVersion(id: string, versionId: string, signal?: AbortSignal): Promise<FlowVersion | null> {
    return readVersionResponse(await api.get<unknown>(versionPath(id, versionId), { signal }));
}

/** Both definitions and a coarse summary; the line-level diff is the client's to draw. */
export async function diffVersions(id: string, a: string, b: string, signal?: AbortSignal): Promise<FlowVersionDiff> {
    return readVersionDiff(await api.get<unknown>(`${versionPath(id, a)}/diff/${encodeURIComponent(b)}`, { signal }));
}

export async function restoreVersion(id: string, versionId: string): Promise<RestoreResult> {
    return readRestoreResult(await api.post<unknown>(`${versionPath(id, versionId)}/restore`, undefined, { retry: false }));
}
