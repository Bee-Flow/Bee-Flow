/**
 * What a failed Graph probe means in a diagnostics report.
 *
 * The input is what the pipeline's own functions throw (teamsCalendar via
 * msGraphClient graphFetch: `graphStatus`; teamsArtifacts: a stable `.code`;
 * msGraphClient: a bare `NOT_CONNECTED` when the grant is gone), so the test
 * fails exactly where an import would. Both the codes of today and the ones
 * the import pipeline gains in this round are handled. The error message is
 * never copied into the report.
 */

import type { Outcome } from './checks.mts';

export type GraphContext = 'calendar' | 'meeting' | 'app';

type GraphErrorLike = { message?: unknown; code?: unknown; graphStatus?: unknown } | null | undefined;

const THROTTLED = new Set([429, 503, 504]);

function statusOf(err: GraphErrorLike): number | null {
    const n = Number(err?.graphStatus);
    return Number.isInteger(n) && n > 0 ? n : null;
}

/** Outcomes decided by the stable `.code` the pipeline attaches. */
function byCode(code: string, app: boolean): Outcome | null {
    switch (code) {
        case 'needs_teams_scopes':
            return { status: 'fail', code: 'needs_teams_scopes', fix: app ? 'grant_application_permission' : 'admin_consent_needed', fixer: 'entra_admin' };
        case 'transcript_access_disabled':
            return { status: 'warn', code: 'transcript_api_disabled', fix: 'enable_transcript_api', fixer: 'teams_admin' };
        case 'speaker_attribution_disabled':
            return { status: 'warn', code: 'speaker_attribution_off', fix: 'enable_speaker_attribution', fixer: 'teams_admin' };
        case 'application_access_policy_missing':
            return { status: 'fail', code: 'application_access_policy_missing', fix: 'grant_access_policy', fixer: 'teams_admin' };
        // The remedy is the account's Teams licence and the Teams meeting
        // policies, a Teams administrator's work, not an Entra app consent.
        case 'graph_forbidden':
        case 'not_organizer':
            return { status: 'fail', code: 'graph_forbidden', fix: 'graph_forbidden', fixer: 'teams_admin' };
        case 'not_found':
        case 'meeting_not_available':
            return { status: 'fail', code: 'meeting_not_available', fix: 'meeting_not_available', fixer: 'user' };
        case 'graph_throttled':
            return { status: 'warn', code: 'graph_throttled', fix: 'try_again_later', fixer: 'user' };
        default:
            return null;
    }
}

function calendarForbidden(app: boolean): Outcome {
    return { status: 'fail', code: 'calendar_forbidden', fix: app ? 'calendar_application_access' : 'calendar_access', fixer: 'entra_admin' };
}

/**
 * The HTTP-status rows, in table order after the code rows. A 403 without a
 * code only comes from a calendar listing (the artifact calls always attach
 * one), so it reads as the calendar refusal there and in option B's probes.
 */
function byStatus(code: string, httpStatus: number | null, context: GraphContext): Outcome | null {
    if (httpStatus !== null && THROTTLED.has(httpStatus)) return { status: 'warn', code: 'graph_throttled', fix: 'try_again_later', fixer: 'user' };
    if (httpStatus === 401) return { status: 'fail', code: 'needs_reauth', fix: 'reconnect_microsoft', fixer: 'user' };
    if ((httpStatus === 403 && context !== 'meeting') || code === 'calendar_forbidden') return calendarForbidden(context === 'app');
    if (code === 'failed' || code === 'graph_unavailable' || httpStatus !== null) {
        return { status: 'fail', code: 'graph_unavailable', params: { httpStatus: httpStatus ?? 0 }, fix: 'try_again_later', fixer: 'user' };
    }
    return null;
}

/** The report outcome of an error a Graph probe threw (first matching row wins). */
export function fromGraphError(err: unknown, { context }: { context: GraphContext }): Outcome {
    const e = err as GraphErrorLike;
    const app = context === 'app';
    const code = typeof e?.code === 'string' ? e.code : '';
    if (!code && e?.message === 'NOT_CONNECTED') {
        return { status: 'fail', code: 'needs_reauth', fix: app ? 'see_microsoft_error' : 'reconnect_microsoft', fixer: app ? 'org_admin' : 'user' };
    }
    return byCode(code, app)
        || byStatus(code, statusOf(e), context)
        || { status: 'fail', code: 'graph_error', fix: 'try_again_later', fixer: 'user' };
}
