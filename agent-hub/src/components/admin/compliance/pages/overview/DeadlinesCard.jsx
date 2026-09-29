import React from 'react';
import { Timer } from 'lucide-react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import DeadlineClock from '../../../../shared/DeadlineClock';
import { DAY_MS, HOUR_MS } from '../../../../shared/deadlineMath';
import { complianceActionPath, sectionOfPath } from '../../data/actions';

/**
 * DeadlinesCard — the Overview's right-column clocks (artboard 1a, C6).
 *
 *   items       GET /deadlines items (or the client fallback) | null
 *   emptyKinds  kinds with no open item ('cra_vulnerability' …) → a tertiary line each
 *   failed      the read failed AND no fallback exists → own state
 *   navigate(sectionId, subId?) — row click → the item's target
 *
 * Row: `{ id, kind, ref, title, meta:{ article, … }, started_at, due_at, state, pct, target }`
 * where target is `{ section, id }` (client fallback) or an app path (server).
 */
export const KIND_LABEL = Object.freeze({
    dsr: { key: 'compliance.deadline_kind_dsr', en: 'DSR' },
    incident: { key: 'compliance.deadline_kind_incident', en: 'Breach' },
    cra_early_warning: { key: 'compliance.deadline_kind_cra_early_warning', en: 'CRA · early warning' },
    cra_full_report: { key: 'compliance.deadline_kind_cra_full_report', en: 'CRA · full report' },
    cra_vulnerability: { key: 'compliance.deadline_kind_cra_vulnerability', en: 'CRA · early warning' },
    obligation: { key: 'compliance.deadline_kind_obligation', en: 'ISMS obligation' },
    attestation_expiry: { key: 'compliance.deadline_kind_attestation_expiry', en: 'AI Act attestation' },
});

/** Regulation, not presentation: DSR 5 d, incident 24 h, CRA early 6 h / full 24 h, obligation 7 d, attestation 30 d. */
export const URGENT_BELOW_MS = Object.freeze({
    dsr: 5 * DAY_MS,
    incident: 24 * HOUR_MS,
    cra_early_warning: 6 * HOUR_MS,
    cra_full_report: 24 * HOUR_MS,
    obligation: 7 * DAY_MS,
    attestation_expiry: 30 * DAY_MS,
});

const EMPTY_LINE = Object.freeze({
    cra_vulnerability: { key: 'compliance.ovw_no_open_vulnerability', en: 'no open vulnerability' },
    cra_early_warning: { key: 'compliance.ovw_no_open_vulnerability', en: 'no open vulnerability' },
    cra_full_report: { key: 'compliance.ovw_no_open_vulnerability', en: 'no open vulnerability' },
    dsr: { key: 'compliance.ovw_no_open_dsr', en: 'no open request' },
    incident: { key: 'compliance.ovw_no_open_incident', en: 'no open incident' },
});

export function targetOf(item) {
    const tgt = item?.target;
    if (!tgt) return null;
    if (typeof tgt === 'object') return tgt.section ? { section: tgt.section, id: tgt.id ?? undefined } : null;
    const path = complianceActionPath(tgt);
    const section = sectionOfPath(path);
    if (!section) return null;
    const sub = /^admin\/compliance\/[^/]+\/(.+)$/.exec(path)?.[1];
    return { section, id: sub ? decodeURIComponent(sub) : undefined };
}

export default function DeadlinesCard({ items = null, emptyKinds = [], failed = false, navigate, className = '', testId = 'deadlines-card' }) {
    const { t } = useTranslation();
    const list = Array.isArray(items) ? items : null;
    const kinds = Array.isArray(emptyKinds) ? emptyKinds : [];

    return (
        <section
            className={`flex flex-col rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] px-4 py-3.5 ${className}`}
            style={{ boxShadow: 'var(--shadow-sm)' }}
            data-testid={testId}
            aria-label={t('compliance.ovw_deadlines_title', 'Deadlines')}
        >
            <header className="flex flex-wrap items-baseline gap-2">
                <Timer size={14} className="self-center text-[var(--text-secondary)]" aria-hidden />
                <h3 className="m-0 text-[13px] font-semibold text-[var(--text-primary)]">{t('compliance.ovw_deadlines_title', 'Deadlines')}</h3>
                <span className="text-[11px] text-[var(--text-tertiary)]">{t('compliance.ovw_deadlines_hint', '30 days · 72 hours · 24 hours — one clock')}</span>
            </header>

            {list === null ? (
                <p className="mt-3 text-xs text-[var(--text-tertiary)]" data-testid={`${testId}-unavailable`}>
                    {failed
                        ? t('compliance.ovw_deadlines_unavailable', 'Could not read the deadlines right now.')
                        : t('compliance.ovw_deadlines_loading', 'Reading the clocks…')}
                </p>
            ) : (
                <ul className="m-0 mt-1 list-none p-0" data-testid={`${testId}-rows`}>
                    {list.map(item => {
                        const tgt = targetOf(item);
                        const kind = KIND_LABEL[item.kind];
                        const meta = [kind ? t(kind.key, kind.en) : null, item.meta?.article ? `Art. ${item.meta.article}` : null]
                            .filter(Boolean).join(' · ');
                        const Row = tgt ? 'button' : 'div';
                        return (
                            <li key={item.id} className="border-t border-[var(--border-default)] first:border-t-0" data-testid={`${testId}-row`} data-kind={item.kind} data-state={item.state}>
                                <Row
                                    type={tgt ? 'button' : undefined}
                                    onClick={tgt ? () => navigate?.(tgt.section, tgt.id) : undefined}
                                    className={`grid w-full grid-cols-[1fr_104px] items-center gap-2.5 py-2 text-left ${tgt ? 'cursor-pointer hover:bg-[var(--bg-secondary)]' : ''}`}
                                >
                                    <div className="min-w-0">
                                        <div className="truncate text-xs font-medium text-[var(--text-primary)]">
                                            {item.ref ? <span className="font-mono text-[11px] text-[var(--text-secondary)]">{item.ref}</span> : null}
                                            {item.ref && item.title ? ' · ' : ''}
                                            {item.title}
                                        </div>
                                        {meta ? <div className="truncate text-[11px] text-[var(--text-tertiary)]">{meta}</div> : null}
                                    </div>
                                    <DeadlineClock
                                        variant="row"
                                        dueAt={item.due_at}
                                        startedAt={item.started_at}
                                        state={item.state}
                                        pct={item.pct}
                                        urgentBelowMs={URGENT_BELOW_MS[item.kind]}
                                        testId={`${testId}-clock`}
                                    />
                                </Row>
                            </li>
                        );
                    })}
                    {kinds.map(kind => {
                        const label = KIND_LABEL[kind];
                        const empty = EMPTY_LINE[kind] || { key: 'compliance.ovw_no_open_item', en: 'nothing open' };
                        return (
                            <li key={`empty:${kind}`} className="grid grid-cols-[1fr_104px] items-center gap-2.5 border-t border-[var(--border-default)] py-2 first:border-t-0" data-testid={`${testId}-empty`} data-kind={kind}>
                                <div className="truncate text-xs text-[var(--text-secondary)]">{label ? t(label.key, label.en) : kind}</div>
                                <div className="text-[11px] text-[var(--text-tertiary)]">{t(empty.key, empty.en)}</div>
                            </li>
                        );
                    })}
                    {list.length === 0 && kinds.length === 0 ? (
                        <li className="py-2 text-xs text-[var(--text-tertiary)]" data-testid={`${testId}-none`}>{t('compliance.ovw_deadlines_none', 'No clock is running.')}</li>
                    ) : null}
                </ul>
            )}
        </section>
    );
}
