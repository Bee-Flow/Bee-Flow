/**
 * The staff-notice text the organisation copies into its own notice, lifted
 * from agent-hub chatMonitoring/NoticeTemplate.tsx (noticeText) with the
 * web's literal keys, and formatNoticeDate from the web's chatSignalsModel.ts
 * (a UTC day, so the date never shifts with the phone's time zone). Anything
 * not known yet stays '[to fill in]'. Pinned by noticeText.test.ts.
 */
import type { TranslateFn } from '@/core/i18n';

import type { ChatMonitoringForm } from './form';
import { legalBasisLabel, surfaceLabel } from './labels';

/** `template` of GET /chat-monitoring, after the reader. */
export interface NoticeTemplateInfo {
    dpoContact: string | null;
    dsrUrl: string | null;
    shieldLogRetentionDays: number | null;
}

export interface NoticeTemplateProps {
    form: ChatMonitoringForm;
    template: NoticeTemplateInfo;
    orgName: string | null;
    /** The day counting starts: the form's date on a widen, the stored one otherwise. */
    startDay: string;
}

/** A UTC 'YYYY-MM-DD' as a long date in the locale ('' for anything else). */
export function formatNoticeDate(day: string | null | undefined, locale = 'en'): string {
    if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return '';
    const date = new Date(`${day}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime())) return '';
    const tag = !locale || locale === 'en' ? 'en-GB' : locale;
    try {
        return new Intl.DateTimeFormat(tag, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date);
    } catch {
        return day;
    }
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
