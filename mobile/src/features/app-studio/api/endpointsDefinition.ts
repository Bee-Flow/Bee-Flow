/**
 * The working draft: the CAS save the autosave drives, the read-only
 * pre-flight check, and the publish-snapshot history (server/routes/
 * studioApps.js). All owner-only; a reader gets 403, a stranger 404.
 */

import { api } from '@/core/api/client';
import { field, pick } from '@/core/api/contract';

import { appPath, expectedRefusal } from './paths';
import { readCheck, readDefinition, readIssues, readRepairs, readVersions } from './readersApps';
import type { AppDefinition } from '../core/types';
import type { AppVersion, CheckInput, CheckResult, SaveDefinitionResult } from '../model/apiTypes';

function readRefusal(status: number, body: unknown): SaveDefinitionResult {
    if (status === 409) {
        return {
            outcome: 'conflict',
            currentVersion: field.numOrNull(pick(body, 'currentVersion')),
            definition: readDefinition(pick(body, 'definition')),
        };
    }
    return {
        outcome: 'invalid',
        errors: readIssues(pick(body, 'errors')),
        warnings: readIssues(pick(body, 'warnings')),
    };
}

/**
 * Save the draft against the version the editor loaded. 409 (someone — the AI
 * builder, a restore, another tab — saved in between) and 422 (the draft does
 * not validate) come back as values, because the autosave reconciles or shows
 * them rather than failing. 413 and everything else still throw.
 *
 * Never retried: a save that timed out may have landed and bumped the
 * version, and resending it would only turn into a false conflict.
 */
export async function saveDefinition(
    id: string,
    definition: AppDefinition,
    baseVersion: number,
): Promise<SaveDefinitionResult> {
    try {
        const res = await api.put<unknown>(`${appPath(id)}/definition`, { definition, baseVersion }, { retry: false });
        return {
            outcome: 'saved',
            version: field.num(baseVersion + 1)(pick(res, 'version')),
            warnings: readIssues(pick(res, 'warnings')),
            repairs: readRepairs(pick(res, 'repairs')),
        };
    } catch (err) {
        const refusal = expectedRefusal(err, [409, 422]);
        return readRefusal(refusal.status, refusal.body);
    }
}

/** Pre-flight the SAVED draft, read-only: static + data + role + action passes. */
export async function checkApp(id: string, input: CheckInput = {}): Promise<CheckResult> {
    // A read in effect (the server never mutates here), so it may retry.
    return readCheck(await api.post<unknown>(`${appPath(id)}/check`, input, { retry: {}, timeoutMs: 60_000 }));
}

export async function listVersions(id: string, signal?: AbortSignal): Promise<AppVersion[]> {
    return readVersions(await api.get<unknown>(`${appPath(id)}/versions`, { signal }));
}

/**
 * Put a snapshot back as the working draft. Answers the new draft version;
 * open editors' next CAS save conflicts instead of clobbering the restore.
 */
export async function restoreVersion(id: string, versionId: string): Promise<{ version: number | null }> {
    const res = await api.post<unknown>(`${appPath(id)}/versions/${encodeURIComponent(versionId)}/restore`);
    return { version: field.numOrNull(pick(res, 'version')) };
}
