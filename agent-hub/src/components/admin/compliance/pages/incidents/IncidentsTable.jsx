import React from 'react';
import { Mail, Landmark, Users, Siren, FileText, Building2 } from 'lucide-react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import DataTable, { TableRow, TableCell } from '../../../../shared/DataTable';
import DeadlineClock from '../../../../shared/DeadlineClock';
import { TONES } from '../../../../shared/statusTone';
import StatusPill from '../../shared/StatusPill';
import SeverityTag from '../../shared/SeverityTag';
import { DrawerId } from '../../../../shared/SideDrawer';
import { isVulnerability, lastDone, nextClock, startedAtOf, toneOfIncidentStatus, STATUS_LABEL } from './incidentClocks';

/**
 * IncidentsTable — Clock · Incident · Occurred · Reported · Status (the 1c
 * table pattern). Serves both registers: for a vulnerability row the clock
 * is the next open CRA stage and the "reported" stamps are the CRA ones.
 */
export const INCIDENT_COLUMNS = Object.freeze([
    Object.freeze({ id: 'clock', width: '118px', labelKey: 'compliance.inc_col_clock', fallback: 'Deadline' }),
    Object.freeze({ id: 'incident', width: '1fr', labelKey: 'compliance.inc_col_incident', fallback: 'Incident' }),
    Object.freeze({ id: 'occurred', width: '104px', labelKey: 'compliance.inc_col_occurred', fallback: 'Occurred' }),
    Object.freeze({ id: 'reported', width: '110px', labelKey: 'compliance.inc_col_reported', fallback: 'Reported' }),
    Object.freeze({ id: 'status', width: '92px', labelKey: 'compliance.inc_col_status', fallback: 'Status' }),
]);

export const incidentRef = (inc) => (isVulnerability(inc) ? `VULN-${inc.id}` : `INC-${inc.id}`);

export function formatWhen(value, t) {
    const ms = value ? new Date(value).getTime() : NaN;
    if (Number.isNaN(ms)) return '—';
    const d = new Date(ms);
    const now = new Date();
    const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    if (sameDay) return t('compliance.inc_today_at', 'today {time}', { time: d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) });
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** The row's clock: the next open stage; a fully reported/closed row shows its completion. */
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
    const done = lastDone(incident);
    if (done) {
        return <DeadlineClock variant={variant} dueAt={done.dueAt} startedAt={startedAtOf(incident)} doneAt={done.sentAt} testId={testId} />;
    }
    return <DeadlineClock variant={variant} dueAt={null} testId={testId} />;
}

/** One stamp glyph: success ink when done, tertiary otherwise; the title says which. */
function Stamp({ icon: Icon, done, label }) {
    return (
        <span
            title={label}
            aria-label={label}
            data-done={done ? 'true' : 'false'}
            className="inline-flex"
            style={{ color: done ? TONES.success.ink : 'var(--text-tertiary)' }}
        >
            <Icon size={13} aria-hidden="true" />
        </span>
    );
}

/** The "Reported" cell — GDPR: recipients · authority · subjects; CRA: early warning · full report · customers. */
export function ReportedStamps({ incident }) {
    const { t } = useTranslation();
    if (isVulnerability(incident)) {
        return (
            <span className="inline-flex items-center gap-1.5" data-testid="reported-stamps">
                <Stamp icon={Siren} done={!!incident.early_warning_sent_at} label={t('compliance.vuln_stamp_early_warning', 'Early warning')} />
                <Stamp icon={FileText} done={!!(incident.notification_sent_at || incident.authority_notified_at || incident.reported_at)} label={t('compliance.vuln_stamp_full_report', 'Full report')} />
                <Stamp icon={Building2} done={!!incident.customer_notified_at} label={t('compliance.vuln_stamp_customers', 'Customers notified')} />
            </span>
        );
    }
    return (
        <span className="inline-flex items-center gap-1.5" data-testid="reported-stamps">
            <Stamp icon={Mail} done={!!incident.recipients_notified_at} label={t('compliance.inc_stamp_recipients', 'Internal recipients')} />
            <Stamp icon={Landmark} done={!!incident.authority_notified_at} label={t('compliance.inc_stamp_authority', 'Supervisory authority (Art. 33)')} />
            {incident.high_risk && <Stamp icon={Users} done={!!incident.subjects_notified_at} label={t('compliance.inc_stamp_subjects', 'Data subjects (Art. 34)')} />}
        </span>
    );
}

export function IncidentStatusPill({ status }) {
    const { t } = useTranslation();
    const meta = STATUS_LABEL[status] || STATUS_LABEL.open;
    return <StatusPill tone={toneOfIncidentStatus(status)} className="whitespace-nowrap">{t(meta.key, meta.en)}</StatusPill>;
}

export default function IncidentsTable({ rows, selectedId, onSelect, loading = false, isMobile = false, footer, empty, testId = 'inc-table' }) {
    const { t } = useTranslation();
    const columns = INCIDENT_COLUMNS.map(c => ({ id: c.id, width: c.width, label: t(c.labelKey, c.fallback) }));
    const openSeverity = (inc) => inc.status !== 'closed' && inc.severity;

    const renderRow = (inc, ctx) => (
        <TableRow
            key={inc.id}
            columns={ctx.columns}
            selected={selectedId === inc.id}
            accent={inc.status === 'closed' ? null : (inc.status === 'open' ? 'error' : 'warning')}
            onClick={() => onSelect?.(inc)}
            testId={`${testId}-row-${inc.id}`}
        >
            <TableCell column={ctx.columns[0]}><IncidentClock incident={inc} testId={`${testId}-clock-${inc.id}`} /></TableCell>
            <TableCell column={ctx.columns[1]} className="min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                    <DrawerId>{incidentRef(inc)}</DrawerId>
                    <span className="truncate font-medium text-[var(--text-primary)]">{inc.title}</span>
                    {openSeverity(inc) && <SeverityTag severity={inc.severity} />}
                </div>
                {isVulnerability(inc) && Array.isArray(inc.cve_ids) && inc.cve_ids.length > 0 && (
                    <div className="truncate font-mono text-[10px] text-[var(--text-tertiary)]">
                        {inc.cve_ids.join(' · ')}
                        {inc.exploited_in_wild && <span className="ml-1.5 font-sans font-semibold" style={{ color: TONES.error.ink }}>{t('compliance.vuln_exploited', 'exploited')}</span>}
                    </div>
                )}
            </TableCell>
            <TableCell column={ctx.columns[2]} className="text-[11px] text-[var(--text-secondary)]">{formatWhen(inc.occurred_at ?? inc.detected_at, t)}</TableCell>
            <TableCell column={ctx.columns[3]}><ReportedStamps incident={inc} /></TableCell>
            <TableCell column={ctx.columns[4]}><IncidentStatusPill status={inc.status} /></TableCell>
        </TableRow>
    );

    const renderCard = (inc) => (
        <button type="button" onClick={() => onSelect?.(inc)} className="w-full text-left px-3.5 py-2.5 grid grid-cols-[1fr_104px] gap-2 border-b border-[var(--border-default)]" data-testid={`${testId}-card-${inc.id}`}>
            <div className="min-w-0 flex flex-col gap-1">
                <div className="flex items-center gap-2 min-w-0"><DrawerId>{incidentRef(inc)}</DrawerId><span className="truncate text-xs font-medium text-[var(--text-primary)]">{inc.title}</span></div>
                <IncidentStatusPill status={inc.status} />
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
