/**
 * Shared bits of the App Studio endpoints: the mount, one app's path, and the
 * one way an expected refusal (a 409 conflict, a 422 issue list) becomes a
 * value instead of a throw.
 */

import { ApiError, type QueryParams } from '@/core/api/client';

/** server/index.js mounts every studio router here (behind app_studio). */
export const STUDIO_BASE = '/api/studio-apps';

export const appPath = (id: string): string => `${STUDIO_BASE}/${encodeURIComponent(id)}`;

/** `?draft=1` for the owner's working draft, nothing otherwise. */
export function draftQuery(draft: boolean | undefined): QueryParams | undefined {
    return draft ? { draft: 1 } : undefined;
}

/**
 * The body of a refusal the caller expects, or rethrow. `api.*` throws an
 * ApiError carrying the parsed body; the handful of statuses a flow is built
 * around (the autosave's 409, publish's 422) are answers, the rest are errors.
 */
export function expectedRefusal(err: unknown, statuses: readonly number[]): { status: number; body: unknown } {
    if (err instanceof ApiError && err.status !== undefined && statuses.includes(err.status)) {
        return { status: err.status, body: err.body };
    }
    throw err;
}
