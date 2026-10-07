import React, { useState } from 'react';
import useTranslation from '../../../hooks/useTranslation';
import scopedStorage from '../../../utils/scopedStorage';
import { formatNoticeDate, type NoticeModel } from './chatSignalsModel';

/**
 * A one-time banner above the chat-signals line, once per version: a new
 * version (a widened configuration) shows it again.
 *
 * The dismissal is a convenience kept in the person's own scoped storage,
 * never a condition: the line under the composer is the notice and does not
 * read storage at all, so a blocked or full storage only means the banner
 * comes back.
 */

export const BANNER_SEEN_KEY = 'chatSignalsBannerSeen';

function readSeen(): string | null {
    try {
        return scopedStorage.getItem(BANNER_SEEN_KEY);
    } catch {
        return null;
    }
}

function writeSeen(version: string): void {
    try {
        scopedStorage.setItem(BANNER_SEEN_KEY, version);
    } catch {
        /* the banner simply shows again next time */
    }
}

export default function MonitoringBanner({ notice }: { notice: NoticeModel | null }) {
    const { t, resolvedLocale } = useTranslation();
    const [seen, setSeen] = useState<string | null>(readSeen);
    if (!notice || seen === notice.version) return null;

    const dismiss = () => {
        writeSeen(notice.version);
        setSeen(notice.version);
    };
    const title = notice.state === 'scheduled'
        ? t('chat_monitoring.chat.banner_title_scheduled', 'Chat signals start on {date}', { date: formatNoticeDate(notice.from, resolvedLocale) })
        : t('chat_monitoring.chat.banner_title_on', 'Chat signals are on');

    return (
        <div
            role="note"
            data-testid="chat-signals-banner"
            className="mb-1.5 flex items-start gap-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-3 py-2 text-left select-text"
        >
            <div className="min-w-0 flex-1">
                <p className="m-0 text-[12px] font-semibold text-[var(--text-primary)]">{title}</p>
                <p className="m-0 mt-0.5 text-[11px] leading-snug text-[var(--text-secondary)]">
                    {t('chat_monitoring.chat.banner_body', 'Your organisation checks whether the Privacy Shield works by counting how it handled messages in this chat. The count does not keep what you wrote or who wrote it. You can choose not to be counted.')}
                </p>
            </div>
            <button
                type="button"
                onClick={dismiss}
                className="shrink-0 rounded-md border border-[var(--border-default)] px-2 py-1 text-[11px] font-medium text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                data-testid="chat-signals-banner-dismiss"
            >
                {t('chat_monitoring.chat.dismiss', 'Got it')}
            </button>
        </div>
    );
}
