/** Contract readers for GitHub Sync (model/githubTypes.ts). */

import { field, nullable, pick, shapeOf } from '@/core/api/contract';

import type { GithubPushAll, GithubPushPending, GithubSyncItem, GithubSyncStatus } from '../model/githubTypes';

export const readGithubSyncStatus: (raw: unknown) => GithubSyncStatus = shapeOf({
    configured: field.bool(false),
    githubConnected: field.bool(false),
    config: nullable(
        shapeOf({
            repoOwner: field.str(''),
            repoName: field.str(''),
            branch: field.str('main'),
            autoSync: field.bool(false),
            lastFullSync: field.strOrNull,
        }),
    ),
    overview: nullable(
        shapeOf({ synced: field.num(0), pending: field.num(0), error: field.num(0), total: field.num(0) }),
    ),
});

const readItemFields = shapeOf({
    id: (value: unknown) => (typeof value === 'number' ? String(value) : field.str('')(value)),
    resource_type: field.str(''),
    resource_id: field.str(''),
    sync_status: field.str(''),
    last_synced_at: field.strOrNull,
    error_message: field.strOrNull,
});

/** The details list is the table's rows, snake_case as stored. */
export function readGithubSyncItems(raw: unknown): GithubSyncItem[] {
    if (!Array.isArray(raw)) return [];
    return raw
        .map(readItemFields)
        .map((r) => ({
            id: r.id || `${r.resource_type}:${r.resource_id}`,
            resourceType: r.resource_type,
            resourceId: r.resource_id,
            status: r.sync_status,
            lastSyncedAt: r.last_synced_at,
            errorMessage: r.error_message,
        }))
        .filter((r) => r.resourceId);
}

const count = (raw: unknown, key: string) => field.num(0)(pick(raw, key));

export function readPushAll(raw: unknown): GithubPushAll {
    const results = pick(raw, 'results');
    const kind = (name: string) => ({ pushed: count(pick(results, name), 'pushed'), skipped: count(pick(results, name), 'skipped') });
    return { agents: kind('agents'), skills: kind('skills') };
}

export function readPushPending(raw: unknown): GithubPushPending {
    const results = pick(raw, 'results');
    return { pushed: count(results, 'pushed'), errors: count(results, 'errors') };
}
