import React from 'react';
import { CircleCheck, CircleDashed, TriangleAlert, CircleX, Eye, CircleMinus } from 'lucide-react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import DataTable, { TableRow, TableCell } from '../../../../shared/DataTable';
import { TONES } from '../../../../shared/statusTone';
import ArticleRef from '../../shared/ArticleRef';
import StatusPill from '../../shared/StatusPill';
import { decisionOf, liveCheckOf } from './soaThemes';

/**
 * SoaTable — the 93-row register (artboard 1d): Control · Title / how met ·
 * Live check · Decision · Owner. Purely presentational: the page filters,
 * pages and selects; the table draws the rows it is handed.
 *
 * Most controls have no live check, so that cell is a muted "—" (the words
 * are its tooltip, as the Owner dash): a column of "no live check" drowned
 * the few that do. The check cell truncates inside its own track, so its
 * text never runs into the Decision pill.
 */
export const SOA_COLUMNS = Object.freeze([
    Object.freeze({ id: 'control', width: '58px', labelKey: 'compliance.soa_col_control', fallback: 'Control' }),
    Object.freeze({ id: 'title', width: '1fr', labelKey: 'compliance.soa_col_title_how', fallback: 'Title · how met' }),
    Object.freeze({ id: 'check', width: '150px', labelKey: 'compliance.soa_col_check', fallback: 'Live check' }),
    Object.freeze({ id: 'decision', width: '118px', labelKey: 'compliance.soa_col_status', fallback: 'Decision' }),
    Object.freeze({ id: 'owner', width: '92px', labelKey: 'compliance.soa_col_owner', fallback: 'Owner' }),
]);

/** Decision word → pill tone + glyph. `todo` is the open one (warning); `excluded` says nothing (neutral). */
export const DECISION_META = Object.freeze({
    todo: Object.freeze({ tone: 'warning', icon: CircleDashed, labelKey: 'compliance.soa_decision_todo', fallback: 'To review' }),
    reviewed: Object.freeze({ tone: 'neutral', icon: Eye, labelKey: 'compliance.soa_decision_reviewed', fallback: 'Reviewed' }),
    approved: Object.freeze({ tone: 'success', icon: CircleCheck, labelKey: 'compliance.soa_decision_approved', fallback: 'Approved' }),
    excluded: Object.freeze({ tone: 'neutral', icon: CircleMinus, labelKey: 'compliance.soa_decision_excluded', fallback: 'Excluded' }),
});

export function ownerName(orgUsers, userId) {
    if (!userId) return null;
    const u = (Array.isArray(orgUsers) ? orgUsers : []).find(x => x.id === userId);
    return u ? (u.displayName || null) : null;
}

/** Decision pill — shared by the table and the drawer header. */
export function DecisionPill({ decision, testId }) {
    const { t } = useTranslation();
    const meta = DECISION_META[decision] || DECISION_META.todo;
    return (
        <StatusPill tone={meta.tone} icon={meta.icon} testId={testId} className="whitespace-nowrap">
            {t(meta.labelKey, meta.fallback)}
        </StatusPill>
    );
}

/** The live-check cell: glyph in tone + the check's short title (+ "· needs attention" when open). */
export function LiveCheckCell({ live }) {
    const { t } = useTranslation();
    if (!live || live.kind === 'none') {
        const words = t('compliance.soa_no_live_check_title', 'No live check covers this control');
        return (
            <span className="text-[11px] text-[var(--text-tertiary)]" title={words} data-live="none">
                <span aria-hidden="true">—</span><span className="sr-only">{words}</span>
            </span>
        );
    }
    if (live.kind === 'pending') {
        return (
            <span className="flex w-full min-w-0 items-center gap-1.5 text-[11px] text-[var(--text-tertiary)]">
                <CircleDashed size={13} aria-hidden="true" className="shrink-0" />
                <span className="truncate">{t('compliance.soa_not_checked', 'not yet checked')}</span>
            </span>
        );
    }
    const { check, status } = live;
    const open = status === 'warn' || status === 'fail';
    const tone = status === 'pass' ? 'success' : status === 'warn' ? 'warning' : status === 'fail' ? 'error' : 'neutral';
    const Glyph = status === 'pass' ? CircleCheck : status === 'warn' ? TriangleAlert : status === 'fail' ? CircleX : CircleDashed;
    const title = check.titleKey ? t(check.titleKey, check.check_id) : (check.title || check.check_id);
    return (
        <span className="flex w-full min-w-0 items-center gap-1.5 text-[11px]" style={{ color: TONES[tone].ink }} data-status={status} title={title}>
            <Glyph size={13} aria-hidden="true" className="shrink-0" />
            <span className="truncate min-w-0">{title}</span>
            {open && <span className="shrink-0">{t('compliance.soa_check_attention', '· needs attention')}</span>}
        </span>
    );
}

export default function SoaTable({
    rows, checksById, orgUsers, selectedRef, onSelect, loading = false, isMobile = false, footer, empty, testId = 'soa-table',
}) {
    const { t } = useTranslation();
    const columns = SOA_COLUMNS.map(c => ({ id: c.id, width: c.width, label: t(c.labelKey, c.fallback) }));

    const renderRow = (c, ctx) => {
        const decision = decisionOf(c);
        const excluded = decision === 'excluded';
        const live = liveCheckOf(c, checksById);
        const selected = selectedRef === c.ref;
        // "how met" is the sentence an auditor reads; a row that has none
        // falls back to its justification (the only line an excluded row has),
        // labelled as such so the two never read as the same thing.
        const howMet = c.entry?.how_met || null;
        const justification = c.entry?.justification || null;
        const secondLine = howMet || (justification ? t('compliance.soa_justification_prefix', 'Justification: {text}', { text: justification }) : null);
        const owner = ownerName(orgUsers, c.entry?.owner_user_id);
        return (
            <TableRow
                key={c.ref}
                columns={ctx.columns}
                selected={selected}
                onClick={() => onSelect?.(c)}
                testId={`${testId}-row-${c.ref}`}
                className={excluded ? 'text-[var(--text-tertiary)]' : ''}
            >
                <TableCell column={ctx.columns[0]}><ArticleRef>{c.ref}</ArticleRef></TableCell>
                <TableCell column={ctx.columns[1]} className="min-w-0">
                    <div className={`truncate font-medium ${excluded ? 'text-[var(--text-tertiary)]' : 'text-[var(--text-primary)]'}`}>
                        {c.titleKey ? t(c.titleKey, c.ref) : c.ref}
                    </div>
                    {secondLine && (
                        <div className="truncate text-[11px] text-[var(--text-secondary)]" title={secondLine}>{secondLine}</div>
                    )}
                </TableCell>
                <TableCell column={ctx.columns[2]} className="min-w-0"><LiveCheckCell live={live} /></TableCell>
                <TableCell column={ctx.columns[3]}><DecisionPill decision={decision} /></TableCell>
                <TableCell column={ctx.columns[4]} className="truncate text-[11px]">{owner || '—'}</TableCell>
            </TableRow>
        );
    };

    const renderCard = (c) => {
        const decision = decisionOf(c);
        const live = liveCheckOf(c, checksById);
        return (
            <button
                type="button"
                onClick={() => onSelect?.(c)}
                className="w-full min-w-0 text-left flex flex-col gap-1"
                data-testid={`${testId}-card-${c.ref}`}
            >
                <div className="flex items-center justify-between gap-2">
                    <ArticleRef>{c.ref}</ArticleRef>
                    <DecisionPill decision={decision} />
                </div>
                <div className="text-xs font-medium text-[var(--text-primary)] truncate">{c.titleKey ? t(c.titleKey, c.ref) : c.ref}</div>
                {live && live.kind !== 'none' && <LiveCheckCell live={live} />}
            </button>
        );
    };

    return (
        <DataTable
            columns={columns}
            rows={rows}
            rowKey={(row) => row.ref}
            renderRow={renderRow}
            renderCard={renderCard}
            isMobile={isMobile}
            loading={loading}
            footer={footer}
            empty={empty}
            ariaLabel={t('compliance.rail_soa', 'SoA (Annex A)')}
            testId={testId}
        />
    );
}
