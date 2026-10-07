import React, { useState } from 'react';
import useTranslation, { type TranslateFn } from '../../../hooks/useTranslation';
import { formatNoticeDate, lineKey, type NoticeModel } from './chatSignalsModel';

/**
 * The chat-signals line under the composer, on every width: what the
 * organisation counts here, a link to its own notice, and the person's
 * "Don't count my chat turns" switch.
 *
 * A sibling of the composer footer, never inside it, so the footer keeps
 * saying exactly what it said. Neutral on purpose: tertiary text, no green
 * and no lock, because this line announces a measurement, not a protection.
 * It claims only what chat signals do (no message text, no author in the
 * count); the Privacy Shield's own per-user log is the notice's business.
 */

export interface MonitoringNoticeProps {
    notice: NoticeModel | null;
    /** Saves the person's choice; rejects when it could not be saved. Omitted: no switch. */
    onCounted?: ((counted: boolean) => Promise<void> | void) | null;
    compact?: boolean;
}

function lineText(t: TranslateFn, notice: NoticeModel, date: string): string {
    switch (lineKey(notice)) {
        case 'chat_monitoring.chat.line_kinds':
            return t('chat_monitoring.chat.line_kinds', 'Your organisation counts how the Privacy Shield handled messages here, and which kinds of personal data it found. The count does not keep what you wrote or who wrote it.');
        case 'chat_monitoring.chat.scheduled':
            return t('chat_monitoring.chat.scheduled', 'From {date}, your organisation counts how the Privacy Shield handled messages here. The count does not keep what you wrote or who wrote it.', { date });
        case 'chat_monitoring.chat.scheduled_kinds':
            return t('chat_monitoring.chat.scheduled_kinds', 'From {date}, your organisation counts how the Privacy Shield handled messages here, and which kinds of personal data it found. The count does not keep what you wrote or who wrote it.', { date });
        default:
            return t('chat_monitoring.chat.line', 'Your organisation counts how the Privacy Shield handled messages here. The count does not keep what you wrote or who wrote it.');
    }
}

const LINK_CLASS = 'underline underline-offset-2 text-[var(--text-secondary)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] rounded-sm';

export default function MonitoringNotice({ notice, onCounted = null, compact = false }: MonitoringNoticeProps) {
    const { t, resolvedLocale } = useTranslation();
    const [busy, setBusy] = useState(false);
    const [failed, setFailed] = useState(false);
    if (!notice) return null;

    const toggle = async () => {
        if (!onCounted || busy) return;
        setBusy(true);
        setFailed(false);
        try {
            await onCounted(notice.optedOut);
        } catch {
            setFailed(true);
        } finally {
            setBusy(false);
        }
    };

    return (
        <p
            data-testid="chat-signals-line"
            data-state={notice.state}
            className={`m-0 mb-0.5 text-[var(--text-tertiary)] ${compact ? 'text-[9px] leading-tight' : 'text-[10px] leading-snug'}`}
        >
            <span>
                {notice.optedOut
                    ? t('chat_monitoring.chat.not_counted', 'Your chat turns are not counted.')
                    : lineText(t, notice, formatNoticeDate(notice.from, resolvedLocale))}
            </span>
            {notice.noticeUrl && (
                <>
                    {' '}
                    <a href={notice.noticeUrl} target="_blank" rel="noopener noreferrer" className={LINK_CLASS} data-testid="chat-signals-notice-link">
                        {t('chat_monitoring.chat.notice_link', 'Notice')}
                    </a>
                </>
            )}
            {onCounted && (
                <>
                    <span className="mx-1.5" aria-hidden="true">·</span>
                    <button type="button" onClick={toggle} disabled={busy} className={`${LINK_CLASS} disabled:opacity-60`} data-testid="chat-signals-toggle">
                        {notice.optedOut
                            ? t('chat_monitoring.chat.count_again', 'Count them again')
                            : t('chat_monitoring.chat.dont_count', "Don't count my chat turns")}
                    </button>
                </>
            )}
            {failed && (
                <span role="alert" className="block text-[var(--text-secondary)]" data-testid="chat-signals-error">
                    {t('chat_monitoring.chat.pref_error', 'Could not save your choice. Try again.')}
                </span>
            )}
        </p>
    );
}
