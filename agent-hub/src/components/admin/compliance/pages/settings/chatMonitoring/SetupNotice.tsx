import React from 'react';
import { useTranslation } from '../../../../../../hooks/useTranslation';
import { DateInput, Field, TextInput, Toggle } from './formAtoms';
import { defaultStartDate } from './chatMonitoringForm';
import RopaPreview from './RopaPreview';
import { HINT_CLASS, SECTION_CLASS, SECTION_TITLE_CLASS, type SetupSectionProps } from './setupTypes';

/**
 * Telling people before counting starts: the staff notice and when it was
 * published, the start date (seven days out by default, earlier only when
 * people were told before it), the visitors' notice, and the
 * processing-register entry the admin confirms having reviewed.
 */

export function NoticeFields({ form, patch }: SetupSectionProps) {
    const { t } = useTranslation();
    const visitors = form.surfaces.includes('agent_public');
    return (
        <div className="flex flex-col gap-2" data-testid="cm-notice">
            <div className="grid gap-2 @[560px]/cpage:grid-cols-[2fr_1fr]">
                <Field label={t('chat_monitoring.notice_url', 'Notice for staff (link)')}>
                    <TextInput type="url" inputMode="url" maxLength={500} value={form.notice_url} onChange={(v: string) => patch({ notice_url: v })} data-testid="cm-notice-url" />
                </Field>
                <Field label={t('chat_monitoring.notice_published_at', 'Published on')}>
                    <DateInput value={form.notice_published_at} onChange={(v: string) => patch({ notice_published_at: v })} data-testid="cm-notice-published" />
                </Field>
            </div>
            {visitors && (
                <p className={HINT_CLASS} data-testid="cm-visitor-hint">
                    {t('chat_monitoring.visitor_notice_hint', 'Website visitors see your privacy notice unless you set a separate notice above.')}
                </p>
            )}
            <Toggle
                testId="cm-ack-notice"
                checked={form.ack_notice_published}
                onChange={(on: boolean) => patch({ ack_notice_published: on })}
                label={t('chat_monitoring.ack_notice_published', 'The published notice covers chat signals.')}
            />
        </div>
    );
}

export function StartDate({ form, patch, now }: SetupSectionProps) {
    const { t } = useTranslation();
    const early = /^\d{4}-\d{2}-\d{2}$/.test(form.start_date) && form.start_date < defaultStartDate(now);
    return (
        <div className="flex flex-col gap-2" data-testid="cm-start">
            <Field label={t('chat_monitoring.effective_from', 'Start date')} hint={t('chat_monitoring.effective_from_hint', 'Seven days after saving, so people are told first. Employees see the start date in the chat.')}>
                <DateInput value={form.start_date} onChange={(v: string) => patch({ start_date: v })} className="max-w-[180px]" data-testid="cm-start-date" />
            </Field>
            {early && (
                <Toggle
                    testId="cm-ack-informed"
                    checked={form.ack_informed_before_start}
                    onChange={(on: boolean) => patch({ ack_informed_before_start: on })}
                    label={t('chat_monitoring.ack_informed', 'People were informed before this date.')}
                />
            )}
        </div>
    );
}

export function RegisterReview(props: SetupSectionProps) {
    const { form, patch } = props;
    const { t } = useTranslation();
    return (
        <div className={SECTION_CLASS} data-testid="cm-register">
            <h4 className={SECTION_TITLE_CLASS}>{t('chat_monitoring.ropa_preview', 'Processing-register entry')}</h4>
            <RopaPreview form={form} />
            <Toggle
                testId="cm-ack-ropa"
                checked={form.ack_ropa_reviewed}
                onChange={(on: boolean) => patch({ ack_ropa_reviewed: on })}
                label={t('chat_monitoring.ack_ropa', 'I reviewed the processing-register entry.')}
            />
            <p className={HINT_CLASS} data-testid="cm-small-groups">
                {t('chat_monitoring.small_groups', 'Figures from fewer than 5 people (10 for kinds of data) are hidden. In small groups, totals can still point to individuals.')}
            </p>
        </div>
    );
}
