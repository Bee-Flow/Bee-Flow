/**
 * Edits a phone may make to a flow definition, and what the server says when
 * it refuses one.
 */

import { ApiError } from '@/core/api/client';

import type { AutomationDefinition } from './types';

/**
 * Patch a schedule trigger's cron onto a definition without mutating it.
 *
 * The DEFINITION carries the schedule; routes/automation/crud.js derives the
 * `scheduleCron` columns from it on every save. See updateAutomation() in
 * api/endpoints.ts for why the column alone must not be written.
 */
export function withSchedule(
    definition: AutomationDefinition,
    cron: string,
    tz: string,
): AutomationDefinition {
    return {
        ...definition,
        trigger: {
            ...(definition.trigger ?? {}),
            kind: 'schedule',
            schedule: { cron, tz },
        },
    };
}

/** One `details` entry: a bare sentence, or an object with a `message`. */
function detailLine(entry: unknown): string | null {
    if (typeof entry === 'string') return entry;
    const message = (entry as { message?: unknown } | null)?.message;
    return typeof message === 'string' ? message : null;
}

/**
 * The `details` array a strict activation refusal carries. Without it the user
 * sees "Invalid definition" and has no idea which step is the problem.
 */
export function activationDetails(error: unknown): string[] {
    if (!(error instanceof ApiError)) return [];
    const body = error.body as { details?: unknown } | null;
    if (!body || !Array.isArray(body.details)) return [];
    return body.details
        .map(detailLine)
        .filter((line): line is string => Boolean(line))
        .slice(0, 6);
}
