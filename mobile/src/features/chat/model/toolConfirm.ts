/**
 * The state of one held call — ONE reading, for the card: the port of
 * agent-hub/src/components/chat/MessageItem/toolConfirmStatus.js (pinned by
 * toolConfirm.lockstep.test.ts).
 *
 * A decision can come from two sides. The SERVER sends a new `tool_confirm`
 * with `approved`/`declined`: the turn went past the call, so approved means
 * it RAN. A click in THIS SESSION travels with the next message, so approved
 * means it WILL run. The card says which. A status nobody knows is `unknown`,
 * never `pending` — pending is itself a claim ("this has not run").
 */

import type { PendingToolCall } from './types';

export const CONFIRM_STATUSES = ['pending', 'approved', 'declined', 'unknown'] as const;
export type ConfirmStatus = (typeof CONFIRM_STATUSES)[number];

export interface ConfirmDecision {
    status: ConfirmStatus;
    /** 'server': it happened. 'session': it will. Null while nothing is decided, or nobody knows. */
    by: 'server' | 'session' | null;
}

/** What the server says a call already is, or null while it is still pending. */
function servedDecision(served: string | undefined): ConfirmDecision | null {
    if (!served || served === 'pending') return null;
    if (!(CONFIRM_STATUSES as readonly string[]).includes(served)) return { status: 'unknown', by: null };
    return { status: served as ConfirmStatus, by: served === 'unknown' ? null : 'server' };
}

/** This session's click on a call: by callId first, the arguments' key after. */
function sessionChoice(call: PendingToolCall, decided: Readonly<Record<string, string>>): string | null {
    const callKey = typeof call.callId === 'string' && call.callId ? call.callId : null;
    if (callKey && decided[callKey] !== undefined) return decided[callKey] as string;
    const argsKey = typeof call.argsKey === 'string' && call.argsKey ? call.argsKey : null;
    return argsKey ? (decided[argsKey] ?? null) : null;
}

/** `decided`: this session's clicks, by callId (else argsKey) → 'approve' | 'decline'. */
export function confirmDecisionOf(
    call: PendingToolCall | null | undefined,
    decided: Readonly<Record<string, string>> = {},
): ConfirmDecision {
    if (!call || typeof call !== 'object') return { status: 'unknown', by: null };
    const served = servedDecision(call.status);
    if (served) return served;
    const mine = sessionChoice(call, decided);
    if (mine === 'approve') return { status: 'approved', by: 'session' };
    if (mine === 'decline') return { status: 'declined', by: 'session' };
    return { status: 'pending', by: null };
}
