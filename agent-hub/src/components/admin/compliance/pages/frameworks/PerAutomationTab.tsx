import type { LucideIcon } from 'lucide-react';
import { Bot, Workflow } from 'lucide-react';
import React, { useState } from 'react';
import type { TranslateFn } from '@/hooks/useTranslation';
import { useTranslation } from '@/hooks/useTranslation';
import type { DataTableContext, RowLike, TableColumn } from '@/components/shared/DataTable';
import DataTable, { TableRow, TableCell } from '@/components/shared/DataTable';
import DeadlineClock from '@/components/shared/DeadlineClock';
import EmptyState from '@/components/shared/EmptyState';
import SegmentedControl from '@/components/shared/SegmentedControl';
import { useAiActAssessments } from '../../data/aggregates';
import type { DateLike } from '../../shared/formatDates';
import { useDateFormat } from '../../shared/formatDates';
import StatusPill from '../../shared/StatusPill';
import type { Tone } from '@/components/shared/statusTone';

/**
 * Whether the assessed automation / agent still exists: `live`, in the trash
 * (`trashed`, automations only) or removed for good (`gone`, no title).
 */
export type TargetState = 'live' | 'trashed' | 'gone';

/** One row of GET /ai-act/assessments (routes/compliance/aiAct.js): the newest attestation per target. */
export interface AiActAssessment extends RowLike {
    target_kind: string;
    target_id: string;
    title?: string | null;
    target_state?: TargetState | null;
    outcome: string;
    attested_by?: string | null;
    attested_at?: string | null;
    expires_at?: string | null;
    current?: boolean;
}

interface OutcomePill {
    tone: Tone;
    key: string | null;
    fallback: string;
}

/**
 * PerAutomationTab — the AI Act ladder outcome per automation / agent
 * (AI Act page, tab `systems`; the old More frameworks › Per automation link
 * lands there through sections.js legacyTabs). Rows are `GET /ai-act/assessments`:
 *   [{ target_kind, target_id, title, outcome, attested_by, attested_at, expires_at, current }]
 * The row action calls `onOpenLadder(kind, id)` — fe-8 owns the modal.
 * A failed read is its own state; an unshipped endpoint (404) reads as failed too.
 *
 * The default view lists live targets only. An assessment whose automation
 * is in the trash or removed for good (or whose agent was deleted) stays on
 * record and is shown under "Removed", named "Deleted automation" / "Deleted
 * agent" when its title is gone: a raw id is never shown as a title. Such a
 * row has no action (the target can no longer be assessed).
 */

/**
 * Outcome → pill tone + label key. The vocabulary is `server/core/aiAct/assess.js`
 * (`prohibited | high_risk | transparency | minimal | not_applicable`); the chip keys are
 * fe-8's (`keys/fe-8-ai-act-ladder.json`). Unknown outcomes fall back to neutral + the raw word.
 */
const OUTCOME_PILL: Readonly<Record<string, OutcomePill>> = Object.freeze({
    prohibited: { tone: 'error', key: 'compliance.ladder_outcome_chip_prohibited', fallback: 'Prohibited (Art. 5)' },
    high_risk: { tone: 'error', key: 'compliance.ladder_outcome_chip_high_risk', fallback: 'High-risk (Annex III)' },
    transparency: { tone: 'warning', key: 'compliance.ladder_outcome_chip_transparency', fallback: 'Art. 4 + Art. 50' },
    minimal: { tone: 'success', key: 'compliance.ladder_outcome_chip_minimal', fallback: 'Minimal risk' },
    not_applicable: { tone: 'neutral', key: 'compliance.ladder_outcome_chip_not_applicable', fallback: 'AI Act not applicable' },
});

function outcomePill(outcome: string): OutcomePill {
    return OUTCOME_PILL[outcome] || { tone: 'neutral', key: null, fallback: String(outcome ?? '—') };
}

const KIND_ICON: Readonly<Record<string, LucideIcon>> = Object.freeze({ agent: Bot, automation: Workflow });

type RegisterView = 'current' | 'removed';

/** A row's target state; a row from a server that does not send one counts as live. */
function targetStateOf(r: AiActAssessment): TargetState {
    return r.target_state === 'trashed' || r.target_state === 'gone' ? r.target_state : 'live';
}

/** The name a row shows: its title, else a word for what it was — never its id. */
function targetTitle(r: AiActAssessment, t: TranslateFn): string {
    if (r.title) return r.title;
    if (targetStateOf(r) === 'live') return t('compliance.fw_pa_untitled', 'Untitled');
    return r.target_kind === 'agent'
        ? t('compliance.fw_pa_deleted_agent', 'Deleted agent')
        : t('compliance.fw_pa_deleted_automation', 'Deleted automation');
}

interface TargetLabelProps {
    row: AiActAssessment;
    testId: string;
}

/** Icon, name, kind and (for a trashed target) the "In trash" tag. */
function TargetLabel({ row, testId }: TargetLabelProps) {
    const { t } = useTranslation();
    const Icon = KIND_ICON[row.target_kind] || Workflow;
    const trashed = targetStateOf(row) === 'trashed';
    return (
        <>
            <Icon size={13} className="text-[var(--text-secondary)] shrink-0" aria-hidden="true" />
            <span className="truncate font-medium" data-testid={`${testId}-title`}>{targetTitle(row, t)}</span>
            <span className="text-[10px] uppercase tracking-[.06em] text-[var(--text-tertiary)] shrink-0">{t(`compliance.fw_pa_kind_${row.target_kind}`, row.target_kind)}</span>
            {trashed && (
                <StatusPill tone="neutral" testId={`${testId}-trashed`}>{t('compliance.fw_pa_state_trashed', 'In trash')}</StatusPill>
            )}
        </>
    );
}

interface PerAutomationTabProps {
    onOpenLadder?: (kind: string, id: string, title?: string | null) => void;
    isMobile?: boolean;
    testId?: string;
}

export default function PerAutomationTab({ onOpenLadder, isMobile = false, testId = 'fw-per-automation' }: PerAutomationTabProps) {
    const { t } = useTranslation();
    const { formatDay: formatDayIn } = useDateFormat();
    // A row without a readable date shows a dash, never "Invalid Date".
    const formatDay = (value: DateLike) => formatDayIn(value) || '—';
    const { assessments, failed } = useAiActAssessments<AiActAssessment>({ enabled: true });
    const all: AiActAssessment[] = Array.isArray(assessments) ? assessments : [];
    const live = all.filter((r) => targetStateOf(r) === 'live');
    const removed = all.filter((r) => targetStateOf(r) !== 'live');
    const [view, setView] = useState<RegisterView>('current');
    const rows = view === 'removed' ? removed : live;
    const loading = !failed && assessments === null;

    const columns: TableColumn[] = [
        { id: 'target', width: '1fr', label: t('compliance.fw_pa_col_target', 'Automation / agent') },
        { id: 'outcome', width: '150px', label: t('compliance.fw_pa_col_outcome', 'Outcome') },
        { id: 'attested', width: '120px', label: t('compliance.fw_pa_col_attested', 'Attested'), foldBelow: 900 },
        { id: 'expiry', width: '150px', label: t('compliance.fw_pa_col_expiry', 'Valid') },
        { id: 'action', width: '96px', label: '' },
    ];

    if (failed) {
        return (
            <div data-testid={`${testId}-failed`}>
                <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] px-3.5 py-3 text-xs text-[var(--text-tertiary)]">
                    {t('compliance.fw_pa_read_failed', 'The AI Act assessments could not be read.')}
                </div>
            </div>
        );
    }

    return (
        // The framework page around it owns the frame (padding, scroll).
        <div className="min-w-0" data-testid={testId}>
            {(removed.length > 0 || view === 'removed') && (
                <div className="mb-3 flex" data-testid={`${testId}-view`}>
                    <SegmentedControl<RegisterView>
                        size="sm"
                        value={view}
                        onChange={setView}
                        ariaLabel={t('compliance.fw_pa_view_aria', 'Which assessments to show')}
                        options={[
                            { value: 'current', label: t('compliance.fw_pa_view_current', 'Current'), badge: live.length },
                            { value: 'removed', label: t('compliance.fw_pa_view_removed', 'Removed'), badge: removed.length },
                        ]}
                    />
                </div>
            )}
            <DataTable
                columns={columns}
                rows={rows}
                loading={loading}
                isMobile={isMobile}
                rowKey={(r) => `${r.target_kind}:${r.target_id}`}
                ariaLabel={t('compliance.tab_aia_systems', 'Systems')}
                testId={`${testId}-table`}
                empty={(
                    <EmptyState
                        title={t('compliance.fw_pa_empty_title', 'No assessments yet')}
                        description={t('compliance.fw_pa_empty_desc', 'Run the AI Act ladder on an agent or automation — the outcome lands here with its expiry.')}
                    />
                )}
                renderCard={(r: AiActAssessment) => {
                    const pill = outcomePill(r.outcome);
                    const isLive = targetStateOf(r) === 'live';
                    const expired = r.current === false;
                    return (
                        <div className="w-full min-w-0 flex items-center gap-2" data-testid={`${testId}-card`}>
                            <div className="flex-1 min-w-0 flex flex-col gap-1">
                                <span className="flex items-center gap-2 min-w-0 text-xs">
                                    <TargetLabel row={r} testId={testId} />
                                </span>
                                <span className="flex items-center gap-2 min-w-0 text-[11px]">
                                    <StatusPill tone={pill.tone} testId={`${testId}-outcome`}>{pill.key ? t(pill.key, pill.fallback) : pill.fallback}</StatusPill>
                                    {r.expires_at
                                        ? <DeadlineClock dueAt={r.expires_at} startedAt={r.attested_at} variant="inline" testId={`${testId}-clock`} />
                                        : <span className="text-[var(--text-tertiary)] truncate">{t('compliance.fw_pa_evergreen', 'does not expire')}</span>}
                                </span>
                                <span className="text-[11px] text-[var(--text-secondary)]">{formatDay(r.attested_at)}</span>
                            </div>
                            {isLive && (
                                <button
                                    type="button"
                                    className="shrink-0 min-h-[44px] px-2.5 rounded-md border border-[var(--border-default)] text-[11px] font-medium"
                                    onClick={() => onOpenLadder?.(r.target_kind, r.target_id, r.title)}
                                    data-testid={`${testId}-open`}
                                >
                                    {expired ? t('compliance.fw_pa_reassess', 'Reassess') : t('compliance.fw_pa_open', 'Open')}
                                </button>
                            )}
                        </div>
                    );
                }}
                renderRow={(r: AiActAssessment, ctx: DataTableContext) => {
                    const pill = outcomePill(r.outcome);
                    const isLive = targetStateOf(r) === 'live';
                    const expired = r.current === false;
                    return (
                        <TableRow key={`${r.target_kind}:${r.target_id}`} columns={ctx.columns} accent={expired && isLive ? 'warning' : null} testId={`${testId}-row`}>
                            <TableCell column={ctx.columns[0]} className="min-w-0 flex items-center gap-2">
                                <TargetLabel row={r} testId={testId} />
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
                                {isLive && (
                                    <button
                                        type="button"
                                        className="px-2 py-0.5 rounded-md border border-[var(--border-default)] text-[11px] font-medium"
                                        onClick={() => onOpenLadder?.(r.target_kind, r.target_id, r.title)}
                                        data-testid={`${testId}-open`}
                                    >
                                        {expired ? t('compliance.fw_pa_reassess', 'Reassess') : t('compliance.fw_pa_open', 'Open')}
                                    </button>
                                )}
                            </TableCell>
                        </TableRow>
                    );
                }}
            />
        </div>
    );
}
