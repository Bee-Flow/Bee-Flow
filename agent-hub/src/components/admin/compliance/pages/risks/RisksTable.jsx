import React from 'react';
import { TriangleAlert } from 'lucide-react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import DataTable, { TableRow, TableCell } from '../../../../shared/DataTable';
import { DrawerId } from '../../../../shared/SideDrawer';
import { TONES, toneOfSeverity } from '../../../../shared/statusTone';
import StatusPill from '../../shared/StatusPill';

/**
 * RisksTable — R-{id} · Risk · Score · Treatment · Owner (the 1c/1d table
 * pattern for the ISO 27001 6.1.2 register). The score pill wears the tone
 * of the SEVERITY the score band maps to (16–25 critical, 10–15 high, 5–9
 * medium, 1–4 low) — `toneOfSeverity`, not a fourth palette.
 */
export const RISK_COLUMNS = Object.freeze([
    Object.freeze({ id: 'ref', width: '58px', labelKey: 'compliance.risk_col_ref', fallback: 'Risk' }),
    Object.freeze({ id: 'risk', width: '1fr', labelKey: 'compliance.risk_col_title', fallback: 'Title · scenario' }),
    Object.freeze({ id: 'score', width: '110px', labelKey: 'compliance.risk_col_score', fallback: 'Score' }),
    Object.freeze({ id: 'treatment', width: '110px', labelKey: 'compliance.risk_col_treatment', fallback: 'Treatment' }),
    Object.freeze({ id: 'owner', width: '92px', labelKey: 'compliance.risk_col_owner', fallback: 'Owner' }),
]);

export const CATEGORIES = Object.freeze(['confidentiality', 'integrity', 'availability', 'compliance']);
export const OPTIONS = Object.freeze(['mitigate', 'transfer', 'avoid', 'accept']);
export const SCALE = Object.freeze([1, 2, 3, 4, 5]);
export const RISK_STATUSES = Object.freeze(['open', 'treating', 'accepted', 'closed']);

export const riskRef = (r) => `R-${r.id}`;

/** Score band → severity word (the register's bands since it shipped). */
export function severityOfScore(score) {
    const n = Number(score);
    if (Number.isNaN(n)) return null;
    if (n >= 16) return 'critical';
    if (n >= 10) return 'high';
    if (n >= 5) return 'medium';
    return 'low';
}

export const scoreOf = (r) => (r?.score ?? (Number(r?.likelihood) || 0) * (Number(r?.impact) || 0));

export function toneOfRiskStatus(status) {
    switch (status) {
        case 'open': return 'error';
        case 'treating': return 'warning';
        case 'closed': return 'success';
        default: return 'neutral'; // accepted
    }
}

export const isReviewOverdue = (r, now = Date.now()) => !!(r?.review_due_at && r.status !== 'closed' && new Date(r.review_due_at).getTime() < now);

export function ownerName(orgUsers, id) {
    if (!id) return null;
    const u = (Array.isArray(orgUsers) ? orgUsers : []).find(x => x.id === id);
    return u ? (u.displayName || null) : null;
}

export function ScorePill({ risk, testId }) {
    const { t } = useTranslation();
    const score = scoreOf(risk);
    const severity = severityOfScore(score);
    const tone = toneOfSeverity(severity);
    return (
        <span className="inline-flex items-center gap-1.5" data-testid={testId} data-severity={severity}>
            <span
                className="inline-flex items-center justify-center min-w-[26px] px-1.5 py-[1px] rounded-md text-[11px] font-bold tabular-nums"
                style={{ border: `1px solid ${TONES[tone].raw}`, color: TONES[tone].ink }}
            >
                {score}
            </span>
            <span className="text-[10px] text-[var(--text-tertiary)] whitespace-nowrap">
                {t('compliance.risk_score_formula', 'L{likelihood} × I{impact}', { likelihood: risk.likelihood, impact: risk.impact })}
            </span>
        </span>
    );
}

export function RiskStatusPill({ status, count }) {
    const { t } = useTranslation();
    const key = RISK_STATUSES.includes(status) ? status : 'open';
    return (
        <StatusPill tone={toneOfRiskStatus(key)} className="whitespace-nowrap">
            {t(`compliance.risk_status_${key}`, STATUS_EN[key])}
            {count > 0 && <span className="text-[var(--text-tertiary)] font-normal tabular-nums">· {count}</span>}
        </StatusPill>
    );
}

const STATUS_EN = Object.freeze({ open: 'Open', treating: 'Treating', accepted: 'Accepted', closed: 'Closed' });

export default function RisksTable({ rows, treatmentsByRisk, orgUsers, selectedId, onSelect, loading = false, isMobile = false, footer, empty, testId = 'risk-table' }) {
    const { t } = useTranslation();
    const columns = RISK_COLUMNS.map(c => ({ id: c.id, width: c.width, label: t(c.labelKey, c.fallback) }));

    const renderRow = (r, ctx) => {
        const count = treatmentsByRisk?.get?.(r.id)?.length ?? 0;
        const overdue = isReviewOverdue(r);
        return (
            <TableRow
                key={r.id}
                columns={ctx.columns}
                selected={selectedId === r.id}
                accent={r.status === 'closed' ? null : toneOfRiskStatus(r.status)}
                onClick={() => onSelect?.(r)}
                testId={`${testId}-row-${r.id}`}
            >
                <TableCell column={ctx.columns[0]}><DrawerId>{riskRef(r)}</DrawerId></TableCell>
                <TableCell column={ctx.columns[1]} className="min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                        <span className="truncate font-medium text-[var(--text-primary)]">{r.title}</span>
                        {overdue && (
                            <span className="inline-flex items-center gap-1 text-[10px] font-semibold whitespace-nowrap" style={{ color: TONES.warning.ink }} data-testid={`${testId}-overdue-${r.id}`}>
                                <TriangleAlert size={10} aria-hidden="true" /> {t('compliance.risk_overdue_pill', 'review overdue')}
                            </span>
                        )}
                    </div>
                    <div className="truncate text-[11px] text-[var(--text-secondary)]">
                        {r.category ? (CATEGORIES.includes(r.category) ? t(`compliance.risk_cat_${r.category}`, r.category) : r.category) : null}
                        {r.category && r.description ? ' · ' : ''}
                        {r.description || ''}
                    </div>
                </TableCell>
                <TableCell column={ctx.columns[2]}><ScorePill risk={r} testId={`${testId}-score-${r.id}`} /></TableCell>
                <TableCell column={ctx.columns[3]}><RiskStatusPill status={r.status} count={count} /></TableCell>
                <TableCell column={ctx.columns[4]} className="truncate text-[11px]">{ownerName(orgUsers, r.owner_user_id) || '—'}</TableCell>
            </TableRow>
        );
    };

    const renderCard = (r) => (
        <button type="button" onClick={() => onSelect?.(r)} className="w-full text-left px-3.5 py-2.5 flex flex-col gap-1 border-b border-[var(--border-default)]" data-testid={`${testId}-card-${r.id}`}>
            <div className="flex items-center justify-between gap-2"><DrawerId>{riskRef(r)}</DrawerId><ScorePill risk={r} /></div>
            <div className="text-xs font-medium text-[var(--text-primary)] truncate">{r.title}</div>
            <RiskStatusPill status={r.status} />
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
            ariaLabel={t('compliance.rail_risks', 'Risk register')}
            testId={testId}
        />
    );
}
