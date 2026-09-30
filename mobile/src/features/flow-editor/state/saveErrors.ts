/**
 * Is a failed save worth sending again?
 *
 * The rule is the client's own (core/api/client.ts): a settled 4xx is an
 * answer — the server read this definition and refused it, and sending the
 * same bytes again gets the same refusal — except 408 and 429, which say
 * "not now". Anything that is not the server's answer at all (offline, a
 * dropped connection, a timeout) and every 5xx may well succeed next time.
 */

import { ApiError } from '@/core/api/client';
import { issueDetailsOf } from '@/features/automations';

import type { FlowIssue } from '../api/types';

export interface SaveFailure {
    kind: 'transient' | 'permanent';
    status: number | null;
    code: string | null;
    /** The refusal's `details` — why the definition was refused. */
    details: FlowIssue[];
}

export function classifySaveError(err: unknown): SaveFailure {
    if (!(err instanceof ApiError) || err.status === undefined) {
        return { kind: 'transient', status: null, code: null, details: [] };
    }
    const status = err.status;
    const transient = status >= 500 || status === 408 || status === 429;
    return {
        kind: transient ? 'transient' : 'permanent',
        status,
        code: err.code ?? null,
        details: issueDetailsOf(err),
    };
}
