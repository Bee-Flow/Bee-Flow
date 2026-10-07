import { Plus } from 'lucide-react';
import React, { useId, useState } from 'react';
import { createBodyOf, localInputValue } from './incidentClocks';
import { useTranslation } from '../../../../../hooks/useTranslation';
import { useNow } from '../../../../shared/DeadlineClock';
import Modal from '../../../../shared/Modal';
import { PRIMARY_ACTION_STYLE } from '../../../../shared/StudioSectionHeader';

/**
 * IncidentCreateModal — "Record incident" / "Record vulnerability".
 *
 * Recording STARTS the clock (GDPR 72 h from awareness; CRA 24 h / 72 h /
 * 14 d), so the form is short on purpose: what happened, severity, when it
 * occurred (if known), when the organisation BECAME AWARE of it, and — for a
 * vulnerability — the CVE ids, whether it is exploited and which products it
 * affects. "Became aware at" defaults to now and cannot lie in the future: a
 * breach found yesterday and recorded today has 48 hours left, not 72. The
 * body is built by `createBodyOf` (an allow-list), never from the form state.
 *
 * props: open, kind ('breach' | 'vulnerability'), busy, onCreate(body) → Promise, onClose
 */
const EMPTY = Object.freeze({ title: '', description: '', severity: 'medium', occurred_at: '', detected_at: '', high_risk: false, cve_ids: '', exploited_in_wild: false, affected_products: '' });
/** The server refuses an awareness moment more than five minutes ahead of its own clock. */
const FUTURE_SKEW_MS = 5 * 60 * 1000;

const freshDraft = () => ({ ...EMPTY, detected_at: localInputValue() });
const SEVERITIES = ['low', 'medium', 'high', 'critical'];
const SEVERITY_EN = Object.freeze({ low: 'Low', medium: 'Medium', high: 'High', critical: 'Critical' });

export default function IncidentCreateModal({ open, kind = 'breach', busy = false, onCreate, onClose, testId = 'inc-create' }) {
    const { t } = useTranslation();
    const [draft, setDraft] = useState(freshDraft);
    const hintId = useId();
    const now = useNow();
    // Every opening starts from "now": a modal left open over lunch must not record the morning.
    const [seenOpen, setSeenOpen] = useState(open);
    if (seenOpen !== open) {
        setSeenOpen(open);
        if (open) setDraft(freshDraft());
    }
    const vuln = kind === 'vulnerability';
    const patch = (p) => setDraft(d => ({ ...d, ...p }));
    const awareMs = draft.detected_at ? new Date(draft.detected_at).getTime() : NaN;
    const awareInFuture = Number.isFinite(awareMs) && awareMs > now + FUTURE_SKEW_MS;
    const canSubmit = !busy && draft.title.trim() && !awareInFuture;

    const submit = async () => {
        if (!canSubmit) return;
        await onCreate?.(createBodyOf(draft, kind));
        setDraft(freshDraft());
        onClose?.();
    };

    const footer = (
        <div className="flex items-center justify-end gap-2">
            <button type="button" onClick={onClose} className="h-8 px-3 rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-card)] text-[12px] font-medium text-[var(--text-secondary)]" data-testid={`${testId}-cancel`}>
                {t('common.cancel', 'Cancel')}
            </button>
            <button
                type="button"
                disabled={!canSubmit}
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
                : t('compliance.inc_clock_hint', 'The reporting clocks run from the moment your organisation became aware of the breach.')}
            footer={footer}
        >
            <div className="flex flex-col gap-3" data-testid={testId}>
                <Field label={t('compliance.inc_f_title', 'What happened?')}>
                    <input autoFocus value={draft.title} onChange={e => patch({ title: e.target.value })} className={INPUT} data-testid={`${testId}-title`} />
                </Field>
                <Field label={t('compliance.inc_f_desc', 'Details')}>
                    <textarea rows={3} value={draft.description} onChange={e => patch({ description: e.target.value })} placeholder={t('compliance.inc_f_desc_ph', 'What data, how many people, how discovered, first containment steps…')} className={`${INPUT} resize-y`} data-testid={`${testId}-description`} />
                </Field>
                <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
                    <Field label={t('compliance.inc_f_occurred', 'Occurred at (if known)')}>
                        <input type="datetime-local" value={draft.occurred_at} max={localInputValue(now)} onChange={e => patch({ occurred_at: e.target.value })} className={INPUT} data-testid={`${testId}-occurred`} />
                    </Field>
                    <Field
                        label={t('compliance.inc_became_aware', 'Became aware at')}
                        hint={(
                            <span id={hintId} className="text-[11px] text-[var(--text-tertiary)]">
                                {vuln ? t('compliance.vuln_became_aware_hint', 'The CRA clocks run from here') : t('compliance.inc_became_aware_hint', 'The 72-hour clock runs from here')}
                            </span>
                        )}
                    >
                        <input
                            type="datetime-local"
                            value={draft.detected_at}
                            max={localInputValue(now)}
                            onChange={e => patch({ detected_at: e.target.value })}
                            aria-describedby={hintId}
                            aria-invalid={awareInFuture || undefined}
                            className={INPUT}
                            data-testid={`${testId}-aware`}
                        />
                    </Field>
                    <Field label={t('compliance.inc_f_severity', 'Severity')}>
                        <select value={draft.severity} onChange={e => patch({ severity: e.target.value })} className={INPUT} data-testid={`${testId}-severity`}>
                            {SEVERITIES.map(s => <option key={s} value={s}>{t(`compliance.inc_sev_${s}`, SEVERITY_EN[s])}</option>)}
                        </select>
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

/** A labelled field; `hint` sits under it, outside the label, so it describes the input without renaming it. */
function Field({ label, hint = null, children }) {
    const field = (
        <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-[.08em] font-semibold text-[var(--text-tertiary)]">{label}</span>
            {children}
        </label>
    );
    if (!hint) return field;
    return <div className="flex flex-col gap-1">{field}{hint}</div>;
}
