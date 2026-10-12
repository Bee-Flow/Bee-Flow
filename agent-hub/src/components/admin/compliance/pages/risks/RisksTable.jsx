import React from 'react';
import { TriangleAlert } from 'lucide-react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import DataTable, { TableRow, TableCell, TABLE_FOLDED_ONLY } from '../../../../shared/DataTable';
import { DrawerId } from '../../../../shared/SideDrawer';
import { TONES, toneOfSeverity } from '../../../../shared/statusTone';
import RegisterStatePill from '../../shared/RegisterStatePill';

/**
 * RisksTable — R-{id} · Risk · Score · Status · Owner (the 1c/1d table
 * pattern for the ISO 27001 6.1.2 register). The score pill wears the tone
 * of the SEVERITY the score band maps to (16–25 critical, 10–15 high, 5–9
 * medium, 1–4 low) — `toneOfSeverity`, not a fourth palette. The status is
 * the register's lifecycle state (RegisterStatePill) with the number of
 * treatment actions beside it; the row's stripe keeps the urgency.
 *
 * The title line holds only the title, so a "review overdue" flag can never
 * shrink it: the flag leads the second line, before the category and the
 * scenario. Below 900px of card width the Owner column folds and the owner
 * joins that second line.
 */
export const RISK_COLUMNS = Object.freeze([
    Object.freeze({ id: 'ref', width: '64px', labelKey: 'compliance.risk_col_ref', fallback: 'Risk' }),
    Object.freeze({ id: 'risk', width: '1fr', labelKey: 'compliance.risk_col_title', fallback: 'Title · scenario' }),
    Object.freeze({ id: 'score', width: '110px', labelKey: 'compliance.risk_col_score', fallback: 'Score' }),
    Object.freeze({ id: 'status', width: '150px', labelKey: 'compliance.risk_col_status', fallback: 'Status' }),
    Object.freeze({ id: 'owner', width: '120px', labelKey: 'compliance.risk_col_owner', fallback: 'Owner', foldBelow: 900 }),
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

/** The risk's lifecycle state in the register vocabulary (statusVocabulary). */
export function RiskStatusPill({ status, className = '', testId = undefined }) {
    const { t } = useTranslation();
    const key = RISK_STATUSES.includes(status) ? status : 'open';
    return (
        <RegisterStatePill state={key} className={className} testId={testId}>
            {t(`compliance.risk_status_${key}`, STATUS_EN[key])}
        </RegisterStatePill>
    );
}

const STATUS_EN = Object.freeze({ open: 'Open', treating: 'Treating', accepted: 'Accepted', closed: 'Closed' });

/** "· 2 actions": the treatment plan's size, beside the status. Nothing for none. */
function ActionCount({ count, testId = undefined }) {
    const { t } = useTranslation();
    if (!(count > 0)) return null;
    return (
        <span className="text-[11px] text-[var(--text-tertiary)] tabular-nums whitespace-nowrap" data-testid={testId}>
            {count === 1 ? t('compliance.risk_actions_n_one', '· 1 action') : t('compliance.risk_actions_n', '· {n} actions', { n: count })}
        </span>
    );
}

/** The "review overdue" flag, in the warning ink with a glyph (so it is not colour alone). */
function OverdueFlag({ testId }) {
    const { t } = useTranslation();
    return (
        <span className="inline-flex items-center gap-1 font-semibold whitespace-nowrap text-[var(--warning-ink)]" data-testid={testId}>
            <TriangleAlert size={10} aria-hidden="true" /> {t('compliance.risk_overdue_pill', 'review overdue')}
        </span>
    );
}

function categoryLabel(t, category) {
    if (!category) return null;
    return CATEGORIES.includes(category) ? t(`compliance.risk_cat_${category}`, category) : category;
}

export default function RisksTable({ rows, treatmentsByRisk, orgUsers, selectedId, onSelect, loading = false, isMobile = false, footer, empty, testId = 'risk-table' }) {
    const { t } = useTranslation();
    const columns = RISK_COLUMNS.map(c => ({ id: c.id, width: c.width, foldBelow: c.foldBelow, label: t(c.labelKey, c.fallback) }));

    const renderRow = (r, ctx) => {
        const count = treatmentsByRisk?.get?.(r.id)?.length ?? 0;
        const overdue = isReviewOverdue(r);
        const owner = ownerName(orgUsers, r.owner_user_id);
        const category = categoryLabel(t, r.category);
        const scenario = [category, r.description].filter(Boolean).join(' · ');
        return (
            <TableRow
                key={r.id}
                columns={ctx.columns}
                selected={selectedId === r.id}
                accent={r.status === 'closed' ? null : toneOfRiskStatus(r.status)}
                onClick={() => onSelect?.(r)}
                testId={`${testId}-row-${r.id}`}
            >
                <TableCell column={ctx.columns[0]} className="whitespace-nowrap"><DrawerId>{riskRef(r)}</DrawerId></TableCell>
                <TableCell column={ctx.columns[1]} className="min-w-0">
                    <div className="truncate font-medium text-[var(--text-primary)]" title={r.title}>{r.title}</div>
                    <div className="truncate text-[11px] text-[var(--text-secondary)]" data-testid={`${testId}-meta-${r.id}`}>
                        {/* Separators only between parts on screen: the owner shows only while its column is folded. */}
                        {overdue && <OverdueFlag testId={`${testId}-overdue-${r.id}`} />}
                        {owner && <span className={TABLE_FOLDED_ONLY[900]}>{overdue ? ' · ' : ''}{owner}</span>}
                        {scenario && (overdue ? ' · ' : (owner ? <span className={TABLE_FOLDED_ONLY[900]}>{' · '}</span> : null))}
                        {scenario}
                    </div>
                </TableCell>
                <TableCell column={ctx.columns[2]}><ScorePill risk={r} testId={`${testId}-score-${r.id}`} /></TableCell>
                <TableCell column={ctx.columns[3]} className="flex items-center gap-1.5">
                    <RiskStatusPill status={r.status} testId={`${testId}-status-${r.id}`} />
                    <ActionCount count={count} testId={`${testId}-actions-${r.id}`} />
                </TableCell>
                <TableCell column={ctx.columns[4]} className="truncate text-[11px]">{owner || '—'}</TableCell>
            </TableRow>
        );
    };

    const renderCard = (r) => {
        const overdue = isReviewOverdue(r);
        const owner = ownerName(orgUsers, r.owner_user_id);
        const count = treatmentsByRisk?.get?.(r.id)?.length ?? 0;
        return (
            <button type="button" onClick={() => onSelect?.(r)} className="w-full text-left flex flex-col gap-1" data-testid={`${testId}-card-${r.id}`}>
                <div className="flex items-center justify-between gap-2"><DrawerId>{riskRef(r)}</DrawerId><ScorePill risk={r} /></div>
                <div className="text-xs font-medium text-[var(--text-primary)] truncate">{r.title}</div>
                <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-[var(--text-secondary)]">
                    <RiskStatusPill status={r.status} className="self-start" />
                    <ActionCount count={count} />
                    {overdue && <OverdueFlag testId={`${testId}-card-overdue-${r.id}`} />}
                    <span className="truncate" data-testid={`${testId}-card-owner-${r.id}`}>{owner || t('compliance.risk_owner_none', 'No owner')}</span>
                </div>
            </button>
        );
    };

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
