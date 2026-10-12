import React, { useState } from 'react';
import { useTranslation } from '../../../../../../hooks/useTranslation';
import { useDateFormat } from '../../../shared/formatDates';
import { ActionButton, DateInput, Field, Select, TextInput, Toggle } from './formAtoms';
import { DPIA_RISK_LEVELS, utcDay, type RiskLevel } from './chatMonitoringForm';
import { riskLabel } from './chatMonitoringLabels';
import { dpiaView } from './chatMonitoringPreview';
import DpiaRecordForm from './DpiaRecordForm';
import { HINT_CLASS, SECTION_TITLE_CLASS, type SetupSectionProps } from './setupTypes';

/**
 * The DPIA part of the preconditions: its status, recording it in Bee Flow
 * or naming the one kept elsewhere, the prior consultation a high risk
 * needs, the DPO's advice when a DPO is recorded, and the fixed list of what
 * the DPIA must also cover beyond these counts.
 */

function DpiaStatus({ form, config, now }: SetupSectionProps) {
    const { t } = useTranslation();
    const { formatDay } = useDateFormat();
    const view = dpiaView(form, config.dpia, now);
    let text = t('chat_monitoring.dpia_none', 'No DPIA recorded');
    if (view.current && view.expiresAt) {
        text = t('chat_monitoring.dpia_current_until', 'Current until {date}', { date: formatDay(view.expiresAt) });
    } else if (view.kind !== 'none' && view.expiresAt && view.expiresAt <= utcDay(now)) {
        text = t('chat_monitoring.dpia_expired', 'Expired on {date}', { date: formatDay(view.expiresAt) });
    }
    return (
        <p className="m-0 text-xs text-[var(--text-primary)]" data-testid="cm-dpia-status" data-current={view.current ? 'true' : 'false'}>
            {text}
            {view.riskLevel && <span className="text-[var(--text-tertiary)]">{` · ${t('chat_monitoring.dpia_risk', 'Risk level in the DPIA')}: ${riskLabel(t, view.riskLevel)}`}</span>}
        </p>
    );
}

function ExternalDpia({ form, patch }: SetupSectionProps) {
    const { t } = useTranslation();
    return (
        <div className="grid gap-2 @[560px]/cpage:grid-cols-3" data-testid="cm-dpia-external-fields">
            <Field label={t('chat_monitoring.dpia_ref', 'DPIA reference')}>
                <TextInput value={form.dpia_ref} maxLength={200} onChange={(v: string) => patch({ dpia_ref: v })} data-testid="cm-dpia-ref" />
            </Field>
            <Field label={t('chat_monitoring.dpia_at', 'DPIA date')}>
                <DateInput value={form.dpia_at} onChange={(v: string) => patch({ dpia_at: v })} data-testid="cm-dpia-at" />
            </Field>
            <Field label={t('chat_monitoring.dpia_risk', 'Risk level in the DPIA')}>
                <Select
                    value={form.dpia_risk_level}
                    onChange={(v: string) => patch({ dpia_risk_level: v as RiskLevel | '' })}
                    options={[{ value: '', label: t('chat_monitoring.choose', 'Choose…') }, ...DPIA_RISK_LEVELS.map((id) => ({ value: id, label: riskLabel(t, id) }))]}
                    data-testid="cm-dpia-risk"
                />
            </Field>
        </div>
    );
}

function ConsultationDates(props: SetupSectionProps) {
    const { form, patch, config, now } = props;
    const { t } = useTranslation();
    const high = dpiaView(form, config.dpia, now).riskLevel === 'high';
    return (
        <div className="grid gap-2 @[560px]/cpage:grid-cols-2">
            <Field
                label={t('chat_monitoring.prior_consultation_at', 'Prior consultation with the supervisory authority (date)')}
                hint={t('chat_monitoring.prior_consultation_hint', 'Required when the DPIA finds a high risk (Art. 36(1)).')}
                testId="cm-prior-consultation-field"
                className={high ? 'rounded-[10px] ring-1 ring-[var(--warning)] p-1.5' : ''}
            >
                <DateInput value={form.prior_consultation_at} onChange={(v: string) => patch({ prior_consultation_at: v })} data-testid="cm-prior-consultation" />
            </Field>
            <Field
                label={t('chat_monitoring.dpo_advice_at', 'DPO advice on the DPIA (date)')}
                hint={config.dpoRecorded ? t('chat_monitoring.dpo_advice_hint', 'Required because a data protection officer is recorded (Art. 35(2)).') : null}
            >
                <DateInput value={form.dpo_advice_at} onChange={(v: string) => patch({ dpo_advice_at: v })} data-testid="cm-dpo-advice" />
            </Field>
        </div>
    );
}

export default function SetupDpia(props: SetupSectionProps) {
    const { form, patch } = props;
    const { t } = useTranslation();
    const [recording, setRecording] = useState(false);
    return (
        <div className="flex flex-col gap-2" data-testid="cm-dpia">
            <h4 className={SECTION_TITLE_CLASS}>{t('chat_monitoring.dpia_label', 'Data protection impact assessment (DPIA)')}</h4>
            <DpiaStatus {...props} />
            {recording
                ? <DpiaRecordForm onClose={() => setRecording(false)} />
                : (
                    <ActionButton size="sm" className="w-fit" onClick={() => setRecording(true)} data-testid="cm-dpia-record">
                        {t('chat_monitoring.dpia_record', 'Record the DPIA')}
                    </ActionButton>
                )}
            <Toggle
                testId="cm-dpia-external"
                checked={form.dpia_external}
                onChange={(on: boolean) => patch({ dpia_external: on })}
                label={t('chat_monitoring.dpia_external', 'We keep the DPIA outside Bee Flow')}
            />
            {form.dpia_external && <ExternalDpia {...props} />}
            <ConsultationDates {...props} />
            <p className={HINT_CLASS} data-testid="cm-dpia-hint">
                {t('chat_monitoring.dpia_hint', 'The DPIA should also cover: the Privacy Shield\'s own log of what it protected or blocked per user, the views per person in Usage & Monitoring, the project hints that read the Shield\'s results for project team chats, and that totals can point to individuals in small groups.')}
            </p>
        </div>
    );
}
