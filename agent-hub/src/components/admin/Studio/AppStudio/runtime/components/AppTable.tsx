import CellValue, { ALIGN_CLASS, alignFor } from './cellValue';
import useTranslation from '@/hooks/useTranslation';
import { usePagedSource, withPager } from '../pagedSource';
import { walkPath } from '../resolveBinding';
import type { BindingInput, ResolveResult } from '../resolveBinding.types';
import { useRuntime } from '../RuntimeContext';
import { EmptyText, ErrorText, SkeletonLines, useStickyBinding } from '../uiBits';
import type { NodeProps } from './appNode.types';
import { GridColumn } from './grid/useGridColumns';

/**
 * App Studio runtime — 'table'. Spec: server/appStudio/componentSpecs.js.
 *
 * The cell switch used to live here in a copy that had already fallen behind
 * the data grid's (no `boolean`, no `relation`, an unmuted em-dash for an empty
 * cell). It is now the shared `cellValue` module, so a format added for one
 * table exists in both.
 */

interface TableProps {
    columns?: GridColumn[];
    emptyText?: string;
    rowLimit?: number;
    source?: BindingInput;
    look?: string;
    pagination?: string;
}

/** A table over `source`; with `pagination` it reads its pages itself (../pagedSource). */
export default function AppTable({ node }: NodeProps<TableProps>) {
    const paged = usePagedSource('table', node.props?.source, node.props?.pagination);
    return withPager(paged, <TableBody node={node} source={paged.result} paged={!!paged.loaders} />);
}

function TableBody({ node, source: resolved, paged }: NodeProps<TableProps> & { source: ResolveResult; paged: boolean }) {
    const { t } = useTranslation();
    const { scope } = useRuntime();
    const { columns = [], emptyText = t('studio_apps_runtime.ui.nothing_to_show', 'Nothing to show yet.'), rowLimit: rowLimitProp = 25 } = node.props || {};
    // A paged table shows the pages it read; rowLimit cuts only the one page a plain source reads.
    const rowLimit = paged ? Infinity : rowLimitProp;
    const { value: source, isLoading, error, errorCode } = useStickyBinding(resolved);

    if (error) return <ErrorText error={error} errorCode={errorCode} />;

    if (isLoading) return <SkeletonLines lines={4} />;

    const allRows = (Array.isArray(source) ? source : [])
        .filter((row) => row && typeof row === 'object');
    const rows = allRows.slice(0, Math.max(1, rowLimit));
    // Everything past rowLimit was dropped in silence — with no count, no
    // paging and no scroll, a table of 500 rows looked like a table of 25.
    const hidden = allRows.length - rows.length;
    // No configured columns → derive from the first row (max 12, like the spec).
    // `hidden` keeps a column in the definition — so a toneFrom or labelFrom can
    // still point at it — without giving it a place on screen.
    const cols = columns.length
        ? columns.filter((c: GridColumn) => c && !c.hidden)
        : Object.keys(rows[0] || {}).slice(0, 12).map((key) => ({ key, label: key, format: 'text' }));

    if (rows.length === 0 || cols.length === 0) return <EmptyText text={emptyText} />;

    const size = node.style?.size || 'md';
    // Look pass (spec: table.look). IDENTITY FIRST: 'default' — and any value
    // this build does not know yet — takes the exact original code path below:
    // no new class, no new style. 'striped' reuses the data grid's zebra CSS
    // (app-tokens.css); 'minimal' trades the rules for whitespace.
    const lookProp = node.props?.look;
    const look = lookProp === 'striped' || lookProp === 'minimal' ? lookProp : 'default';
    const minimal = look === 'minimal';
    const cellPad = minimal
        ? (size === 'sm' ? 'px-2 py-2' : 'px-2.5 py-2.5')
        : (size === 'sm' ? 'px-2 py-1' : 'px-2.5 py-1.5');
    const divider = minimal ? '' : ' border-b';
    const now = Date.parse(scope?.now as string) || null;
    return (
        <div className="w-full overflow-x-auto app-scroll-edges bfa-table__root">
            {/* app-grid-base carries the shared table rhythm (header weight,
                row hover, middle-aligned cells, tabular figures) so the two
                table components look like one product. */}
            <table className={`w-full app-grid-base ${size === 'sm' ? 'text-xs' : 'text-sm'}${look === 'striped' ? ' app-grid-zebra' : ''} bfa-table__table`}>
                <thead className="bfa-table__header">
                    <tr>
                        {cols.map((col: GridColumn) => {
                            const align = alignFor(col);
                            return (
                                <th
                                    key={col.key}
                                    scope="col"
                                    className={`${ALIGN_CLASS[align as keyof typeof ALIGN_CLASS]} font-medium ${cellPad}${divider}${minimal ? ' text-xs uppercase tracking-wider' : ''} bfa-table__headcell`}
                                    style={{ color: 'var(--text-secondary)', borderColor: 'var(--border-default)' }}
                                >
                                    {col.label || col.key}
                                </th>
                            );
                        })}
                    </tr>
                </thead>
                <tbody className="bfa-table__body">
                    {rows.map((row, i) => (
                        <tr key={i} className="bfa-table__row">
                            {cols.map((col: GridColumn) => (
                                <td
                                    key={col.key}
                                    className={`${cellPad}${divider} align-middle ${ALIGN_CLASS[alignFor(col) as keyof typeof ALIGN_CLASS]}${col.truncate ? ' truncate max-w-0' : ''} bfa-table__cell`}
                                    style={{ borderColor: 'var(--border-default)' }}
                                >
                                    {/* walkPath, like every sibling: a dotted key
                                        (customer.name) rendered an em-dash under
                                        plain bracket access. */}
                                    <CellValue
                                        value={walkPath(row, col.key)}
                                        format={col.format || 'text'}
                                        col={col}
                                        row={row}
                                        now={now}
                                    />
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
            {hidden > 0 ? (
                <p
                    className="px-1 pt-1.5 text-xs text-[var(--text-secondary)] bfa-table__footer"
                    data-app-table-truncated={hidden}
                >
                    {t('studio_apps_runtime.table.showing', 'Showing {shown} of {total}.', { shown: rows.length, total: allRows.length.toLocaleString() })}
                </p>
            ) : null}
        </div>
    );
}
