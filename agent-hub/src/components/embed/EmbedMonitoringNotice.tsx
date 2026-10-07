import React, { useId } from 'react';
import type { EmbedComplianceNotice } from '../../api/queries/chatSignals';
import useTranslation, { type TranslateFn } from '../../hooks/useTranslation';
import { formatNoticeDate } from '../chat/chatSignals/chatSignalsModel';

/**
 * What the embed tells a website visitor when the organisation counts how
 * the Privacy Shield handled messages here: the line, a link to its privacy
 * notice, and "Don't count my messages".
 *
 * The switch lives in React state only, for this page view: no
 * localStorage, sessionStorage or cookie, because storing anything on a
 * visitor's device for this would itself need consent. A reload shows the
 * notice again with the switch off.
 */

export interface EmbedMonitoringNoticeProps {
    notice: EmbedComplianceNotice;
    dontCount: boolean;
    onDontCountChange: (next: boolean) => void;
    /** The one-line form above the composer, once the conversation has started. */
    compact?: boolean;
}

function lineText(t: TranslateFn, notice: EmbedComplianceNotice, date: string): string {
    if (notice.state === 'scheduled') {
        return t('chat_monitoring.embed.scheduled', 'From {date}, this chat counts how the Privacy Shield handled personal data in messages. No message content is kept for this.', { date });
    }
    return notice.signals.includes('kinds')
        ? t('chat_monitoring.embed.line_kinds', 'This chat counts how the Privacy Shield handled personal data in messages, and which kinds it found. No message content is kept for this.')
        : t('chat_monitoring.embed.line', 'This chat counts how the Privacy Shield handled personal data in messages. No message content is kept for this.');
}

export default function EmbedMonitoringNotice({ notice, dontCount, onDontCountChange, compact = false }: EmbedMonitoringNoticeProps) {
    const { t, resolvedLocale } = useTranslation();
    const checkboxId = useId();
    if (notice.state === 'off') return null;

    return (
        <div
            role="note"
            data-testid="embed-monitoring-notice"
            className={compact
                ? 'mx-auto w-full max-w-3xl px-4 pb-1 text-[10px] leading-snug text-[var(--text-tertiary)]'
                : 'mx-auto mb-3 max-w-xl rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-3 py-2 text-[11px] leading-snug text-[var(--text-secondary)]'}
        >
            <span>{lineText(t, notice, formatNoticeDate(notice.from, resolvedLocale))}</span>
            {notice.privacyNoticeUrl && (
                <>
                    {' '}
                    <a
                        href={notice.privacyNoticeUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline underline-offset-2 hover:text-[var(--text-primary)]"
                        data-testid="embed-privacy-link"
                    >
                        {t('chat_monitoring.embed.privacy_link', 'Privacy notice')}
                    </a>
                </>
            )}
            <span className={compact ? 'ml-2 inline-flex items-center gap-1' : 'mt-1.5 flex items-center gap-1.5'}>
                <input
                    id={checkboxId}
                    type="checkbox"
                    checked={dontCount}
                    onChange={(e) => onDontCountChange(e.target.checked)}
                    data-testid="embed-dont-count"
                />
                <label htmlFor={checkboxId} className="cursor-pointer">
                    {t('chat_monitoring.embed.dont_count', "Don't count my messages")}
                </label>
            </span>
        </div>
    );
}
