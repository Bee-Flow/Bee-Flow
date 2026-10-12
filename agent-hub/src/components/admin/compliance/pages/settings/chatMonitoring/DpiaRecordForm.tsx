import React, { useState } from 'react';
import { useTranslation } from '../../../../../../hooks/useTranslation';
import { useRecordChatMonitoringDpia } from '../../../data/useChatMonitoring';
import { ActionButton, DateInput, Field, Select, TextArea } from './formAtoms';
import { DPIA_RISK_LEVELS, type RiskLevel } from './chatMonitoringForm';
import { riskLabel } from './chatMonitoringLabels';

/**
 * "Record the DPIA": a small form that files the chat-signals DPIA in Bee
 * Flow through the existing DPIA route (key `chat_monitoring`), as an
 * attestation with its risk level, an optional end date and the measures.
 * Without an end date the record counts as current for one year.
 */
export default function DpiaRecordForm({ onClose }: { onClose: () => void }) {
    const { t } = useTranslation();
    const record = useRecordChatMonitoringDpia();
    const [risk, setRisk] = useState<RiskLevel>('medium');
    const [expiresAt, setExpiresAt] = useState('');
    const [measures, setMeasures] = useState('');
    const [failed, setFailed] = useState(false);

    const submit = async () => {
        setFailed(false);
        try {
            await record.mutateAsync({
                mode: 'attestation',
                risk_level: risk,
                expires_at: /^\d{4}-\d{2}-\d{2}$/.test(expiresAt) ? expiresAt : null,
                mitigations: measures.split('\n').map((m) => m.trim()).filter(Boolean).slice(0, 100),
            });
            onClose();
        } catch {
            setFailed(true);
        }
    };

    return (
        <div className="flex flex-col gap-2 rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-card)] p-3" data-testid="cm-dpia-form">
            <div className="grid gap-2 @[560px]/cpage:grid-cols-2">
                <Field label={t('chat_monitoring.dpia_risk', 'Risk level in the DPIA')}>
                    <Select
                        value={risk}
                        onChange={(v: string) => setRisk(v as RiskLevel)}
                        options={DPIA_RISK_LEVELS.map((id) => ({ value: id, label: riskLabel(t, id) }))}
                        data-testid="cm-dpia-form-risk"
                    />
                </Field>
                <Field label={t('chat_monitoring.dpia_valid_until', 'Valid until (optional)')} hint={t('chat_monitoring.dpia_expires_hint', 'Without an end date, a DPIA counts as current for one year.')}>
                    <DateInput value={expiresAt} onChange={setExpiresAt} data-testid="cm-dpia-form-expires" />
                </Field>
            </div>
            <Field label={t('chat_monitoring.dpia_measures', 'Measures (one per line)')}>
                <TextArea value={measures} onChange={setMeasures} rows={3} data-testid="cm-dpia-form-measures" />
            </Field>
            {failed && (
                <p role="alert" className="m-0 text-[11px] text-[var(--error-ink)]" data-testid="cm-dpia-form-error">
                    {t('chat_monitoring.dpia_record_failed', 'Could not record the DPIA. Try again.')}
                </p>
            )}
            <div className="flex items-center gap-2">
                <ActionButton variant="primary" size="sm" onClick={submit} disabled={record.isPending} data-testid="cm-dpia-form-save">
                    {t('chat_monitoring.dpia_record', 'Record the DPIA')}
                </ActionButton>
                <ActionButton size="sm" onClick={onClose} data-testid="cm-dpia-form-cancel">
                    {t('chat_monitoring.cancel', 'Cancel')}
                </ActionButton>
            </div>
        </div>
    );
}
