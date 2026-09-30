/**
 * The owner's side of an app's data: the data model (CAS), saved datasets and
 * role members (server/routes/studioAppData.js). Owner-only: a reader gets
 * 403, a stranger 404.
 */

import { api } from '@/core/api/client';
import { field, pick } from '@/core/api/contract';

import { appPath, expectedRefusal } from './paths';
import { readDatasets, readMembers, readSchema } from './readersData';
import type { OpenRecord } from '../model/apiTypes';
import type { AppDataset, AppMember, AppSchema, SaveSchemaResult } from '../model/runtimeTypes';

export async function getSchema(appId: string, signal?: AbortSignal): Promise<AppSchema> {
    return readSchema(await api.get<unknown>(`${appPath(appId)}/schema`, { signal }));
}

function readSchemaRefusal(status: number, body: unknown): SaveSchemaResult {
    if (status === 409) {
        return {
            outcome: 'conflict',
            currentVersion: field.numOrNull(pick(body, 'currentVersion')),
            model: field.recordOrNull<OpenRecord>(pick(body, 'model')),
        };
    }
    // The schema route's 422 lists plain sentences, not issue objects.
    return { outcome: 'invalid', errors: field.strArray(pick(body, 'errors')) };
}

/**
 * Save the data model against the version the editor loaded (`null` = an
 * unconditional write, for a model that does not exist yet). 409 and 422 are
 * returned as values, like the definition save.
 */
export async function saveSchema(
    appId: string,
    model: OpenRecord,
    expectedVersion: number | null,
): Promise<SaveSchemaResult> {
    try {
        const res = await api.put<unknown>(`${appPath(appId)}/schema`, { model, expectedVersion }, { retry: false });
        return { outcome: 'saved', version: field.num(0)(pick(res, 'version')) };
    } catch (err) {
        const refusal = expectedRefusal(err, [409, 422]);
        return readSchemaRefusal(refusal.status, refusal.body);
    }
}

export async function listDatasets(appId: string, signal?: AbortSignal): Promise<AppDataset[]> {
    return readDatasets(await api.get<unknown>(`${appPath(appId)}/datasets`, { signal }));
}

export async function listMembers(appId: string, signal?: AbortSignal): Promise<AppMember[]> {
    return readMembers(await api.get<unknown>(`${appPath(appId)}/members`, { signal }));
}

/** Assign a role. 422 `invalid_role` (with `validRoles`) for a role the model lacks. */
export async function addMember(appId: string, userId: string, roleKey?: string): Promise<void> {
    await api.post<unknown>(`${appPath(appId)}/members`, { userId, ...(roleKey ? { roleKey } : {}) });
}

export async function removeMember(appId: string, userId: string): Promise<void> {
    await api.delete<unknown>(`${appPath(appId)}/members/${encodeURIComponent(userId)}`);
}
