import React from 'react';
import { useTranslation, type TranslateFn } from '../../../../../../hooks/useTranslation';
import { useChatMonitoringRopa, type RopaActivityView } from '../../../data/useChatMonitoring';
import { isEmployeeSurface, type ChatMonitoringForm } from './chatMonitoringForm';
import { surfaceLabel } from './chatMonitoringLabels';

/**
 * The processing-register entry for chat signals, inline in the set-up form
 * so "I reviewed the processing-register entry" is about something on
 * screen. Once the register holds the entry, it is shown as the register
 * has it; before the first save, a preview with the same fields, built from
 * the form.
 */

function legalBasisText(t: TranslateFn, basis: string): string {
    switch (basis) {
        case 'art6_1_f': return t('chat_monitoring.ropa.legal_basis_f', 'Art. 6(1)(f) GDPR, legitimate interest: keeping personal data safe when people use AI in chat (network and information security, recital 49), balanced in the DPIA');
        case 'art6_1_e': return t('chat_monitoring.ropa.legal_basis_e', 'Art. 6(1)(e) GDPR, public task');
        case 'art6_1_c': return t('chat_monitoring.ropa.legal_basis_c', 'Art. 6(1)(c) GDPR, legal obligation (Art. 32)');
        default: return '';
    }
}

function subjectsOf(t: TranslateFn, form: ChatMonitoringForm): string[] {
    const employees = form.surfaces.filter(isEmployeeSurface).map((s) => surfaceLabel(t, s));
    const out: string[] = [];
    if (employees.length) out.push(t('chat_monitoring.ropa.subjects_employees', 'Employees and members using: {surfaces}', { surfaces: employees.join(', ') }));
    if (form.surfaces.includes('agent_public')) out.push(t('chat_monitoring.ropa.subjects_visitors', 'Website visitors who chat with an embedded agent'));
    out.push(t('chat_monitoring.ropa.subjects_third_parties', 'People named in those messages (third parties)'));
    return out;
}

/** The client-side preview: the register's fields, from the form as it stands. */
export function previewActivity(t: TranslateFn, form: ChatMonitoringForm): RopaActivityView {
    const days = Number(form.retention_days) || 90;
    const categories = [t('chat_monitoring.ropa.data_counts', 'Weekly counts per chat type (employees) and daily counts (website visitors) of how the Privacy Shield handled messages')];
    if (form.signals.includes('kinds')) categories.push(t('chat_monitoring.ropa.data_kinds', 'Counts of the kinds of personal data found, without the values; health data is never counted'));
    categories.push(t('chat_monitoring.ropa.data_small_groups', 'These counts can relate to identifiable people in small groups'));
    return {
        name: t('chat_monitoring.ropa.name', 'Chat signals: checking whether the Privacy Shield works'),
        purpose: t('chat_monitoring.ropa.purpose', 'Checking whether the Privacy Shield works on chat messages (GDPR Art. 32(1)(d)) and keeping this register accurate (Art. 30(1)(c)). Never used to evaluate employees, their performance, absence or health.'),
        processing: t('chat_monitoring.ropa.processing', 'For each counted message, the outcome the Privacy Shield already decided (and, when switched on, the kinds of personal data it found) is turned into a counter inside the same request. The message is not stored for this.'),
        retention: t('chat_monitoring.ropa.retention', '{days} days. Whole weeks (days for website visitors) are deleted once all of them are older than {days} days.', { days }),
        legal_basis: legalBasisText(t, form.legal_basis),
        data_categories: categories,
        data_subjects: subjectsOf(t, form),
        security_measures: [],
    };
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="flex flex-col gap-0.5 @[560px]/cpage:flex-row @[560px]/cpage:gap-3">
            <dt className="shrink-0 text-[10px] uppercase tracking-[.08em] font-semibold text-[var(--text-tertiary)] @[560px]/cpage:w-[120px]">{label}</dt>
            <dd className="m-0 min-w-0 text-[11px] leading-snug text-[var(--text-secondary)] [overflow-wrap:anywhere]">{children}</dd>
        </div>
    );
}

const list = (items: string[]) => (items.length > 1 ? <ul className="m-0 pl-4 list-disc">{items.map((x) => <li key={x}>{x}</li>)}</ul> : items[0] || '—');

export default function RopaPreview({ form }: { form: ChatMonitoringForm }) {
    const { t } = useTranslation();
    const ropa = useChatMonitoringRopa({ enabled: true });
    const stored = ropa.data?.activity ?? null;
    const a = stored ?? previewActivity(t, form);
    return (
        <div className="flex flex-col gap-1.5 rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-card)] p-3" data-testid="cm-ropa" data-source={stored ? 'register' : 'preview'}>
            <p className="m-0 text-xs font-semibold text-[var(--text-primary)]">{a.name}</p>
            {!stored && <p className="m-0 text-[11px] text-[var(--text-tertiary)]">{t('chat_monitoring.ropa.preview_note', 'Preview: the entry appears in the processing register once you save.')}</p>}
            <dl className="m-0 flex flex-col gap-1.5">
                <Row label={t('chat_monitoring.ropa.f_purpose', 'Purpose')}>{a.purpose}</Row>
                <Row label={t('chat_monitoring.ropa.f_processing', 'Processing')}>{a.processing}</Row>
                <Row label={t('chat_monitoring.ropa.f_data', 'Data')}>{list(a.data_categories)}</Row>
                <Row label={t('chat_monitoring.ropa.f_subjects', 'People')}>{list(a.data_subjects)}</Row>
                <Row label={t('chat_monitoring.ropa.f_legal_basis', 'Legal basis')}>{a.legal_basis || '—'}</Row>
                <Row label={t('chat_monitoring.ropa.f_retention', 'Retention')}>{a.retention}</Row>
                {a.security_measures.length > 0 && <Row label={t('chat_monitoring.ropa.f_security', 'Security measures')}>{list(a.security_measures)}</Row>}
            </dl>
        </div>
    );
}
