/** Support thread states and authors, in the words a requester reads. */

import { translate } from '@/core/i18n';
import { humanise } from '@/shared/lib/display';

export type StatusTone = 'neutral' | 'accent' | 'success' | 'warning';

/** The statuses `support_threads.status` is constrained to, in words. */
const STATUS_COPY: Record<string, { i18nKey: string; en: string; tone: StatusTone }> = {
    open: { i18nKey: 'support.status.open', en: 'Open', tone: 'warning' },
    ai_responding: { i18nKey: 'mobile.support.status_ai', en: 'Bee Flow is answering', tone: 'accent' },
    awaiting_user: { i18nKey: 'mobile.support.status_waiting', en: 'Waiting for you', tone: 'warning' },
    awaiting_agent: { i18nKey: 'mobile.support.status_with_support', en: 'With support', tone: 'accent' },
    resolved: { i18nKey: 'support.status.resolved', en: 'Resolved', tone: 'success' },
    closed: { i18nKey: 'support.status.closed', en: 'Closed', tone: 'neutral' },
};

/** A status's label and badge tone; an unknown one is humanised, neutral. */
export function statusCopy(status: string): { label: string; tone: StatusTone } {
    const known = STATUS_COPY[status];
    if (known) return { label: translate(known.i18nKey, known.en), tone: known.tone };
    return { label: humanise(status), tone: 'neutral' };
}

/** Resolved and closed threads take no more replies. */
export function isFinished(status: string | undefined): boolean {
    return status === 'closed' || status === 'resolved';
}

/** 'ai' is Bee Flow's own responder; 'staff' is a person at Bee Flow. */
export function authorName(kind: string, display: string | null | undefined): string {
    if (kind === 'ai') return 'Bee Flow';
    if (kind === 'system') return translate('mobile.support.author_system', 'System');
    return (
        display ||
        (kind === 'staff'
            ? translate('mobile.support.author_staff', 'Bee Flow Support')
            : translate('mobile.support.author_you', 'You'))
    );
}
