import { useMemo, useState } from 'react';
import { appendKey, appendWildcard, getRelativePath } from '@shared/expr/path.mjs';
import ColHeader from './ColHeader';
import { envelopeSpans, isForEachEnvelope } from './envelope';
import InlineValue from './InlineValue';
import { joinPath, mapAttrs, type MapCtx } from './mapAttrs';
import useCellPeek from './useCellPeek';
import { COL_MAX_PX, MAX_COLS, MAX_ROWS, humanize, isPlainObject } from './valueHelpers';
import { jsonTextValue, positionChildren, type Field } from '../mapping/upstream/fieldTree';

interface RecordTableProps {
    rows: unknown[];
    map?: MapCtx | null;
    allowExpand?: boolean;
    /**
     * A table inside a record: it scrolls sideways in its own box, so opening
     * a list into columns does not push the record's labels and the other
     * tables out of view.
     */
    contained?: boolean;
}

/** A rendered column: the field it shows and the opened columns it came out of, outermost first. */
interface ShownCol { field: Field; trail: Field[] }

/**
 * A column's value in one row, read the way the runtime reads its path (a
 * `[*]` maps and flattens; a quoted key is a key). A table of plain values
 * has one column: the value itself.
 */
/**
 * JSON text in a cell reads as what it encodes ("tags: x, y · ai: …"), never
 * as escaped text — also one level in, where the cell's summary names the
 * record's own fields.
 */
function shownAs(v: unknown): unknown {
    const parsed = jsonTextValue(v);
    const value = parsed === undefined ? v : parsed;
    if (!isPlainObject(value)) return value;
    return Object.fromEntries(Object.entries(value).map(([k, x]) => {
        const inner = jsonTextValue(x);
        return [k, inner === undefined ? x : inner];
    }));
}

function cellAt(row: unknown, col: ShownCol, baseColCount: number): unknown {
    if (isPlainObject(row)) return getRelativePath(row, col.field.path);
    return !col.trail.length && baseColCount === 1 ? row : undefined;
}

/**
 * The classic table: every field a column, drill-down into object and list
 * columns (as deep as the data goes), drag/click-to-map on every header and
 * cell. The step drawer's "Continues on" column uses the smarter SmartTable
 * instead; the dry-run cards, the run history and the Input panel keep this
 * one.
 *
 * Columns are the upstream field tree of the rows (mapping/upstream/fieldTree):
 * the union of every row's keys, each column's path RELATIVE to its row and
 * written by the runtime grammar's writer, so `rows[*]["Story Points"]` and
 * `rows[1].from.emailAddress.address` resolve at run time exactly as shown.
 */
export default function RecordTable({ rows, map = null, allowExpand = false, contained = false }: RecordTableProps) {
    const baseCols = useMemo(() => positionChildren(rows.filter(isPlainObject), '') as Field[], [rows]);
    const baseKeys = useMemo(() => baseCols.map(c => c.key), [baseCols]);

    const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
    const toggle = (key: string) => setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key); else next.add(key);
        return next;
    });

    // The columns actually rendered: an opened column is replaced by its own
    // columns, which may be opened in turn.
    const allCols = useMemo(() => {
        const out: ShownCol[] = [];
        const add = (field: Field, trail: Field[]) => {
            if (allowExpand && expanded.has(field.path) && field.children?.length) {
                for (const c of field.children) add(c, [...trail, field]);
                return;
            }
            out.push({ field, trail });
        };
        for (const c of baseCols) add(c, []);
        return out;
    }, [baseCols, expanded, allowExpand]);

    // The cap is an affordance, not a wall.
    const [showAllCols, setShowAllCols] = useState(false);
    const overflowCols = Math.max(0, allCols.length - MAX_COLS);
    const cols = showAllCols ? allCols : allCols.slice(0, MAX_COLS);

    const shown = rows.slice(0, MAX_ROWS);
    const peek = useCellPeek();
    const groupSpans = useMemo(
        () => (isForEachEnvelope(rows, baseKeys) ? envelopeSpans(cols.map(c => c.field.path)) : null),
        [rows, baseKeys, cols],
    );

    // No columns discovered (e.g. `[{}]`): render the rows as a list. Do NOT
    // re-enter FriendlyArray with the same rows, which would route straight
    // back here: an unbounded render loop on a single-element `[{}]`.
    if (baseCols.length === 0) {
        return (
            <ul className="list-disc pl-4 space-y-0.5">
                {shown.map((v, i) => (
                    <li key={i} {...mapAttrs(map, appendKey('', i))}><InlineValue value={v} /></li>
                ))}
                {rows.length > MAX_ROWS && <li className="list-none text-[var(--text-tertiary)]">+{rows.length - MAX_ROWS} more</li>}
            </ul>
        );
    }

    // `min-w-max` lets the table grow to its content width and overflow the
    // scroll container, so the HORIZONTAL scrollbar sticks to the panel bottom.
    // A table inside a record gets a sideways scroller of its own instead.
    const table = (
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
                                key={c.field.path}
                                col={c.field.path}
                                label={humanize(c.field.key)}
                                trail={c.trail.map(f => ({ path: f.path, label: humanize(f.key) }))}
                                map={map}
                                expandable={allowExpand && !!c.field.children?.length}
                                isListCol={!!c.field.children?.some(ch => ch.path.startsWith(appendWildcard(c.field.path)))}
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
                                const v = cellAt(r, c, baseCols.length);
                                return (
                                    <td
                                        key={c.field.path}
                                        // A row without this field has nothing to map: an
                                        // empty cell hands out no path.
                                        {...(v === undefined ? {} : mapAttrs(map, joinPath(appendKey('', i), c.field.path)))}
                                        // Capped so one long column can't push
                                        // the rest off the panel.
                                        style={{ maxWidth: COL_MAX_PX }}
                                        onMouseEnter={(e) => peek.open(e.currentTarget, shownAs(v), humanize(c.field.key))}
                                        onMouseLeave={peek.close}
                                        className={`px-2 py-1 align-top text-[var(--text-primary)] ${map && v !== undefined ? 'cursor-grab active:cursor-grabbing hover:bg-[var(--accent)]/10' : ''}`}
                                    >
                                        <div className="truncate"><InlineValue value={shownAs(v)} /></div>
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
    return contained ? <div className="max-w-full overflow-x-auto custom-scrollbar" data-testid="nested-table">{table}</div> : table;
}
