import React, { useState } from 'react';
import { Plus } from 'lucide-react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import Modal from '../../../../shared/Modal';
import { PRIMARY_ACTION_STYLE } from '../../../../shared/StudioSectionHeader';
import { createBodyOf } from './incidentClocks';

/**
 * IncidentCreateModal — "Record incident" / "Record vulnerability".
 *
 * Recording STARTS the clock (GDPR 72 h from detection; CRA 24 h / 72 h /
 * 14 d), so the form is short on purpose: what happened, severity, when it
 * occurred (if known), and — for a vulnerability — the CVE ids, whether it is
 * exploited and which products it affects. The body is built by
 * `createBodyOf` (an allow-list), never from the form state itself.
 *
 * props: open, kind ('breach' | 'vulnerability'), busy, onCreate(body) → Promise, onClose
 */
const EMPTY = Object.freeze({ title: '', description: '', severity: 'medium', occurred_at: '', high_risk: false, cve_ids: '', exploited_in_wild: false, affected_products: '' });
const SEVERITIES = ['low', 'medium', 'high', 'critical'];
const SEVERITY_EN = Object.freeze({ low: 'Low', medium: 'Medium', high: 'High', critical: 'Critical' });

export default function IncidentCreateModal({ open, kind = 'breach', busy = false, onCreate, onClose, testId = 'inc-create' }) {
    const { t } = useTranslation();
    const [draft, setDraft] = useState(EMPTY);
    const vuln = kind === 'vulnerability';
    const patch = (p) => setDraft(d => ({ ...d, ...p }));

    const submit = async () => {
        if (!draft.title.trim()) return;
        await onCreate?.(createBodyOf(draft, kind));
        setDraft(EMPTY);
        onClose?.();
    };

    const footer = (
        <div className="flex items-center justify-end gap-2">
            <button type="button" onClick={onClose} className="h-8 px-3 rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-card)] text-[12px] font-medium text-[var(--text-secondary)]" data-testid={`${testId}-cancel`}>
                {t('common.cancel', 'Cancel')}
            </button>
            <button
                type="button"
                disabled={busy || !draft.title.trim()}
                onClick={submit}
                style={PRIMARY_ACTION_STYLE}
                className="h-8 px-3 rounded-[10px] text-[12px] font-semibold inline-flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
                data-testid={`${testId}-submit`}
            >
                <Plus size={13} aria-hidden="true" />
                {vuln ? t('compliance.vuln_create', 'Record — start the CRA clocks') : t('compliance.inc_create', 'Record — start the clock')}
            </button>
        </div>
    );

    return (
        <Modal
            open={open}
            onClose={onClose}
            size="md"
            title={vuln ? t('compliance.vuln_record', 'Record vulnerability') : t('compliance.inc_record', 'Record incident')}
            description={vuln
                ? t('compliance.vuln_clock_hint', 'Recording starts the CRA Art. 14 clocks: early warning within 24 hours, notification within 72 hours, final report within 14 days.')
                : t('compliance.inc_clock_hint', 'Recording starts the 72-hour clock from now. If the breach was detected earlier, the clock legally started then — do not delay recording.')}
            footer={footer}
        >
            <div className="flex flex-col gap-3" data-testid={testId}>
                <Field label={t('compliance.inc_f_title', 'What happened?')}>
                    <input autoFocus value={draft.title} onChange={e => patch({ title: e.target.value })} className={INPUT} data-testid={`${testId}-title`} />
                </Field>
                <Field label={t('compliance.inc_f_desc', 'Details')}>
                    <textarea rows={3} value={draft.description} onChange={e => patch({ description: e.target.value })} placeholder={t('compliance.inc_f_desc_ph', 'What data, how many people, how discovered, first containment steps…')} className={`${INPUT} resize-y`} data-testid={`${testId}-description`} />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                    <Field label={t('compliance.inc_f_severity', 'Severity')}>
                        <select value={draft.severity} onChange={e => patch({ severity: e.target.value })} className={INPUT} data-testid={`${testId}-severity`}>
                            {SEVERITIES.map(s => <option key={s} value={s}>{t(`compliance.inc_sev_${s}`, SEVERITY_EN[s])}</option>)}
                        </select>
                    </Field>
                    <Field label={t('compliance.inc_f_occurred', 'Occurred at (if known)')}>
                        <input type="datetime-local" value={draft.occurred_at} onChange={e => patch({ occurred_at: e.target.value })} className={INPUT} data-testid={`${testId}-occurred`} />
                    </Field>
                </div>
                {vuln ? (
                    <>
                        <Field label={t('compliance.vuln_f_cve', 'CVE ids')}>
                            <input value={draft.cve_ids} onChange={e => patch({ cve_ids: e.target.value })} placeholder="CVE-2026-1234, CVE-2026-5678" className={`${INPUT} font-mono`} data-testid={`${testId}-cve`} />
                        </Field>
                        <Field label={t('compliance.vuln_f_products', 'Affected products (one per line: name version-range)')}>
                            <textarea rows={2} value={draft.affected_products} onChange={e => patch({ affected_products: e.target.value })} className={`${INPUT} resize-y`} data-testid={`${testId}-products`} />
                        </Field>
                        <label className="inline-flex items-center gap-2 text-xs text-[var(--text-primary)]">
                            <input type="checkbox" checked={draft.exploited_in_wild} onChange={e => patch({ exploited_in_wild: e.target.checked })} data-testid={`${testId}-exploited`} />
                            {t('compliance.vuln_f_exploited', 'Actively exploited (CRA Art. 14(1) — report without delay)')}
                        </label>
                    </>
                ) : (
                    <label className="inline-flex items-center gap-2 text-xs text-[var(--text-primary)]">
                        <input type="checkbox" checked={draft.high_risk} onChange={e => patch({ high_risk: e.target.checked })} data-testid={`${testId}-high-risk`} />
                        {t('compliance.inc_f_high_risk', 'High risk for the people involved (triggers Art. 34)')}
                    </label>
                )}
            </div>
        </Modal>
    );
}

const INPUT = 'w-full rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-card)] px-2.5 py-1.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent-primary)]';

function Field({ label, children }) {
    return (
        <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-[.08em] font-semibold text-[var(--text-tertiary)]">{label}</span>
            {children}
        </label>
    );
}
