import { useMemo, useState } from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import type { OutputColumn } from './columns';
import { canOpen } from './levels';
import { cellOf } from './perItem';
import SmartCell from './SmartCell';
import type { OutputColumnsState } from './useOutputColumns';

/** Rows the drawer shows before "+ n more" hands over to the large view. */
const NARROW_ROWS = 20;

// The wide suggestion's extra columns show only from 1100px of table width,
// where all of them fit beside the pinned column (the other cells capped at
// 240px). The pinned column never collapses: below 1100px it keeps 120px and
// the other cells give way (110px, 160px from 620px, 240px from 860px), so
// the four suggested columns fit side by side from 450px of table width.
const WIDE_ONLY = 'hidden @min-[1100px]/smt:table-cell';
const PINNED = 'w-full max-w-0 min-w-[120px] @min-[1100px]/smt:min-w-[160px]';
const OTHER_TD = 'whitespace-nowrap text-[var(--text-tertiary)] max-w-[110px] @min-[620px]/smt:max-w-[160px] @min-[860px]/smt:max-w-[240px]';

interface SmartTableProps {
    rows: unknown[];
    cols: OutputColumnsState;
    /**
     * Open the large view: at the top, on one row's details, or (with a
     * list's column key) straight on the list that row holds.
     */
    onExpand?: ((rowIndex?: number, listKey?: string) => void) | null;
}

/**
 * The list a step returned, as the drawer's "Continues on" column shows it
 * (artboard 4b): a few useful columns, the technical ones hidden behind one
 * line that says which, and the rest of the rows one click away in the large
 * view. Where the column is wide (@container/smt, the table's own width) it
 * shows the large view's suggestion instead of the narrow one: the room is
 * there, so the table uses it (WIDE_ONLY).
 */
export default function SmartTable({ rows, cols, onExpand = null }: SmartTableProps) {
    const { t } = useTranslation();
    const [showTech, setShowTech] = useState(false);
    const byKey = useMemo(() => new Map(cols.columns.map(c => [c.key, c])), [cols.columns]);
    // The wide suggestion holds the narrow one (same picking order, a higher
    // cap); the columns only it has show in a wide table alone.
    const base = cols.narrow.every(k => cols.wide.includes(k)) ? cols.wide : cols.narrow;
    const wideOnlySet = new Set(base.filter(k => !cols.narrow.includes(k)));
    const wideOnly = (key: string) => wideOnlySet.has(key);
    const technical = cols.columns.filter(c => c.technical && !base.includes(c.key));
    const keys = showTech ? [...base, ...technical.map(c => c.key)] : base;
    const shownCols = keys.map(k => byKey.get(k)).filter((c): c is OutputColumn => !!c);
    const shown = rows.slice(0, NARROW_ROWS);
    const more = rows.length - shown.length;
    const techNames = technical.slice(0, 2).map(c => c.label.toLowerCase()).join(', ');

    return (
        <div className="@container/smt rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-card)] overflow-hidden text-xs" data-testid="output-smart-table">
            <div className="overflow-x-auto custom-scrollbar">
                <table className="w-full border-collapse">
                    <thead>
                        <tr className="bg-[var(--bg-secondary)]">
                            {shownCols.map((c, i) => (
                                <th
                                    key={c.key}
                                    scope="col"
                                    data-wide-only={wideOnly(c.key) || undefined}
                                    className={`px-3 py-[7px] font-semibold text-[var(--text-secondary)] whitespace-nowrap ${wideOnly(c.key) ? WIDE_ONLY : ''} ${i === 0 ? `text-left ${PINNED}` : (c.kind === 'number' || c.role === 'amount' ? 'text-right' : 'text-left')}`}
                                >
                                    <span className="block truncate">{c.label}</span>
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {shown.map((r, ri) => (
                            <tr
                                key={ri}
                                className={`border-t border-[var(--border-default)] ${onExpand ? 'cursor-pointer hover:bg-[var(--bg-secondary)]' : ''}`}
                                onClick={onExpand ? () => onExpand(ri) : undefined}
                            >
                                {shownCols.map((c, i) => (
                                    <td
                                        key={c.key}
                                        className={`px-3 py-[7px] align-middle ${wideOnly(c.key) ? WIDE_ONLY : ''} ${i === 0 ? `${PINNED} text-[var(--text-primary)]` : OTHER_TD}`}
                                    >
                                        <Cell row={r} ri={ri} col={c} pinned={i === 0} onExpand={onExpand} />
                                    </td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            {(more > 0 || technical.length > 0) && (
                <div className="flex items-center gap-2 px-3 py-[7px] border-t border-[var(--border-default)] text-[var(--text-tertiary)]">
                    {more > 0 && (
                        onExpand
                            ? <button type="button" onClick={() => onExpand()} className="hover:text-[var(--text-primary)] hover:underline">{t('automations.output.more_rows', '+ {count} more', { count: more })}</button>
                            : <span>{t('automations.output.more_rows', '+ {count} more', { count: more })}</span>
                    )}
                    {technical.length > 0 && (
                        <span className="ml-auto text-right">
                            {showTech
                                ? t('automations.output.tech_shown', '{count} technical columns shown', { count: technical.length })
                                : t('automations.output.tech_hidden', '{count} technical columns hidden ({names}…)', { count: technical.length, names: techNames })}
                            {' · '}
                            <button type="button" onClick={() => setShowTech(v => !v)} className="underline hover:text-[var(--text-primary)]">
                                {showTech ? t('automations.output.hide', 'hide') : t('automations.output.show', 'show')}
                            </button>
                        </span>
                    )}
                </div>
            )}
        </div>
    );
}

interface CellProps {
    row: unknown;
    ri: number;
    col: OutputColumn;
    pinned: boolean;
    onExpand: SmartTableProps['onExpand'];
}

/** One cell; a list of records in it opens the large view on that list. */
function Cell({ row, ri, col, pinned, onExpand }: CellProps) {
    const value = cellOf(row, col, pinned);
    const open = onExpand && canOpen(value) ? () => onExpand(ri, col.key) : undefined;
    return <SmartCell value={value} col={col} onOpen={open} openKey={open ? `${ri}:${col.key}` : undefined} pinned={pinned} />;
}
