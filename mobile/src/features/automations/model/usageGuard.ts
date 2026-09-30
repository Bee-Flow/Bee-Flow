/**
 * A routine's "used by" answer (GET /api/automation/:id/usage) as the shared
 * delete guard reads one, so deleting a routine asks the same question, in
 * the same sheet (ui/GuardedDeleteSheet), as deleting a webpage or a skill:
 * what starts failing, and whether the list is complete.
 *
 * The routine's DELETE does not refuse on its own, so the phone asks first
 * and always shows the answer: an app button that calls a deleted routine
 * breaks silently. `complete: false` (the index has not seen every app yet)
 * and a failed read both say "not everything could be checked" — never
 * "nothing uses this".
 */

import type { DeleteGuard } from '@/core/api/deleteGuard';

import type { AutomationUsage } from './types';

export function usageGuard(usage: AutomationUsage | null | undefined, failed: boolean): DeleteGuard {
    if (failed || !usage) return { blocked: true, usage: [], unchecked: ['app'], readable: false };
    return {
        blocked: true,
        usage: usage.usage.map((row) => ({
            kind: row.consumerKind || 'app',
            id: row.consumerId,
            title: row.consumerTitle,
            siteLabel: row.label ?? row.screenId,
        })),
        unchecked: usage.complete ? [] : ['app'],
        readable: true,
    };
}
