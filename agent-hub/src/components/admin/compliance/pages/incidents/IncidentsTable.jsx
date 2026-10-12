import React from 'react';
import { filedCount, isClosedUnfiled, isVulnerability, lastDone, nextClock, startedAtOf, STATUS_LABEL } from './incidentClocks';
import { useTranslation } from '../../../../../hooks/useTranslation';
import DataTable, { TableRow, TableCell, TABLE_FOLDED_ONLY } from '../../../../shared/DataTable';
import DeadlineClock, { useNow } from '../../../../shared/DeadlineClock';
import { clockState } from '../../../../shared/deadlineMath';
import { DrawerId } from '../../../../shared/SideDrawer';
import { useDateFormat } from '../../shared/formatDates';
import RegisterStatePill from '../../shared/RegisterStatePill';
import SeverityTag from '../../shared/SeverityTag';

/**
 * IncidentsTable — Clock · Incident · Occurred · Next step · Status (the 1c
 * table pattern). Serves both registers: for a vulnerability row the clock
 * is the next open CRA stage and the next step names that CRA stage.
 *
 * "Next step" says in words which filing the row is waiting for (the stage
 * whose clock runs), or "All filed" / "Closed", with "{n} of {total} filed"
 * for a screen reader; it replaced a column of colour-only stamp icons. The
 * row's stripe follows the clock's urgency only, never the status or the
 * severity. Occurred folds under the title when the table is narrow (an open
 * drawer beside it), so the title keeps its room.
 */
export const INCIDENT_COLUMNS = Object.freeze([
    Object.freeze({ id: 'clock', width: '118px', labelKey: 'compliance.inc_col_clock', fallback: 'Deadline' }),
    Object.freeze({ id: 'incident', width: '1fr', labelKey: 'compliance.inc_col_incident', fallback: 'Incident' }),
    Object.freeze({ id: 'occurred', width: '104px', labelKey: 'compliance.inc_col_occurred', fallback: 'Occurred', foldBelow: 900 }),
    Object.freeze({ id: 'next', width: '150px', labelKey: 'compliance.inc_col_next_step', fallback: 'Next step' }),
    Object.freeze({ id: 'status', width: '128px', labelKey: 'compliance.inc_col_status', fallback: 'Status' }),
]);

export const incidentRef = (inc) => (isVulnerability(inc) ? `VULN-${inc.id}` : `INC-${inc.id}`);

const sameId = (a, b) => a !== null && a !== undefined && String(a) === String(b);

/** The row's stripe: red when the running clock is overdue, amber when urgent, none otherwise. */
export function accentOf(incident, now = Date.now()) {
    const next = nextClock(incident);
    if (!next) return null;
    const { state } = clockState({ dueAt: next.dueAt, startedAt: startedAtOf(incident), urgentBelowMs: next.urgentBelowMs, now });
    return state === 'overdue' ? 'error' : state === 'urgent' ? 'warning' : null;
}

/**
 * The row's clock: the next open stage; a fully reported row shows its
 * completion; a closed incident none of whose stages was filed reads
 * "closed · not notified" in quiet ink, never a red "overdue".
 */
export function IncidentClock({ incident, variant = 'row', testId }) {
    const { t } = useTranslation();
    const next = nextClock(incident);
    if (next) {
        return (
            <DeadlineClock variant={variant} dueAt={next.dueAt} startedAt={startedAtOf(incident)} urgentBelowMs={next.urgentBelowMs} testId={testId}>
                {variant === 'block' ? t(next.labelKey, next.fallback) : null}
            </DeadlineClock>
        );
    }
    if (isClosedUnfiled(incident)) {
        const text = t('compliance.inc_closed_not_notified', 'closed · not notified');
        return variant === 'block'
            ? <div className="rounded-lg bg-[var(--bg-secondary)] px-3 py-2.5 text-[12px] text-[var(--text-tertiary)]" data-testid={testId} data-state="not_filed">{text}</div>
            : <span className="text-[11px] text-[var(--text-tertiary)]" data-testid={testId} data-state="not_filed">{text}</span>;
    }
    const done = lastDone(incident);
    if (done) {
        return <DeadlineClock variant={variant} dueAt={done.dueAt} startedAt={startedAtOf(incident)} doneAt={done.sentAt} testId={testId} />;
    }
    return <DeadlineClock variant={variant} dueAt={null} testId={testId} />;
}

/** "Next step": the stage the row waits for, or All filed / Closed, with the filed count for a screen reader. */
export function NextStep({ incident, testId }) {
    const { t } = useTranslation();
    const next = nextClock(incident);
    const { filed, total } = filedCount(incident);
    let text = '—';
    if (incident.status === 'closed') text = t('compliance.inc_status_closed', 'Closed');
    else if (next) text = t(next.labelKey, next.fallback);
    else if (total > 0) text = t('compliance.inc_all_filed', 'All filed');
    return (
        <span className="block min-w-0 truncate text-[11px] text-[var(--text-secondary)]" title={text} data-testid={testId}>
            {text}
            {total > 0 && <span className="sr-only"> · {t('compliance.inc_filed_count', '{n} of {total} filed', { n: filed, total })}</span>}
        </span>
    );
}

export function IncidentStatusPill({ status, testId }) {
    const { t } = useTranslation();
    const meta = STATUS_LABEL[status] || STATUS_LABEL.open;
    return <RegisterStatePill state={status || 'open'} testId={testId}>{t(meta.key, meta.en)}</RegisterStatePill>;
}

export default function IncidentsTable({ rows, selectedId, onSelect, loading = false, isMobile = false, footer, empty, testId = 'inc-table' }) {
    const { t } = useTranslation();
    const { formatDayTime } = useDateFormat();
    const now = useNow();
    const columns = INCIDENT_COLUMNS.map(c => ({ id: c.id, width: c.width, foldBelow: c.foldBelow, label: t(c.labelKey, c.fallback) }));
    const openSeverity = (inc) => inc.status !== 'closed' && inc.severity;
    const occurredOf = (inc) => formatDayTime(inc.occurred_at ?? inc.detected_at) || '—';

    const renderRow = (inc, ctx) => (
        <TableRow
            key={inc.id}
            columns={ctx.columns}
            selected={sameId(selectedId, inc.id)}
            accent={accentOf(inc, now)}
            onClick={() => onSelect?.(inc)}
            testId={`${testId}-row-${inc.id}`}
        >
            <TableCell column={ctx.columns[0]}><IncidentClock incident={inc} testId={`${testId}-clock-${inc.id}`} /></TableCell>
            <TableCell column={ctx.columns[1]} className="min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                    <DrawerId>{incidentRef(inc)}</DrawerId>
                    <span className="truncate font-medium text-[var(--text-primary)]">{inc.title}</span>
                    {openSeverity(inc) && <SeverityTag severity={inc.severity} vocabulary="incident" tone="neutral" testId={`${testId}-severity-${inc.id}`} />}
                </div>
                <div className={`${TABLE_FOLDED_ONLY[900]} text-[11px] text-[var(--text-tertiary)]`}>{occurredOf(inc)}</div>
                {isVulnerability(inc) && Array.isArray(inc.cve_ids) && inc.cve_ids.length > 0 && (
                    <div className="truncate font-mono text-[10px] text-[var(--text-tertiary)]">
                        {inc.cve_ids.join(' · ')}
                        {inc.exploited_in_wild && <span className="ml-1.5 font-sans font-semibold text-[var(--error-ink)]">{t('compliance.vuln_exploited', 'exploited')}</span>}
                    </div>
                )}
            </TableCell>
            <TableCell column={ctx.columns[2]} className="text-[11px] text-[var(--text-secondary)] tabular-nums">{occurredOf(inc)}</TableCell>
            <TableCell column={ctx.columns[3]}><NextStep incident={inc} testId={`${testId}-next-${inc.id}`} /></TableCell>
            <TableCell column={ctx.columns[4]}><IncidentStatusPill status={inc.status} testId={`${testId}-status-${inc.id}`} /></TableCell>
        </TableRow>
    );

    const renderCard = (inc) => (
        <button type="button" onClick={() => onSelect?.(inc)} className="w-full text-left px-3.5 py-2.5 grid grid-cols-[1fr_104px] gap-2 border-b border-[var(--border-default)]" data-testid={`${testId}-card-${inc.id}`}>
            <div className="min-w-0 flex flex-col gap-1">
                <div className="flex items-center gap-2 min-w-0"><DrawerId>{incidentRef(inc)}</DrawerId><span className="truncate text-xs font-medium text-[var(--text-primary)]">{inc.title}</span></div>
                <div className="flex items-center gap-2 min-w-0">
                    <IncidentStatusPill status={inc.status} />
                    <NextStep incident={inc} />
                </div>
            </div>
            <IncidentClock incident={inc} />
        </button>
    );

    return (
        <DataTable
            columns={columns}
            rows={rows}
            rowKey={(r) => r.id}
            renderRow={renderRow}
            renderCard={renderCard}
            isMobile={isMobile}
            loading={loading}
            footer={footer}
            empty={empty}
            ariaLabel={t('compliance.rail_incidents', 'Incidents & breaches')}
            testId={testId}
        />
    );
}
