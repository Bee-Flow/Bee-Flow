/**
 * ComplianceBlock — the "Compliance" block in an automation's Settings tab and an
 * agent's Advanced drawer (Compliance Center redesign, Sep 2026; FE-8). One
 * signals line, one saved-outcome chip, one "Assess…" button that opens the
 * AI Act ladder. It owns the data hook and hands it to the modal so the chip
 * updates the moment a declaration is recorded.
 *
 * Signals come from the server route when it exists and from `aiSignals.js`
 * (the target's own definition) when it does not — the line then says so in
 * a quieter voice. A failed read is its own state; an unknown count renders
 * nothing.
 *
 * Props
 *   kind     'automation' | 'agent'
 *   target   the automation / agent record (`id`, `name`, `definition` …)
 *   now          test seam for the expiry comparison
 *   modalZIndex  lifts the ladder above a host drawer (the agent wizard's is z-1100)
 */
import React, { useMemo, useState } from 'react';
import { ClipboardCheck, PenLine, Sparkles } from 'lucide-react';
import { useTranslation } from '../../../../hooks/useTranslation';
import StatusPill from '../shared/StatusPill';
import { formatCalDate } from '../shared/calendarMath';
import useAiActAssessment from './useAiActAssessment';
import AiActLadderModal from './AiActLadderModal';

export const OUTCOME_LABEL = Object.freeze({
    not_applicable: { key: 'compliance.ladder_outcome_chip_not_applicable', en: 'AI Act not applicable' },
    prohibited: { key: 'compliance.ladder_outcome_chip_prohibited', en: 'Prohibited (Art. 5)' },
    high_risk: { key: 'compliance.ladder_outcome_chip_high_risk', en: 'High-risk (Annex III)' },
    transparency: { key: 'compliance.ladder_outcome_chip_transparency', en: 'Art. 4 + Art. 50' },
    minimal: { key: 'compliance.ladder_outcome_chip_minimal', en: 'Minimal risk' },
});

/** The chip's state from the saved row: `{ tone, state }`, state ∈ declared | expired | none. */
export function chipState(assessment, now = Date.now()) {
    if (!assessment || !assessment.outcome || !assessment.attested_at) return { tone: 'neutral', state: 'none' };
    const exp = assessment.expires_at ? new Date(assessment.expires_at).getTime() : NaN;
    const expired = assessment.current === false || (Number.isFinite(exp) && exp < (now instanceof Date ? now.getTime() : now));
    if (expired) return { tone: 'warning', state: 'expired' };
    if (assessment.outcome === 'prohibited') return { tone: 'error', state: 'declared' };
    return { tone: 'success', state: 'declared' };
}

export default function ComplianceBlock({ kind = 'automation', target, now, className = '', modalZIndex }) {
    const { t, resolvedLocale } = useTranslation();
    const locale = resolvedLocale || 'en';
    const data = useAiActAssessment(kind, target);
    const [open, setOpen] = useState(false);

    const { signals, assessment, error, loading } = data;
    const chip = useMemo(() => chipState(assessment, now), [assessment, now]);

    const aiCount = Array.isArray(signals?.steps?.ai) ? signals.steps.ai.length : null;
    const line = signalsLine({ kind, signals, aiCount, t });

    if (!target?.id) return null;

    return (
        <section data-testid="compliance-block" data-kind={kind} className={`flex flex-col gap-2 ${className}`}>
            <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2 min-w-0">
                    <ClipboardCheck size={15} aria-hidden="true" style={{ color: 'var(--kind-compliance)' }} />
                    <h3 className="text-[13px] font-semibold text-[var(--text-primary)]">
                        {t('compliance.ladder_block_title', 'Compliance')}
                    </h3>
                    <OutcomeChip chip={chip} assessment={assessment} locale={locale} t={t} />
                </div>
                <button
                    type="button"
                    data-testid="compliance-block-assess"
                    onClick={() => setOpen(true)}
                    className="inline-flex items-center gap-1.5 text-[12px] font-medium px-2.5 py-1 rounded-md border border-[var(--border-default)] text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] transition"
                >
                    <PenLine size={12} aria-hidden="true" />
                    {t('compliance.ladder_assess', 'Assess…')}
                </button>
            </div>

            {error && (
                <p data-testid="compliance-block-error" className="text-[11px]" style={{ color: 'var(--error-ink)' }}>
                    {t('compliance.ladder_block_read_failed', 'The saved assessment could not be read.')}
                </p>
            )}

            {line && (
                <p data-testid="compliance-block-signals" data-source={signals?.source || 'server'} className="flex items-start gap-1.5 text-[12px] text-[var(--text-secondary)]">
                    <Sparkles size={12} aria-hidden="true" className="shrink-0 mt-0.5" style={{ color: 'var(--type-ai)' }} />
                    <span>
                        {line}
                        {signals?.source === 'client' && !loading && (
                            <span className="text-[var(--text-tertiary)]">
                                {' '}· {t('compliance.ladder_signals_client', 'read from the definition')}
                            </span>
                        )}
                    </span>
                </p>
            )}

            <p className="text-[11px] text-[var(--text-tertiary)]">
                {t('compliance.ladder_block_hint', 'Three questions — Art. 5, Art. 50, Annex III — decide whether the AI Act applies here. A declaration is stamped and expires after 12 months.')}
            </p>

            <AiActLadderModal
                open={open}
                onClose={() => setOpen(false)}
                kind={kind}
                target={target}
                data={data}
                now={now}
                zIndex={modalZIndex}
            />
        </section>
    );
}

function OutcomeChip({ chip, assessment, locale, t }) {
    if (chip.state === 'none') {
        return <StatusPill tone="neutral" testId="compliance-block-chip">{t('compliance.ladder_chip_not_assessed', 'Not assessed')}</StatusPill>;
    }
    const label = OUTCOME_LABEL[assessment.outcome];
    const outcomeWord = label ? t(label.key, label.en) : assessment.outcome;
    if (chip.state === 'expired') {
        return (
            <StatusPill tone="warning" testId="compliance-block-chip" title={outcomeWord}>
                {t('compliance.ladder_chip_expired', 'Expired')}
            </StatusPill>
        );
    }
    return (
        <StatusPill tone={chip.tone} testId="compliance-block-chip" title={outcomeWord}>
            {t('compliance.ladder_chip_declared', 'Self-declared {date}', { date: formatCalDate(assessment.attested_at, { locale }) })}
        </StatusPill>
    );
}

function signalsLine({ kind, signals, aiCount, t }) {
    if (!signals) return null;
    const parts = [];
    if (kind === 'agent') {
        parts.push(t('compliance.ladder_sig_agent_ai', 'An agent is an AI system'));
    } else if (signals.contains_ai === true) {
        if (aiCount !== null) parts.push(t('compliance.ladder_sig_ai_steps', '{n} AI steps', { n: aiCount }));
        else parts.push(t('compliance.ladder_sig_contains_ai', 'contains AI'));
    } else if (signals.contains_ai === false) {
        parts.push(t('compliance.ladder_sig_no_ai', 'no AI steps'));
    }
    if (signals.customer_facing === true) parts.push(t('compliance.ladder_sig_customer_facing', 'customer-facing'));
    else if (signals.customer_facing === false) parts.push(t('compliance.ladder_sig_internal', 'internal only'));
    if (signals.generates_content === true) parts.push(t('compliance.ladder_sig_generates', 'generates content'));
    return parts.length ? parts.join(' · ') : null;
}
