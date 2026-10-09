import { useVirtualizer } from '@tanstack/react-virtual';
import React, { useMemo, useRef } from 'react';
import useTranslation from '../../../../../../hooks/useTranslation';
import { makeValueFormatter } from '../chartPalette';
import { resolveBinding } from '../resolveBinding';
import { useRuntime } from '../RuntimeContext';
import { EM_DASH, EmptyText, ErrorText, SkeletonLines, useStickyBinding } from '../uiBits';

/** App Studio runtime — 'pivot'. Spec: server/appStudio/componentSpecs.js. */

const VIRTUALIZE_THRESHOLD = 50;
const MAX_COL_GROUPS = 60; // abuse guard: a runaway column dimension
const SEP = '\u0000';

const disp = (v) => (v == null || v === '' ? EM_DASH : String(v));

/** Aggregate an array of raw cell values by the value field's agg function. */
function aggregate(values, agg) {
    if (agg === 'count') return values.length;
    const nums = values.map(Number).filter(Number.isFinite);
    if (agg === 'min') return nums.length ? Math.min(...nums) : null;
    if (agg === 'max') return nums.length ? Math.max(...nums) : null;
    const total = nums.reduce((a, b) => a + b, 0);
    if (agg === 'avg') return nums.length ? total / nums.length : null;
    return total; // sum (default)
}

function formatCell(value, format, fmt) {
    if (value == null) return EM_DASH;
    if (format === 'date') {
        const d = new Date(value);
        return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleDateString();
    }
    return fmt(value);
}

export default function AppPivot({ node }) {
    const { t } = useTranslation();
    const { actionState, dataState, scope } = useRuntime();
    const props = node.props || {};
    const {
        rows: rowDimsRaw = [], columns: colDimsRaw = [], values: valuesRaw = [],
        showTotals = true, emptyText = t('studio_apps_runtime.ui.nothing_to_show', 'Nothing to show yet.'),
    } = props;

    const { value: source, isLoading, error, errorCode } = useStickyBinding(
        resolveBinding(props.source, { actionState, dataState, scope }),
    );

    // Identity-stable so the model below actually memoizes: the raw prop arrays
    // are stable, the filtered copies would be new objects on every render.
    const rowDims = useMemo(
        () => (Array.isArray(rowDimsRaw) ? rowDimsRaw : []).filter((d) => d && d.key),
        [rowDimsRaw],
    );
    const colDims = useMemo(
        () => (Array.isArray(colDimsRaw) ? colDimsRaw : []).filter((d) => d && d.key),
        [colDimsRaw],
    );
    // No value fields configured → an implicit COUNT so the pivot is never blank.
    const valDefs = (Array.isArray(valuesRaw) ? valuesRaw : []).filter((v) => v && v.key);
    const values = valDefs.length ? valDefs : [{ key: '__count', agg: 'count', label: t('studio_apps_runtime.pivot.count', 'Count'), format: 'number' }];

    // One pass over the source bins every row into its row group AND its column
    // bucket, so a cell is a map lookup. Re-deriving the bucket per cell makes
    // the render quadratic in (rows × columns).
    const model = useMemo(() => {
        const src = (Array.isArray(source) ? source : []).filter((r) => r && typeof r === 'object');

        const rowGroups = [];
        const rowIndex = new Map();
        const colGroups = [];
        const colIndex = new Map();
        const allByCol = new Map();
        for (const r of src) {
            const vals = rowDims.map((d) => disp(r[d.key]));
            const key = vals.join(SEP);
            let g = rowIndex.get(key);
            if (!g) { g = { key, values: vals, rows: [], byCol: new Map() }; rowIndex.set(key, g); rowGroups.push(g); }
            g.rows.push(r);

            if (!colDims.length) continue;
            const colVals = colDims.map((d) => disp(r[d.key]));
            const colKey = colVals.join(SEP);
            if (!colIndex.has(colKey)) { colIndex.set(colKey, true); colGroups.push({ key: colKey, values: colVals }); }
            if (!g.byCol.has(colKey)) g.byCol.set(colKey, []);
            g.byCol.get(colKey).push(r);
            if (!allByCol.has(colKey)) allByCol.set(colKey, []);
            allByCol.get(colKey).push(r);
        }
        colGroups.sort((a, b) => a.key.localeCompare(b.key));

        // How many the cap dropped, so the table can SAY so: row and grand
        // totals aggregate over every row, and on a wide pivot that made the
        // Total disagree with the sum of the visible columns for no stated
        // reason.
        const hiddenCols = Math.max(0, colGroups.length - MAX_COL_GROUPS);
        return { rowGroups, colGroups: colGroups.slice(0, MAX_COL_GROUPS), allRows: src, allByCol, hiddenCols };
    }, [source, rowDims, colDims]);

    const { rowGroups, colGroups, allRows, allByCol, hiddenCols } = model;

    const cellFor = (group, colGroup, valDef) => {
        const rows = colGroup ? (group.byCol.get(colGroup.key) || []) : group.rows;
        const raw = rows.map((r) => r[valDef.key]);
        return aggregate(raw, valDef.agg || 'sum');
    };

    const virtualize = rowGroups.length > VIRTUALIZE_THRESHOLD;
    const scrollRef = useRef(null);
    const virtualizer = useVirtualizer({
        count: rowGroups.length,
        getScrollElement: () => scrollRef.current,
        estimateSize: () => 36,
        overscan: 8,
        enabled: virtualize,
    });

    if (error) return <ErrorText error={error} errorCode={errorCode} />;

    if (isLoading) return <SkeletonLines lines={5} />;
    if (rowGroups.length === 0) return <EmptyText text={emptyText} />;

    const size = node.style?.size || 'md';
    const cellPad = size === 'sm' ? 'px-2 py-1' : 'px-2.5 py-1.5';
    const multiValue = values.length > 1;
    const hasCols = colGroups.length > 0;
    // Leaf columns = (each colGroup × each value) [+ a Total group when showTotals]
    const colLeafCount = hasCols
        ? colGroups.length * values.length + (showTotals ? values.length : 0)
        : values.length;
    // With no row dimension the head/body/total rows still open with ONE stub
    // cell — drop it from any of the three and every value shifts a column.
    const stubCols = Math.max(1, rowDims.length);
    const totalCols = stubCols + colLeafCount;

    const valueFmt = (valDef) => makeValueFormatter(valDef.format || 'number');

    const numTd = (value, valDef, extra = {}) => (
        <td
            className={`${cellPad} border-b text-right tabular-nums`}
            style={{ borderColor: 'var(--border-default)', ...extra }}
        >
            {formatCell(value, valDef.format, valueFmt(valDef))}
        </td>
    );

    const renderRow = (group) => {
        const totalsPerVal = values.map((v) => aggregate(group.rows.map((r) => r[v.key]), v.agg || 'sum'));
        return (
            <tr key={group.key}>
                {rowDims.map((d, i) => (
                    <th
                        key={d.key}
                        scope="row"
                        className={`${cellPad} border-b text-left font-medium`}
                        style={{ color: 'var(--text-primary)', borderColor: 'var(--border-default)' }}
                    >
                        {group.values[i]}
                    </th>
                ))}
                {rowDims.length === 0 ? (
                    <th scope="row" className={`${cellPad} border-b`} style={{ borderColor: 'var(--border-default)' }} />
                ) : null}
                {hasCols
                    ? colGroups.map((cg) => values.map((v) => (
                        <React.Fragment key={`${cg.key}:${v.key}`}>{numTd(cellFor(group, cg, v), v)}</React.Fragment>
                    )))
                    : values.map((v) => (
                        <React.Fragment key={v.key}>{numTd(cellFor(group, null, v), v)}</React.Fragment>
                    ))}
                {hasCols && showTotals
                    ? values.map((v, i) => (
                        <React.Fragment key={`total:${v.key}`}>
                            {numTd(totalsPerVal[i], v, { background: 'var(--bg-tertiary)', fontWeight: 600 })}
                        </React.Fragment>
                    ))
                    : null}
            </tr>
        );
    };

    // Grand totals row (per leaf column) when totals are on.
    const grandTotalRow = () => {
        const all = allRows;
        return (
            <tr style={{ background: 'var(--bg-tertiary)' }}>
                <th
                    scope="row"
                    colSpan={stubCols}
                    className={`${cellPad} border-b text-left font-semibold`}
                    style={{ color: 'var(--text-primary)', borderColor: 'var(--border-default)' }}
                >
                    {t('studio_apps_runtime.pivot.total', 'Total')}
                </th>
                {hasCols
                    ? colGroups.map((cg) => values.map((v) => {
                        const rows = allByCol.get(cg.key) || [];
                        return (
                            <React.Fragment key={`gt:${cg.key}:${v.key}`}>
                                {numTd(aggregate(rows.map((r) => r[v.key]), v.agg || 'sum'), v, { fontWeight: 600 })}
                            </React.Fragment>
                        );
                    }))
                    : values.map((v) => (
                        <React.Fragment key={`gt:${v.key}`}>
                            {numTd(aggregate(all.map((r) => r[v.key]), v.agg || 'sum'), v, { fontWeight: 600 })}
                        </React.Fragment>
                    ))}
                {hasCols && showTotals
                    ? values.map((v) => (
                        <React.Fragment key={`gtsum:${v.key}`}>
                            {numTd(aggregate(all.map((r) => r[v.key]), v.agg || 'sum'), v, { fontWeight: 700 })}
                        </React.Fragment>
                    ))
                    : null}
            </tr>
        );
    };

    const virtualItems = virtualize ? virtualizer.getVirtualItems() : null;
    const padTop = virtualItems && virtualItems.length ? virtualItems[0].start : 0;
    const padBottom = virtualItems && virtualItems.length
        ? virtualizer.getTotalSize() - virtualItems[virtualItems.length - 1].end : 0;

    const headStyle = { color: 'var(--text-secondary)', borderColor: 'var(--border-default)' };

    const table = (
        <table className={`w-full ${size === 'sm' ? 'text-xs' : 'text-sm'}`}>
            <thead>
                <tr>
                    {rowDims.map((d) => (
                        <th
                            key={d.key}
                            scope="col"
                            rowSpan={hasCols && multiValue ? 2 : 1}
                            className={`${cellPad} border-b text-left font-medium`}
                            style={headStyle}
                        >
                            {d.label || d.key}
                        </th>
                    ))}
                    {rowDims.length === 0 ? (
                        <th scope="col" rowSpan={hasCols && multiValue ? 2 : 1} className={`${cellPad} border-b`} style={headStyle} />
                    ) : null}
                    {hasCols
                        ? colGroups.map((cg) => (
                            <th
                                key={cg.key}
                                scope="col"
                                colSpan={values.length}
                                className={`${cellPad} border-b text-center font-medium`}
                                style={headStyle}
                            >
                                {cg.values.join(' / ')}
                            </th>
                        ))
                        : values.map((v) => (
                            <th key={v.key} scope="col" className={`${cellPad} border-b text-right font-medium`} style={headStyle}>
                                {v.label || v.key}
                            </th>
                        ))}
                    {hasCols && showTotals ? (
                        <th
                            scope="col"
                            colSpan={values.length}
                            className={`${cellPad} border-b text-center font-semibold`}
                            style={{ ...headStyle, background: 'var(--bg-tertiary)' }}
                        >
                            {t('studio_apps_runtime.pivot.total', 'Total')}
                        </th>
                    ) : null}
                </tr>
                {hasCols && multiValue ? (
                    <tr>
                        {colGroups.map((cg) => values.map((v) => (
                            <th key={`${cg.key}:${v.key}`} scope="col" className={`${cellPad} border-b text-right font-medium`} style={headStyle}>
                                {v.label || v.key}
                            </th>
                        )))}
                        {showTotals ? values.map((v) => (
                            <th key={`th:${v.key}`} scope="col" className={`${cellPad} border-b text-right font-medium`} style={{ ...headStyle, background: 'var(--bg-tertiary)' }}>
                                {v.label || v.key}
                            </th>
                        )) : null}
                    </tr>
                ) : null}
            </thead>
            <tbody>
                {virtualize ? (
                    <>
                        {padTop > 0 ? <tr aria-hidden="true" style={{ height: padTop }}><td colSpan={totalCols} /></tr> : null}
                        {virtualItems.map((vi) => renderRow(rowGroups[vi.index]))}
                        {padBottom > 0 ? <tr aria-hidden="true" style={{ height: padBottom }}><td colSpan={totalCols} /></tr> : null}
                    </>
                ) : (
                    rowGroups.map((g) => renderRow(g))
                )}
                {showTotals ? grandTotalRow() : null}
            </tbody>
        </table>
    );

    return (
        <div
            ref={scrollRef}
            className="w-full overflow-auto app-scroll-edges"
            style={virtualize ? { maxHeight: 360 } : undefined}
            data-app-pivot="true"
        >
            {table}
            {hiddenCols > 0 ? (
                <p
                    className="px-1 pt-1.5 text-xs"
                    style={{ color: 'var(--text-secondary)' }}
                    data-app-pivot-truncated={hiddenCols}
                >
                    {hiddenCols === 1
                        ? t('studio_apps_runtime.pivot.hidden_one', '{n} more column is not shown — the totals still count it.', { n: hiddenCols })
                        : t('studio_apps_runtime.pivot.hidden_many', '{n} more columns are not shown — the totals still count them.', { n: hiddenCols })}
                </p>
            ) : null}
        </div>
    );
}
