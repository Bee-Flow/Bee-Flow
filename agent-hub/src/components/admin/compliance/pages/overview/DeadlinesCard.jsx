import { ChevronDown, Timer } from 'lucide-react';
import React, { useId, useState } from 'react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import DeadlineClock, { useNow } from '../../../../shared/DeadlineClock';
import { DAY_MS, HOUR_MS } from '../../../../shared/deadlineMath';
import ArticleRef from '../../shared/ArticleRef';
import { deadlineRef, deadlineSubjectKind, emptyLines, splitDeadlines, targetOf } from './deadlineRows';

/**
 * DeadlinesCard — the Overview's right-column clocks (artboard 1a, C6).
 *
 *   items       GET /deadlines items (or the client fallback) | null, most urgent first
 *   emptyKinds  kinds with no open item ('cra_vulnerability' …) → one quiet line per distinct sentence
 *   failed      the read failed AND no fallback exists → own state
 *   navigate(sectionId, subId?, tab?) — row click → the item's target
 *
 * Row: `{ id, kind, ref, title, meta:{ article, … }, started_at, due_at, state, pct, target }`
 * where target is `{ section, id }` (client fallback) or an app path (server).
 *
 * What is pressing comes first: overdue and urgent clocks and anything due
 * within 30 days, at most six (deadlineRows.splitDeadlines). The rest waits
 * behind one "Show {n} later" toggle. The article prints as the server wrote
 * it ("GDPR Art. 12(3)"); only a request or an incident prints its ref.
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

export default function DeadlinesCard({ items = null, emptyKinds = [], failed = false, navigate, className = '', testId = 'deadlines-card' }) {
    const { t } = useTranslation();
    const now = useNow();
    const [expanded, setExpanded] = useState(false);
    const listId = useId();
    const list = Array.isArray(items) ? items : null;
    const { soon, later } = splitDeadlines(list, now);
    const shown = expanded ? [...soon, ...later] : soon;
    const empties = emptyLines(emptyKinds);

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
                <span className="text-[11px] text-[var(--text-tertiary)]">{t('compliance.ovw_deadlines_hint', 'Legal response deadlines, most urgent first')}</span>
            </header>

            {list === null ? (
                <p className="mt-3 text-xs text-[var(--text-tertiary)]" data-testid={`${testId}-unavailable`}>
                    {failed
                        ? t('compliance.ovw_deadlines_unavailable', 'Could not read the deadlines right now.')
                        : t('compliance.ovw_deadlines_loading', 'Reading the clocks…')}
                </p>
            ) : (
                <ul id={listId} className="m-0 mt-1 list-none p-0" data-testid={`${testId}-rows`}>
                    {shown.map(item => (
                        <DeadlineRow key={item.id} item={item} navigate={navigate} t={t} testId={testId} />
                    ))}
                    {list.length > 0 && soon.length === 0 && !expanded ? (
                        <li className="py-2 text-xs text-[var(--text-tertiary)]" data-testid={`${testId}-none-soon`}>
                            {t('compliance.ovw_deadlines_none_soon', 'Nothing due in the next 30 days.')}
                        </li>
                    ) : null}
                    {empties.map(({ id, kind, entry }) => (
                        <EmptyLine key={`empty:${id}`} kind={kind} entry={entry} t={t} testId={testId} />
                    ))}
                    {list.length === 0 && empties.length === 0 ? (
                        <li className="py-2 text-xs text-[var(--text-tertiary)]" data-testid={`${testId}-none`}>{t('compliance.ovw_deadlines_none', 'No clock is running.')}</li>
                    ) : null}
                </ul>
            )}

            {list && later.length > 0 ? (
                <LaterToggle expanded={expanded} count={later.length} controls={listId} onToggle={() => setExpanded(v => !v)} t={t} testId={testId} />
            ) : null}
        </section>
    );
}

/** An empty register: a whole sentence (the CRA line), or the kind's label and "no open …". */
function EmptyLine({ kind, entry, t, testId }) {
    const label = KIND_LABEL[kind];
    return (
        <li className="flex flex-wrap items-baseline gap-x-1.5 border-t border-[var(--border-default)] py-2 text-xs first:border-t-0" data-testid={`${testId}-empty`} data-kind={kind}>
            {entry.sentence ? (
                <span className="text-[var(--text-tertiary)]">{t(entry.key, entry.en)}</span>
            ) : (
                <>
                    <span className="text-[var(--text-secondary)]">{label ? t(label.key, label.en) : kind}</span>
                    <span className="text-[11px] text-[var(--text-tertiary)]">{t(entry.key, entry.en)}</span>
                </>
            )}
        </li>
    );
}

/** "Show {n} later" / "Show fewer": the far clocks, one click away. */
function LaterToggle({ expanded, count, controls, onToggle, t, testId }) {
    return (
        <footer className="mt-1 border-t border-[var(--border-default)] pt-2 text-[11px]">
            <button
                type="button"
                onClick={onToggle}
                aria-expanded={expanded}
                aria-controls={controls}
                className="-mx-1 inline-flex items-center gap-1 rounded px-1 py-0.5 font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                data-testid={`${testId}-toggle`}
            >
                {expanded
                    ? t('compliance.ovw_show_fewer', 'Show fewer')
                    : t('compliance.ovw_show_later', 'Show {n} later', { n: count })}
                <ChevronDown size={12} aria-hidden className={`transition-transform ${expanded ? 'rotate-180' : ''}`} />
            </button>
        </footer>
    );
}

function DeadlineRow({ item, navigate, t, testId }) {
    const tgt = targetOf(item);
    const kind = KIND_LABEL[item.kind];
    const ref = deadlineRef(item);
    const subject = deadlineSubjectKind(item);
    const parts = [
        kind ? <span key="kind">{t(kind.key, kind.en)}</span> : null,
        item.meta?.article ? <ArticleRef key="article" testId={`${testId}-article`}>{item.meta.article}</ArticleRef> : null,
        subject ? <span key="subject">{subject}</span> : null,
    ].filter(Boolean);
    const heading = [ref, item.title].filter(Boolean).join(' · ');
    const Row = tgt ? 'button' : 'div';
    return (
        <li className="border-t border-[var(--border-default)] first:border-t-0" data-testid={`${testId}-row`} data-kind={item.kind} data-state={item.state}>
            <Row
                type={tgt ? 'button' : undefined}
                onClick={tgt ? () => navigate?.(tgt.section, tgt.id, tgt.tab) : undefined}
                className={`grid w-full grid-cols-[1fr_104px] items-center gap-2.5 py-2 text-left ${tgt ? 'cursor-pointer hover:bg-[var(--bg-secondary)]' : ''}`}
            >
                <div className="min-w-0">
                    <div className="truncate text-xs font-medium text-[var(--text-primary)]" title={heading} data-testid={`${testId}-title`}>
                        {ref ? <span className="text-[var(--text-secondary)] tabular-nums" data-testid={`${testId}-ref`}>{ref}</span> : null}
                        {ref && item.title ? ' · ' : ''}
                        {item.title}
                    </div>
                    {parts.length ? (
                        <div className="truncate text-[11px] text-[var(--text-tertiary)]" data-testid={`${testId}-meta`}>
                            {parts.map((part, i) => <React.Fragment key={part.key}>{i > 0 ? ' · ' : null}{part}</React.Fragment>)}
                        </div>
                    ) : null}
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
}
