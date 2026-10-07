import { Check, Copy } from 'lucide-react';
import React from 'react';
import useCopyToClipboard from '../../../../../../hooks/useCopyToClipboard';
import { useTranslation, type TranslateFn } from '../../../../../../hooks/useTranslation';
import type { ChatMonitoringConfig } from '../../../data/useChatMonitoring';
import { formatNoticeDate } from '../../../../../chat/chatSignals/chatSignalsModel';
import { ActionButton } from './formAtoms';
import type { ChatMonitoringForm } from './chatMonitoringForm';
import { legalBasisLabel, surfaceLabel } from './chatMonitoringLabels';

/**
 * A notice text the organisation can copy into its own staff notice: what
 * is counted where, why and on which basis, what is never done with it, how
 * long, from when, the Privacy Shield's own per-user log beside it (so the
 * notice is complete about what exists), the right to object and where to
 * ask. Filled from the form; anything not known yet stays a bracketed gap.
 */

export interface NoticeTemplateProps {
    form: ChatMonitoringForm;
    template: ChatMonitoringConfig['template'];
    orgName: string | null;
    /** The day counting starts: the form's date on a widen, the stored one otherwise. */
    startDay: string;
}

function shieldLogRetention(t: TranslateFn, days: number | null, gap: string): string {
    if (days === null) return gap;
    if (days === 0) return t('chat_monitoring.notice_no_limit', 'as long as the installation keeps it (no time limit is set)');
    return t('chat_monitoring.notice_days', '{days} days', { days });
}

export function noticeText(t: TranslateFn, { form, template, orgName, startDay }: NoticeTemplateProps, locale: string): string {
    const gap = t('chat_monitoring.notice_gap', '[to fill in]');
    const surfaces = form.surfaces.map((s) => surfaceLabel(t, s)).join(', ');
    return t('chat_monitoring.notice_template', 'Chat signals at {organisation}\n\nWhat we do: to check whether the Privacy Shield works, we count how it handled messages in {surfaces}. We count the outcome, for example protected, blocked, sent anyway or scan failed{kinds_clause}. The count does not keep what you wrote, the personal data that was found, or who wrote it.\n\nWhy, and on which basis: {legal_basis}.{interest}\n\nWhat we never do with it: we do not look at individuals. The counts are never used to evaluate you, your performance, absence or health. Messages between colleagues are never counted.\n\nSmall groups: when few people use a chat, totals can still point to individuals. We hide figures from fewer than 5 people (10 for kinds of data).\n\nHow long: {retention_days} days. Counting starts on {start_date}.\n\nThe Privacy Shield\'s own activity log: separately from these counts, the Privacy Shield keeps a log of what it protected or blocked, per user: the time, the kind of data and the action, never the message text. Administrators can see it in Usage & Monitoring, including views per person: a ranking of people by Privacy Shield events and a list of the events per person. It is kept for {shield_log_retention} and is used only to investigate suspected incidents.\n\nYour choices: you can object. In the chat, choose "Don\'t count my chat turns" and your turns are no longer counted. To see or erase your data, use {dsr_channel}.\n\nQuestions: contact our data protection officer at {dpo_contact}.', {
        organisation: orgName || gap,
        surfaces: surfaces || gap,
        kinds_clause: form.signals.includes('kinds') ? t('chat_monitoring.notice_template_kinds', ', and which kinds of personal data it found, such as names or e-mail addresses') : '',
        legal_basis: form.legal_basis ? legalBasisLabel(t, form.legal_basis) : gap,
        interest: form.legal_basis === 'art6_1_f' ? t('chat_monitoring.notice_interest_f', ' Our legitimate interest is keeping personal data safe when people use AI: we need to know whether the protection works.') : '',
        retention_days: form.retention_days || gap,
        start_date: formatNoticeDate(startDay, locale) || gap,
        shield_log_retention: shieldLogRetention(t, template.shieldLogRetentionDays, gap),
        dsr_channel: template.dsrUrl || gap,
        dpo_contact: template.dpoContact || gap,
    });
}

export default function NoticeTemplate(props: NoticeTemplateProps) {
    const { t, resolvedLocale } = useTranslation();
    const { copy, copied } = useCopyToClipboard();
    const text = noticeText(t, props, resolvedLocale);
    return (
        <div className="flex flex-col gap-1.5" data-testid="cm-template">
            <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-bold text-[var(--text-primary)]">{t('chat_monitoring.notice_template_title', 'Notice text you can copy')}</span>
                <ActionButton size="sm" icon={copied ? Check : Copy} onClick={() => { void copy(text); }} data-testid="cm-template-copy">
                    {copied ? t('chat_monitoring.copied', 'Copied') : t('chat_monitoring.copy', 'Copy')}
                </ActionButton>
            </div>
            <pre className="m-0 max-h-[220px] overflow-y-auto whitespace-pre-wrap rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-tertiary)] p-3 font-sans text-[11px] leading-relaxed text-[var(--text-secondary)]" data-testid="cm-template-text">
                {text}
            </pre>
        </div>
    );
}
