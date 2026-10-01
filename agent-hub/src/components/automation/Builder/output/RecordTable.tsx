import { useMemo, useState } from 'react';
import ColHeader from './ColHeader';
import { envelopeSpans, isForEachEnvelope } from './envelope';
import InlineValue from './InlineValue';
import { colSegments, mapAttrs, type MapCtx } from './mapAttrs';
import useCellPeek from './useCellPeek';
import { COL_MAX_PX, MAX_COLS, MAX_ROWS, cellValue, humanize, isPlainObject } from './valueHelpers';

interface RecordTableProps { rows: unknown[]; map?: MapCtx | null; allowExpand?: boolean }

/** Base columns whose values are (mostly) of a shape, by majority vote. */
function columnsWhere(rows: unknown[], baseCols: string[], test: (v: unknown) => boolean): Set<string> {
    const s = new Set<string>();
    for (const c of baseCols) {
        let hits = 0, total = 0;
        for (const r of rows) {
            const v = isPlainObject(r) ? r[c] : undefined;
            if (v !== undefined) { total++; if (test(v)) hits++; }
        }
        if (total && hits >= total / 2) s.add(c);
    }
    return s;
}

/**
 * An expanded column's children: `parent.leaf` for an object column,
 * `parent[*].leaf` for a list of records, resolved with the same [*] flatten
 * the runtime performs. Never re-enters FriendlyArray with the same array:
 * the [{}] render-loop guard in RecordTable is load-bearing.
 */
function childColumns(rows: unknown[], col: string, isObject: boolean, isArray: boolean): string[] {
    const children: string[] = [];
    const pushKeys = (obj: Record<string, unknown>, prefix: string) => {
        for (const k of Object.keys(obj)) {
            const dotted = `${prefix}${k}`;
            if (!children.includes(dotted)) children.push(dotted);
        }
    };
    for (const r of rows) {
        const v = isPlainObject(r) ? r[col] : undefined;
        if (isObject && isPlainObject(v)) pushKeys(v, `${col}.`);
        else if (isArray && Array.isArray(v)) v.filter(isPlainObject).forEach(el => pushKeys(el, `${col}[*].`));
    }
    return children;
}

/**
 * The classic table: every field a column, drill-down into object and list
 * columns, drag/click-to-map on every header and cell. The step drawer's
 * "Continues on" column uses the smarter SmartTable instead; the dry-run
 * cards, the run history and the Input panel keep this one.
 */
export default function RecordTable({ rows, map = null, allowExpand = false }: RecordTableProps) {
    // Top-level columns (the object keys), discovered in first-seen order.
    const baseCols = useMemo(() => {
        const seen: string[] = [];
        for (const r of rows) {
            if (isPlainObject(r)) {
                for (const k of Object.keys(r)) if (!seen.includes(k)) seen.push(k);
            }
        }
        return seen;
    }, [rows]);

    // Columns holding (mostly) plain objects: drillable into `parent.leaf`.
    const objectCols = useMemo(() => columnsWhere(rows, baseCols, isPlainObject), [rows, baseCols]);
    // Columns holding (mostly) ARRAYS OF OBJECTS: drillable into
    // `parent[*].leaf`, the same way object columns expand.
    const arrayCols = useMemo(
        () => columnsWhere(rows, baseCols, (v) => Array.isArray(v) && v.some(isPlainObject)),
        [rows, baseCols],
    );

    const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
    const toggle = (key: string) => setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key); else next.add(key);
        return next;
    });

    // The columns actually rendered: dotted paths relative to each row.
    const allCols = useMemo(() => {
        const out: string[] = [];
        for (const c of baseCols) {
            const open = allowExpand && expanded.has(c);
            const children = open ? childColumns(rows, c, objectCols.has(c), arrayCols.has(c)) : [];
            if (children.length) out.push(...children);
            else out.push(c);
        }
        return out;
    }, [baseCols, objectCols, arrayCols, expanded, allowExpand, rows]);

    // The cap is an affordance, not a wall.
    const [showAllCols, setShowAllCols] = useState(false);
    const overflowCols = Math.max(0, allCols.length - MAX_COLS);
    const cols = showAllCols ? allCols : allCols.slice(0, MAX_COLS);

    const shown = rows.slice(0, MAX_ROWS);
    const peek = useCellPeek();
    const groupSpans = useMemo(
        () => (isForEachEnvelope(rows, baseCols) ? envelopeSpans(cols) : null),
        [rows, baseCols, cols],
    );

    // No columns discovered (e.g. `[{}]`): render the rows as a list. Do NOT
    // re-enter FriendlyArray with the same rows, which would route straight
    // back here: an unbounded render loop on a single-element `[{}]`.
    if (baseCols.length === 0) {
        return (
            <ul className="list-disc pl-4 space-y-0.5">
                {shown.map((v, i) => (
                    <li key={i} {...mapAttrs(map, [i])}><InlineValue value={v} /></li>
                ))}
                {rows.length > MAX_ROWS && <li className="list-none text-[var(--text-tertiary)]">+{rows.length - MAX_ROWS} more</li>}
            </ul>
        );
    }

    // `min-w-max` lets the table grow to its content width and overflow the
    // scroll container, so the HORIZONTAL scrollbar sticks to the panel bottom.
    return (
        <div className="min-w-max">
            <table className="w-full border-collapse">
                {/* Sticky header: a table whose columns you can't name is unreadable. */}
                <thead className="sticky top-0 z-10 bg-[var(--bg-primary)]">
                    {groupSpans && (
                        <tr>
                            {groupSpans.map((g, i) => (
                                <th
                                    key={i}
                                    colSpan={g.span}
                                    className={`text-left text-[10px] uppercase tracking-wide font-semibold px-2 pt-1 pb-0.5 whitespace-nowrap ${
                                        g.label ? 'text-[var(--text-tertiary)] border-b border-[var(--border-default)]' : ''}`}
                                >
                                    {g.label || ''}
                                </th>
                            ))}
                            {overflowCols > 0 && <th />}
                        </tr>
                    )}
                    <tr>
                        {cols.map((c) => (
                            <ColHeader
                                key={c}
                                col={c}
                                map={map}
                                expandable={allowExpand && !c.includes('.') && !c.includes('[*]') && (objectCols.has(c) || arrayCols.has(c))}
                                isListCol={arrayCols.has(c)}
                                onToggle={toggle}
                            />
                        ))}
                        {overflowCols > 0 && (
                            <th className="text-left font-normal text-[var(--text-tertiary)] px-2 py-1 border-b border-[var(--border-default)] whitespace-nowrap">
                                <button
                                    type="button"
                                    onClick={(e) => { e.stopPropagation(); setShowAllCols(v => !v); }}
                                    className="text-[var(--accent)] hover:underline"
                                >
                                    {showAllCols
                                        ? 'Fewer columns'
                                        : `+${overflowCols} more column${overflowCols === 1 ? '' : 's'}`}
                                </button>
                            </th>
                        )}
                    </tr>
                </thead>
                <tbody>
                    {shown.map((r, i) => (
                        <tr key={i} className="border-b border-[var(--border-default)]/60 last:border-b-0">
                            {cols.map((c) => {
                                const v = cellValue(r, c, baseCols.length);
                                return (
                                    <td
                                        key={c}
                                        {...mapAttrs(map, [i, ...colSegments(c)])}
                                        // Capped so one long column can't push
                                        // the rest off the panel.
                                        style={{ maxWidth: COL_MAX_PX }}
                                        onMouseEnter={(e) => peek.open(e.currentTarget, v, humanize(c.split('.').pop()))}
                                        onMouseLeave={peek.close}
                                        className={`px-2 py-1 align-top text-[var(--text-primary)] ${map ? 'cursor-grab active:cursor-grabbing hover:bg-[var(--accent)]/10' : ''}`}
                                    >
                                        <div className="truncate"><InlineValue value={v} /></div>
                                    </td>
                                );
                            })}
                            {overflowCols > 0 && <td className="px-2 py-1 text-[var(--text-tertiary)]">{showAllCols ? '' : '…'}</td>}
                        </tr>
                    ))}
                </tbody>
            </table>
            {rows.length > MAX_ROWS && (
                <div className="px-2 py-1 text-[var(--text-tertiary)]">+{rows.length - MAX_ROWS} more rows</div>
            )}
            {peek.card}
        </div>
    );
}
