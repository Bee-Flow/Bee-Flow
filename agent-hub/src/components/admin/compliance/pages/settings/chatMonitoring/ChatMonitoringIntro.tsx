import { Scale } from 'lucide-react';
import React from 'react';
import { useTranslation } from '../../../../../../hooks/useTranslation';

/**
 * The fixed framing of chat signals: what they are for (checking the
 * Privacy Shield, never people), what is never kept, that messages between
 * people are never counted, and the legal caveat. Shown in the off state
 * and again at the top of the set-up form, so nobody switches this on
 * without having read it.
 */

export function LegalCaveat() {
    const { t } = useTranslation();
    return (
        <div
            role="note"
            className="flex items-start gap-2 rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-tertiary)] px-3 py-2 text-[11px] leading-relaxed text-[var(--text-secondary)]"
            data-testid="cm-caveat"
        >
            <Scale size={13} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--text-tertiary)]" />
            <span>
                {t('chat_monitoring.legal_caveat', 'Chat signals help you check whether the Privacy Shield works. This is not legal advice. Your organisation is the controller, so you decide whether you may switch this on and on which legal basis. You carry out the DPIA, get works-council consent where it applies, and tell people before counting starts. Totals can still point to individuals in small teams, so figures from fewer than 5 people (10 for kinds of data) are hidden. Health data is never counted. Check with your DPO or a lawyer before you switch this on.')}
            </span>
        </div>
    );
}

export function NeverKept() {
    const { t } = useTranslation();
    return (
        <div className="flex flex-col gap-1" data-testid="cm-never-kept">
            <span className="text-[10px] uppercase tracking-[.08em] font-semibold text-[var(--text-tertiary)]">
                {t('chat_monitoring.never_kept_title', 'Never kept')}
            </span>
            <ul className="m-0 pl-4 list-disc text-xs text-[var(--text-secondary)] flex flex-col gap-0.5">
                <li>{t('chat_monitoring.never_kept_text', 'What anyone wrote')}</li>
                <li>{t('chat_monitoring.never_kept_values', 'The personal data that was found')}</li>
                <li>{t('chat_monitoring.never_kept_ids', 'Who wrote it: no user, conversation or agent')}</li>
                <li>{t('chat_monitoring.never_kept_per_person', 'Figures per person, per agent or per conversation')}</li>
                <li>{t('chat_monitoring.never_kept_health', 'Health data, in any form')}</li>
            </ul>
        </div>
    );
}

export default function ChatMonitoringIntro() {
    const { t } = useTranslation();
    return (
        <div className="flex flex-col gap-2.5" data-testid="cm-intro">
            <p className="m-0 text-xs text-[var(--text-secondary)]">
                {t('chat_monitoring.purpose', 'Check whether the Privacy Shield works in chat: per chat type, count how it handled each message, and optionally which kinds of personal data it found.')}
            </p>
            <p className="m-0 text-xs text-[var(--text-secondary)]" data-testid="cm-not-people">
                {t('chat_monitoring.not_people', 'This measures the Privacy Shield, not people. It is never used to evaluate employees, their performance, absence or health.')}
            </p>
            <NeverKept />
            <p className="m-0 text-xs font-medium text-[var(--text-primary)]" data-testid="cm-h2h">
                {t('chat_monitoring.h2h_line', 'Messages between people are never counted.')}
            </p>
            <LegalCaveat />
        </div>
    );
}
