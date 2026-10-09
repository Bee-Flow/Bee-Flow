import CellValue, { ALIGN_CLASS, alignFor } from './cellValue';
import useTranslation from '../../../../../../hooks/useTranslation';
import { resolveBinding, walkPath } from '../resolveBinding';
import { useRuntime } from '../RuntimeContext';
import { EmptyText, ErrorText, SkeletonLines, useStickyBinding } from '../uiBits';

/**
 * App Studio runtime — 'table'. Spec: server/appStudio/componentSpecs.js.
 *
 * The cell switch used to live here in a copy that had already fallen behind
 * the data grid's (no `boolean`, no `relation`, an unmuted em-dash for an empty
 * cell). It is now the shared `cellValue` module, so a format added for one
 * table exists in both.
 */

export default function AppTable({ node }) {
    const { t } = useTranslation();
    const { actionState, dataState, scope } = useRuntime();
    const { columns = [], emptyText = t('studio_apps_runtime.ui.nothing_to_show', 'Nothing to show yet.'), rowLimit = 25 } = node.props || {};
    const { value: source, isLoading, error, errorCode } = useStickyBinding(
        resolveBinding(node.props?.source, { actionState, dataState, scope }),
    );

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
        ? columns.filter((c) => c && !c.hidden)
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
    const now = Date.parse(scope?.now) || null;
    return (
        <div className="w-full overflow-x-auto app-scroll-edges">
            {/* app-grid-base carries the shared table rhythm (header weight,
                row hover, middle-aligned cells, tabular figures) so the two
                table components look like one product. */}
            <table className={`w-full app-grid-base ${size === 'sm' ? 'text-xs' : 'text-sm'}${look === 'striped' ? ' app-grid-zebra' : ''}`}>
                <thead>
                    <tr>
                        {cols.map((col) => {
                            const align = alignFor(col);
                            return (
                                <th
                                    key={col.key}
                                    scope="col"
                                    className={`${ALIGN_CLASS[align]} font-medium ${cellPad}${divider}${minimal ? ' text-xs uppercase tracking-wider' : ''}`}
                                    style={{ color: 'var(--text-secondary)', borderColor: 'var(--border-default)' }}
                                >
                                    {col.label || col.key}
                                </th>
                            );
                        })}
                    </tr>
                </thead>
                <tbody>
                    {rows.map((row, i) => (
                        <tr key={i}>
                            {cols.map((col) => (
                                <td
                                    key={col.key}
                                    className={`${cellPad}${divider} align-middle ${ALIGN_CLASS[alignFor(col)]}${col.truncate ? ' truncate max-w-0' : ''}`}
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
                    className="px-1 pt-1.5 text-xs"
                    style={{ color: 'var(--text-secondary)' }}
                    data-app-table-truncated={hidden}
                >
                    {t('studio_apps_runtime.table.showing', 'Showing {shown} of {total}.', { shown: rows.length, total: allRows.length.toLocaleString() })}
                </p>
            ) : null}
        </div>
    );
}
