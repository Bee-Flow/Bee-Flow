import { Lock, TriangleAlert } from 'lucide-react';
import React, { useId, useMemo } from 'react';

import type { TranslateFn } from '../../../../../../hooks/useTranslation';
import type { MatrixColumn, MatrixKind, MatrixToolPolicy } from './categoryMatrixModel';
import { columnCounts, groupsOf, halfOpen, selectionOf } from './categoryMatrixModel';
import MatrixGroup from './MatrixGroup';
import MatrixHead from './MatrixHead';

/**
 * The 21 kinds of personal data × the three questions asked about each one.
 *
 * ── Why one matrix ────────────────────────────────────────────────────────
 * The same 21-item question used to be asked in three places: which kinds to
 * look for, which a tool that leaves the organisation may not carry, and which
 * a tool on the own server may not carry. The relationship between them is the
 * point: "National ID" hidden from the AI but not held back from outside tools
 * means we look for it and then let a connected app carry it out anyway. On
 * one row that is obvious, and `halfOpen` names it explicitly.
 *
 * ── Why ONE table ─────────────────────────────────────────────────────────
 * The rows used to be split into two tables side by side on wide screens.
 * One table reads top to bottom like the rest of the pane, and a screen
 * reader meets one caption and one set of column headers instead of two.
 *
 * ── Accessibility ─────────────────────────────────────────────────────────
 * A real <table> with row and column headers, not a grid of divs: a table
 * cell announces "Person names, Outside tools, checked", which 63 loose
 * checkboxes do not.
 */

interface CategoryMatrixProps {
    categories: MatrixKind[];
    detect: string[];
    toolPolicy: MatrixToolPolicy;
    /** Enterprise: the outside-tools column. */
    canBlockExternal: boolean;
    allowPublicOrgs: boolean;
    readOnly: boolean;
    /** Canonical id → tool calls that carried it in the last 30 days; null = unknown. */
    toolKinds?: Record<string, number> | null;
    days?: number;
    onToggleDetect: (id: string, on: boolean) => void;
    onSetDetect: (ids: string[]) => void;
    onToggleTool: (cls: 'external' | 'internal', id: string, on: boolean) => void;
    t: TranslateFn;
}

const BULK = 'h-full px-3 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50 disabled:hover:bg-transparent';

/** "All" / "None" for the look-for column, where the design has its search box. */
function BulkButtons({ onSet, readOnly, t }: { onSet: (on: boolean) => void; readOnly: boolean; t: TranslateFn }) {
    return (
        <div className="inline-flex items-stretch h-[30px] rounded-[8px] border border-[var(--border-default)] bg-[var(--bg-card)] overflow-hidden shrink-0">
            <button type="button" disabled={readOnly} onClick={() => onSet(true)} className={BULK}>
                {t('common.all', 'All')}
            </button>
            <span aria-hidden="true" className="w-px bg-[var(--border-default)]" />
            <button type="button" disabled={readOnly} onClick={() => onSet(false)} className={BULK}>
                {t('common.none', 'None')}
            </button>
        </div>
    );
}

/** The finding one table makes visible: looked for, but no tool holds it back. */
function HalfOpenStrip({ kinds, t }: { kinds: MatrixKind[]; t: TranslateFn }) {
    return (
        <div className="flex gap-2.5 items-start px-[18px] py-3 border-t border-[var(--border-subtle)] bg-[color-mix(in_srgb,var(--warning)_8%,transparent)]">
            <TriangleAlert className="w-3.5 h-3.5 shrink-0 mt-0.5 text-[var(--warning-ink)]" aria-hidden="true" />
            <p className="text-xs leading-[17px] m-0 text-[var(--text-secondary)]">
                <strong className="font-semibold text-[var(--text-primary)]">
                    {t('admin.shield_matrix_half_open_title', '{n} kinds are only half protected:', { n: kinds.length })}
                </strong>{' '}
                {t('admin.shield_matrix_half_open_desc',
                    'you look for them, but no tool holds them back — so a connected app may still carry them out of your organisation.')}{' '}
                <span className="text-[var(--text-tertiary)]">
                    {kinds.slice(0, 4).map(c => c.label).join(' · ')}
                    {kinds.length > 4 ? ' …' : ''}
                </span>
            </p>
        </div>
    );
}

export function CategoryMatrix({
    categories, detect, toolPolicy, canBlockExternal, readOnly, allowPublicOrgs,
    toolKinds = null, days = 30, onToggleDetect, onSetDetect, onToggleTool, t,
}: CategoryMatrixProps) {
    const descId = useId();
    const sel = useMemo(() => selectionOf(detect, toolPolicy), [detect, toolPolicy]);
    const counts = columnCounts(categories, sel);
    const groups = useMemo(() => groupsOf(categories), [categories]);
    const open = useMemo(() => halfOpen(categories, sel), [categories, sel]);

    const onToggle = (col: MatrixColumn, id: string, on: boolean) => {
        if (col === 'detect') onToggleDetect(id, on);
        else onToggleTool(col, id, on);
    };

    return (
        <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] shadow-[var(--shadow-sm)] overflow-hidden">
            <div className="flex items-center gap-2.5 flex-wrap px-[18px] py-3.5">
                <h4 className="m-0 text-[13px] font-semibold text-[var(--text-primary)]">
                    {t('admin.shield_pii_categories', 'Kinds of personal data')}
                </h4>
                <span className="text-xs text-[var(--text-tertiary)]">
                    {t('shield_look.matrix_hint', '{n} kinds · one row each', { n: categories.length })}
                </span>
                <span className="flex-1" />
                <BulkButtons onSet={on => onSetDetect(on ? categories.map(c => c.id) : [])} readOnly={readOnly} t={t} />
            </div>

            {/* The paragraph that explained the columns became the headers'
                second lines; screen readers still get it as the table's
                description. */}
            <p id={descId} className="sr-only">
                {t('admin.shield_matrix_desc',
                    'A kind that is not ticked under “Hide from AI” is never asked of the model, so it can never be found. The two right-hand columns are not about finding — they decide what a tool may carry out.')}
            </p>
            <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] border-collapse table-fixed" aria-describedby={descId}>
                    <caption className="sr-only">
                        {t('admin.shield_matrix_caption',
                            'For each kind of personal data: whether it is hidden from the AI, withheld from tools outside your organisation, and withheld from tools on your own server.')}
                    </caption>
                    {/* The design's 150 / 190 / 150 px columns, plus each
                        cell's share of the 12 px gap and the 18 px edge. */}
                    <colgroup>
                        <col />
                        {/* Fixed on a laptop; on a wide pane the three
                            answer columns take a share, so a checkbox does not
                            end up a screen's width away from its kind. */}
                        <col className="w-[162px] @min-[1400px]/pane:w-[16%]" />
                        <col className="w-[202px] @min-[1400px]/pane:w-[19%]" />
                        <col className="w-[174px] @min-[1400px]/pane:w-[16%]" />
                    </colgroup>
                    <MatrixHead counts={counts} total={categories.length} canBlockExternal={canBlockExternal} t={t} />
                    {groups.map(group => (
                        <MatrixGroup
                            key={group.name}
                            group={group}
                            sel={sel}
                            canBlockExternal={canBlockExternal}
                            allowPublicOrgs={allowPublicOrgs}
                            readOnly={readOnly}
                            toolKinds={toolKinds}
                            days={days}
                            onToggle={onToggle}
                            t={t}
                        />
                    ))}
                </table>
            </div>

            {open.length > 0 && <HalfOpenStrip kinds={open} t={t} />}

            {/* The Enterprise story for the outside-tools column, once, at the
                bottom, instead of 21 lock icons explaining themselves. */}
            {!canBlockExternal && (
                <p className="flex items-start gap-2 m-0 px-[18px] py-3 border-t border-[var(--border-subtle)] text-xs leading-[17px] text-[var(--text-secondary)]">
                    <Lock className="w-3.5 h-3.5 shrink-0 mt-0.5 text-[var(--text-tertiary)]" aria-hidden="true" />
                    <span>{t('admin.shield_tool_block_locked', 'Holding data back from outside tools is an Enterprise feature.')}</span>
                </p>
            )}
        </div>
    );
}

export default CategoryMatrix;
