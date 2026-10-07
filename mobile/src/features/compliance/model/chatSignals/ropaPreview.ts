/**
 * The processing-register entry for chat signals, before the register holds
 * it: previewActivity lifted from agent-hub chatMonitoring/RopaPreview.tsx,
 * with the web's literal keys (pinned textually by labels.lockstep.test.ts).
 */
import type { TranslateFn } from '@/core/i18n';

import { isEmployeeSurface, type ChatMonitoringForm } from './form';
import { surfaceLabel } from './labels';

/** The register's chat-signals activity, as GET /ropa has it or as previewed. */
export interface RopaActivityView {
    name: string;
    purpose: string;
    processing: string;
    retention: string;
    legal_basis: string;
    data_categories: string[];
    data_subjects: string[];
    security_measures: string[];
}

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
