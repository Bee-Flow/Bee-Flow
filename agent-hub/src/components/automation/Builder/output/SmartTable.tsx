import { useMemo, useState } from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import type { OutputColumn } from './columns';
import SmartCell from './SmartCell';
import type { OutputColumnsState } from './useOutputColumns';
import { getByDotted } from './valueHelpers';

/** Rows the drawer shows before "+ n more" hands over to the large view. */
const NARROW_ROWS = 20;

interface SmartTableProps {
    rows: unknown[];
    cols: OutputColumnsState;
    /** Open the large view, optionally on one row. */
    onExpand?: ((rowIndex?: number) => void) | null;
}

/**
 * The list a step returned, as the drawer's "Continues on" column shows it
 * (artboard 4b): a few useful columns, the technical ones hidden behind one
 * line that says which, and the rest of the rows one click away in the large
 * view. Where the column is wide (@container/smt, the table's own width) it
 * shows the large view's suggestion instead of the narrow one: the room is
 * there, so the table uses it.
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
    const techNames = technical.slice(0, 2).map(c => c.key).join(', ');

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
                                    className={`px-3 py-[7px] font-semibold text-[var(--text-secondary)] whitespace-nowrap ${wideOnly(c.key) ? 'hidden @min-[860px]/smt:table-cell' : ''} ${i === 0 ? 'text-left w-full max-w-0' : (c.kind === 'number' || c.role === 'amount' ? 'text-right' : 'text-left')}`}
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
                                        className={`px-3 py-[7px] align-middle ${wideOnly(c.key) ? 'hidden @min-[860px]/smt:table-cell' : ''} ${i === 0 ? 'w-full max-w-0 text-[var(--text-primary)]' : 'whitespace-nowrap text-[var(--text-tertiary)] max-w-[180px] @min-[860px]/smt:max-w-[300px]'}`}
                                    >
                                        <SmartCell value={getByDotted(r, c.key)} col={c} />
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
                            ? <button type="button" onClick={() => onExpand()} className="hover:text-[var(--text-primary)] hover:underline">{t('routines.output.more_rows', '+ {count} more', { count: more })}</button>
                            : <span>{t('routines.output.more_rows', '+ {count} more', { count: more })}</span>
                    )}
                    {technical.length > 0 && (
                        <span className="ml-auto text-right">
                            {showTech
                                ? t('routines.output.tech_shown', '{count} technical columns shown', { count: technical.length })
                                : t('routines.output.tech_hidden', '{count} technical columns hidden ({names}…)', { count: technical.length, names: techNames })}
                            {' · '}
                            <button type="button" onClick={() => setShowTech(v => !v)} className="underline hover:text-[var(--text-primary)]">
                                {showTech ? t('routines.output.hide', 'hide') : t('routines.output.show', 'show')}
                            </button>
                        </span>
                    )}
                </div>
            )}
        </div>
    );
}
