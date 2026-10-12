import FieldKindIconJs from '../mapping/FieldKindIcon';
import type { ComponentType } from 'react';
import type { OutputColumn } from './columns';
import { canOpen } from './levels';
import { cellOf } from './perItem';
import SmartCell from './SmartCell';

const FieldKindIcon = FieldKindIconJs as unknown as ComponentType<{ kind: string; size?: number; className?: string }>;

const WIDTH: Record<string, string> = {
    group: 'min-w-[190px]', date: 'min-w-[90px]', number: 'min-w-[100px]', table: 'min-w-[140px]',
    list: 'min-w-[150px]', yesno: 'min-w-[80px]', file: 'min-w-[130px]',
};
const SELECTED = 'bg-[color-mix(in_srgb,var(--type-ai)_8%,var(--bg-card))]';

interface WideGridProps {
    rows: { row: unknown; index: number }[];
    columns: OutputColumn[];
    compact: boolean;
    selected: number | null;
    onSelect: (index: number) => void;
    /** Opens the list a cell holds (row index, its column) as the next level. */
    onOpenList?: ((index: number, col: OutputColumn) => void) | null;
}

/**
 * The large view's table (artboard 4d): the name column pinned on the left
 * while the rest scrolls, a header that says what kind each column is, and
 * nested values summarised per cell. A cell that holds a list of records is
 * a button that opens that list.
 */
export default function WideGrid({ rows, columns, compact, selected, onSelect, onOpenList = null }: WideGridProps) {
    const pad = compact ? 'py-1' : 'py-[9px]';
    return (
        <table className="border-separate border-spacing-0 w-max min-w-full text-xs" data-testid="output-wide-grid">
            <thead className="sticky top-0 z-[2]">
                <tr>
                    {columns.map((c, i) => (
                        <th
                            key={c.key}
                            scope="col"
                            className={`px-3 py-2 bg-[var(--bg-secondary)] font-semibold text-[var(--text-secondary)] border-b border-[var(--border-default)] whitespace-nowrap ${
                                i === 0 ? 'sticky left-0 z-[3] border-r min-w-[170px] text-left' : `${WIDTH[c.kind] || 'min-w-[120px]'} ${c.kind === 'number' ? 'text-right' : 'text-left'}`}`}
                        >
                            <span className={`inline-flex items-center gap-1.5 ${c.kind === 'number' && i > 0 ? 'flex-row-reverse' : ''}`}>
                                <FieldKindIcon kind={c.kind} size={12} className="shrink-0" />
                                {c.label}
                            </span>
                        </th>
                    ))}
                </tr>
            </thead>
            <tbody>
                {rows.map(({ row, index }) => {
                    const on = selected === index;
                    return (
                        <tr
                            key={index}
                            onClick={() => onSelect(index)}
                            aria-selected={on}
                            className="cursor-pointer group"
                        >
                            {columns.map((c, i) => (
                                <td
                                    key={c.key}
                                    className={`px-3 ${pad} border-b border-[var(--border-default)] align-middle ${
                                        i === 0
                                            ? `sticky left-0 z-[1] border-r max-w-[260px] ${on ? `${SELECTED} font-semibold shadow-[inset_3px_0_0_var(--type-ai)]` : 'bg-[var(--bg-card)] font-medium group-hover:bg-[var(--bg-secondary)]'}`
                                            : `max-w-[260px] text-[var(--text-secondary)] ${on ? SELECTED : 'group-hover:bg-[var(--bg-secondary)]'}`}`}
                                >
                                    <GridCell row={row} index={index} col={c} pinned={i === 0} onOpenList={onOpenList} />
                                </td>
                            ))}
                        </tr>
                    );
                })}
            </tbody>
        </table>
    );
}

interface GridCellProps {
    row: unknown;
    index: number;
    col: OutputColumn;
    pinned: boolean;
    onOpenList: WideGridProps['onOpenList'];
}

/** One cell; a list of records in it opens as the next level. */
function GridCell({ row, index, col, pinned, onOpenList }: GridCellProps) {
    const value = cellOf(row, col, pinned);
    const open = onOpenList && canOpen(value) ? () => onOpenList(index, col) : undefined;
    return <SmartCell value={value} col={col} onOpen={open} openKey={open ? `${index}:${col.key}` : undefined} pinned={pinned} />;
}
