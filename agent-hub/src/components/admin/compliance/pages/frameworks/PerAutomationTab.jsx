import React from 'react';
import { Bot, Workflow } from 'lucide-react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import DataTable, { TableRow, TableCell } from '../../../../shared/DataTable';
import DeadlineClock from '../../../../shared/DeadlineClock';
import EmptyState from '../../../../shared/EmptyState';
import StatusPill from '../../shared/StatusPill';
import { useAiActAssessments } from '../../data/aggregates';

/**
 * PerAutomationTab — the AI Act ladder outcome per automation / agent
 * (Frameworks page, tab `per_automation`). Rows are `GET /ai-act/assessments`:
 *   [{ target_kind, target_id, title, outcome, attested_by, attested_at, expires_at, current }]
 * The row action calls `onOpenLadder(kind, id)` — fe-8 owns the modal.
 * A failed read is its own state; an unshipped endpoint (404) reads as failed too.
 */

/**
 * Outcome → pill tone + label key. The vocabulary is `server/compliance/aiAct/assess.js`
 * (`prohibited | high_risk | transparency | minimal | not_applicable`); the chip keys are
 * fe-8's (`keys/fe-8-ai-act-ladder.json`). Unknown outcomes fall back to neutral + the raw word.
 */
export const OUTCOME_PILL = Object.freeze({
    prohibited: { tone: 'error', key: 'compliance.ladder_outcome_chip_prohibited', fallback: 'Prohibited (Art. 5)' },
    high_risk: { tone: 'error', key: 'compliance.ladder_outcome_chip_high_risk', fallback: 'High-risk (Annex III)' },
    transparency: { tone: 'warning', key: 'compliance.ladder_outcome_chip_transparency', fallback: 'Art. 4 + Art. 50' },
    minimal: { tone: 'success', key: 'compliance.ladder_outcome_chip_minimal', fallback: 'Minimal risk' },
    not_applicable: { tone: 'neutral', key: 'compliance.ladder_outcome_chip_not_applicable', fallback: 'AI Act not applicable' },
});

export function outcomePill(outcome) {
    return OUTCOME_PILL[outcome] || { tone: 'neutral', key: null, fallback: String(outcome ?? '—') };
}

const KIND_ICON = Object.freeze({ agent: Bot, automation: Workflow });

export default function PerAutomationTab({ onOpenLadder, isMobile = false, testId = 'fw-per-automation' }) {
    const { t } = useTranslation();
    const { assessments, failed } = useAiActAssessments({ enabled: true });
    const rows = Array.isArray(assessments) ? assessments : [];
    const loading = !failed && assessments === null;

    const columns = [
        { id: 'target', width: '1fr', label: t('compliance.fw_pa_col_target', 'Automation / agent') },
        { id: 'outcome', width: '150px', label: t('compliance.fw_pa_col_outcome', 'Outcome') },
        { id: 'attested', width: '120px', label: t('compliance.fw_pa_col_attested', 'Attested'), foldBelow: 1180 },
        { id: 'expiry', width: '150px', label: t('compliance.fw_pa_col_expiry', 'Valid') },
        { id: 'action', width: '96px', label: '' },
    ];

    if (failed) {
        return (
            <div className="p-3.5" data-testid={`${testId}-failed`}>
                <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] px-3.5 py-3 text-xs text-[var(--text-tertiary)]">
                    {t('compliance.fw_pa_read_failed', 'The AI Act assessments could not be read.')}
                </div>
            </div>
        );
    }

    return (
        <div className="h-full min-h-0 overflow-y-auto p-3.5" data-testid={testId}>
            <DataTable
                columns={columns}
                rows={rows}
                loading={loading}
                isMobile={isMobile}
                rowKey={(r) => `${r.target_kind}:${r.target_id}`}
                ariaLabel={t('compliance.tab_frameworks_per_automation', 'Per automation')}
                testId={`${testId}-table`}
                empty={(
                    <EmptyState
                        title={t('compliance.fw_pa_empty_title', 'No assessments yet')}
                        description={t('compliance.fw_pa_empty_desc', 'Run the AI Act ladder on an agent or automation — the outcome lands here with its expiry.')}
                    />
                )}
                renderCard={(r) => {
                    const pill = outcomePill(r.outcome);
                    const Icon = KIND_ICON[r.target_kind] || Workflow;
                    const expired = r.current === false;
                    return (
                        <div className="w-full min-w-0 flex items-center gap-2" data-testid={`${testId}-card`}>
                            <div className="flex-1 min-w-0 flex flex-col gap-1">
                                <span className="flex items-center gap-2 min-w-0">
                                    <Icon size={13} className="text-[var(--text-secondary)] shrink-0" aria-hidden="true" />
                                    <span className="truncate text-xs font-medium">{r.title || r.target_id}</span>
                                    <span className="text-[10px] uppercase tracking-[.06em] text-[var(--text-tertiary)] shrink-0">{t(`compliance.fw_pa_kind_${r.target_kind}`, r.target_kind)}</span>
                                </span>
                                <span className="flex items-center gap-2 min-w-0 text-[11px]">
                                    <StatusPill tone={pill.tone} testId={`${testId}-outcome`}>{pill.key ? t(pill.key, pill.fallback) : pill.fallback}</StatusPill>
                                    {r.expires_at
                                        ? <DeadlineClock dueAt={r.expires_at} startedAt={r.attested_at} variant="inline" testId={`${testId}-clock`} />
                                        : <span className="text-[var(--text-tertiary)] truncate">{t('compliance.fw_pa_evergreen', 'does not expire')}</span>}
                                </span>
                                <span className="text-[11px] text-[var(--text-secondary)]">{formatDay(r.attested_at)}</span>
                            </div>
                            <button
                                type="button"
                                className="shrink-0 min-h-[44px] px-2.5 rounded-md border border-[var(--border-default)] text-[11px] font-medium"
                                onClick={() => onOpenLadder?.(r.target_kind, r.target_id, r.title)}
                                data-testid={`${testId}-open`}
                            >
                                {expired ? t('compliance.fw_pa_reassess', 'Reassess') : t('compliance.fw_pa_open', 'Open')}
                            </button>
                        </div>
                    );
                }}
                renderRow={(r, ctx) => {
                    const pill = outcomePill(r.outcome);
                    const Icon = KIND_ICON[r.target_kind] || Workflow;
                    const expired = r.current === false;
                    return (
                        <TableRow key={`${r.target_kind}:${r.target_id}`} columns={ctx.columns} accent={expired ? 'warning' : null} testId={`${testId}-row`}>
                            <TableCell column={ctx.columns[0]} className="min-w-0 flex items-center gap-2">
                                <Icon size={13} className="text-[var(--text-secondary)] shrink-0" aria-hidden="true" />
                                <span className="truncate font-medium">{r.title || r.target_id}</span>
                                <span className="text-[10px] uppercase tracking-[.06em] text-[var(--text-tertiary)]">{t(`compliance.fw_pa_kind_${r.target_kind}`, r.target_kind)}</span>
                            </TableCell>
                            <TableCell column={ctx.columns[1]}>
                                <StatusPill tone={pill.tone} testId={`${testId}-outcome`}>{pill.key ? t(pill.key, pill.fallback) : pill.fallback}</StatusPill>
                            </TableCell>
                            <TableCell column={ctx.columns[2]} className="text-[11px] text-[var(--text-secondary)]">{formatDay(r.attested_at)}</TableCell>
                            <TableCell column={ctx.columns[3]}>
                                {r.expires_at
                                    ? <DeadlineClock dueAt={r.expires_at} startedAt={r.attested_at} variant="row" testId={`${testId}-clock`} />
                                    : <span className="text-[11px] text-[var(--text-tertiary)]">{t('compliance.fw_pa_evergreen', 'does not expire')}</span>}
                            </TableCell>
                            <TableCell column={ctx.columns[4]} align="right">
                                <button
                                    type="button"
                                    className="px-2 py-0.5 rounded-md border border-[var(--border-default)] text-[11px] font-medium"
                                    onClick={() => onOpenLadder?.(r.target_kind, r.target_id, r.title)}
                                    data-testid={`${testId}-open`}
                                >
                                    {expired ? t('compliance.fw_pa_reassess', 'Reassess') : t('compliance.fw_pa_open', 'Open')}
                                </button>
                            </TableCell>
                        </TableRow>
                    );
                }}
            />
        </div>
    );
}

function formatDay(value) {
    const ms = value ? new Date(value).getTime() : NaN;
    if (Number.isNaN(ms)) return '—';
    return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
