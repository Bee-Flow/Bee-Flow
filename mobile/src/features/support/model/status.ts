/** Support thread states and authors, in the words a requester reads. */

import { humanise } from '@/shared/lib/display';

export type StatusTone = 'neutral' | 'accent' | 'success' | 'warning';

/** The statuses `support_threads.status` is constrained to, in words. */
const STATUS_COPY: Record<string, { label: string; tone: StatusTone }> = {
    open: { label: 'Open', tone: 'warning' },
    ai_responding: { label: 'Bee Flow is answering', tone: 'accent' },
    awaiting_user: { label: 'Waiting for you', tone: 'warning' },
    awaiting_agent: { label: 'With support', tone: 'accent' },
    resolved: { label: 'Resolved', tone: 'success' },
    closed: { label: 'Closed', tone: 'neutral' },
};

/** A status's label and badge tone; an unknown one is humanised, neutral. */
export function statusCopy(status: string): { label: string; tone: StatusTone } {
    return STATUS_COPY[status] ?? { label: humanise(status), tone: 'neutral' };
}

/** Resolved and closed threads take no more replies. */
export function isFinished(status: string | undefined): boolean {
    return status === 'closed' || status === 'resolved';
}

/** 'ai' is Bee Flow's own responder; 'staff' is a person at Bee Flow. */
export function authorName(kind: string, display: string | null | undefined): string {
    if (kind === 'ai') return 'Bee Flow';
    if (kind === 'system') return 'System';
    return display || (kind === 'staff' ? 'Bee Flow Support' : 'You');
}
