import { useQuery } from '@tanstack/react-query';
import { Database, Loader2, Table2 } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import ChartDataPanel, { deriveChartMapping } from './ChartDataPanel';
import FilterRowsEditor, { NO_VALUE_OPS } from './FilterRowsEditor';
import useAppTables, { fieldsForTable } from './useAppTables';
import useDatasets from './useDatasets';
import useTranslation from '../../../../../hooks/useTranslation';
import { API_BASE, authFetch } from '../../../../../utils/helpers';
import Modal from '../../../../shared/Modal';
import toast from '../../../../shared/Toast';
import { inputCls, RepeatableList } from '../../../product-website/fields';
import { useEditorChrome } from '../editor/EditorChromeContext';
import AppChart from '../runtime/components/AppChart';
import { DEFAULT_RUNTIME, RuntimeProvider } from '../runtime/RuntimeContext';

/**
 * App Studio BI — the visual Query Builder.
 *
 * Pick a source table, group-by dimensions (with an optional date bucket),
 * measures (count/sum/avg/min/max) and filters; a debounced live preview POSTs
 * the built descriptor to /data/query (RLS-scoped, cache-aware server-side) and
 * renders it as a small table + a live AppChart. Save persists a named dataset
 * and returns its id (plus, for charts, the column→series mapping) to the
 * caller, which points props.source at { kind:'dataset', datasetId }.
 *
 * No SQL is ever produced here — only a structured aggregate descriptor
 * (filters/groupBy/aggregates) that server/appStudio/queryCompiler.js compiles.
 * Filters are structured {field, op, value} rows because that is exactly what
 * compileAggregate consumes (its closed FILTER_OPS vocabulary).
 */

// `label` is the English default, `labelKey` its translation key: render
// with t(x.labelKey, x.label).
export const AGGS = [
    { value: 'count', label: 'Count', labelKey: 'studio_apps_bi.query.agg_count' },
    { value: 'sum', label: 'Sum', labelKey: 'studio_apps_bi.query.agg_sum' },
    { value: 'avg', label: 'Average', labelKey: 'studio_apps_bi.query.agg_avg' },
    { value: 'min', label: 'Lowest', labelKey: 'studio_apps_bi.query.agg_min' },
    { value: 'max', label: 'Highest', labelKey: 'studio_apps_bi.query.agg_max' },
];

export const DATE_BUCKETS = [
    { value: '', label: 'Exact', labelKey: 'studio_apps_bi.query.bucket_exact' },
    { value: 'day', label: 'By day', labelKey: 'studio_apps_bi.query.bucket_day' },
    { value: 'week', label: 'By week', labelKey: 'studio_apps_bi.query.bucket_week' },
    { value: 'month', label: 'By month', labelKey: 'studio_apps_bi.query.bucket_month' },
    { value: 'quarter', label: 'By quarter', labelKey: 'studio_apps_bi.query.bucket_quarter' },
    { value: 'year', label: 'By year', labelKey: 'studio_apps_bi.query.bucket_year' },
];

const DATE_TYPES = new Set(['date', 'datetime']);
const PREVIEW_ROWS = 8;

// A stable run-mode runtime so the preview AppChart draws real rows (not the
// edit-mode placeholder) without needing the editor's providers.
const PREVIEW_RUNTIME = { ...DEFAULT_RUNTIME, mode: 'run' };

function useDebounced(value, delay) {
    const [debounced, setDebounced] = useState(value);
    useEffect(() => {
        const t = setTimeout(() => setDebounced(value), delay);
        return () => clearTimeout(t);
    }, [value, delay]);
    return debounced;
}

/**
 * Read a number the way people type it here: this is a Dutch product, so
 * "1.234,56" and "1,5" mean 1234.56 and 1.5. Returns null when it is not a
 * number at all (the value then travels on as text, as before).
 */
export function parseUserNumber(input) {
    if (typeof input === 'number') return Number.isFinite(input) ? input : null;
    let s = String(input ?? '').replace(/\s/g, '');
    if (!s) return null;
    const comma = s.lastIndexOf(',');
    const dot = s.lastIndexOf('.');
    if (comma >= 0 && dot >= 0) {
        // The LAST separator is the decimal one; the other groups thousands.
        const thousands = comma > dot ? '.' : ',';
        s = s.split(thousands).join('');
        if (comma > dot) s = s.replace(',', '.');
    } else if (comma >= 0) {
        s = /^-?\d{1,3}(,\d{3})+$/.test(s) ? s.split(',').join('') : s.replace(',', '.');
    }
    if (!/^-?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
}

/** "Sum of Amount" — the row header for one measure, in plain words. */
function measureSentence(a, fieldName, t) {
    const agg = AGGS.find((x) => x.value === a.agg) || AGGS[1];
    if (a.agg === 'count' && !a.field) return t('studio_apps_bi.query.count_every_row', 'Count of every row');
    return t('studio_apps_bi.query.measure_of', '{agg} of {field}', { agg: t(agg.labelKey, agg.label), field: fieldName(a.field) || '…' });
}

/** Constrain a human label to the compiler's alias grammar (ALIAS_RE). */
function sanitizeAlias(label, fallback) {
    let s = String(label || '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
    if (!s || !/^[a-z]/.test(s)) s = fallback;
    return s;
}

/** Build the structured aggregate descriptor compileAggregate consumes. */
export function buildDescriptor(tableId, fields, groupBy, aggregates, filters) {
    const fieldType = (key) => (fields.find((f) => f.key === key) || {}).type;

    const gb = (groupBy || [])
        .filter((g) => g.field)
        .map((g) => (g.bucket && DATE_TYPES.has(fieldType(g.field)) ? { field: g.field, bucket: g.bucket } : { field: g.field }));

    const usedAliases = new Set();
    const aggs = (aggregates || [])
        .filter((a) => a.agg && (a.agg === 'count' || a.field))
        .map((a) => {
            const isCount = a.agg === 'count';
            let alias = sanitizeAlias(a.label, isCount ? 'count' : `${a.agg}_${a.field || 'x'}`);
            let n = 2;
            while (usedAliases.has(alias)) alias = `${alias.slice(0, 58)}_${n++}`;
            usedAliases.add(alias);
            return { fn: a.agg, ...(isCount && !a.field ? {} : { field: a.field }), as: alias };
        });

    const flt = (filters || [])
        .filter((f) => f.field && f.op)
        .map((f) => {
            const base = { field: f.field, op: f.op };
            if (NO_VALUE_OPS.has(f.op)) return base;
            let value = f.value;
            if (fieldType(f.field) === 'number' && typeof value !== 'boolean' && value !== '' && value != null) {
                const num = parseUserNumber(value);
                if (num != null) value = num;
            }
            return { ...base, value: value ?? '' };
        });

    // A row left pointing at a field the table doesn't have would compile to a
    // broken query server-side — name them so the user can repick, and block.
    const known = new Set(fields.map((f) => f.key));
    const referenced = [...gb, ...aggs, ...flt].map((x) => x.field).filter(Boolean);
    const unknownFields = [...new Set(referenced.filter((k) => !known.has(k)))];

    return {
        descriptor: { groupBy: gb, aggregates: aggs, filters: flt },
        unknownFields,
        valid: !!tableId && (gb.length > 0 || aggs.length > 0) && unknownFields.length === 0,
    };
}

async function runPreview(appId, payload, t) {
    const res = await authFetch(`${API_BASE}/api/studio-apps/${encodeURIComponent(appId)}/data/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tableId: payload.tableId, aggregate: payload.descriptor }),
    });
    if (res.status === 404) return { rows: [] };
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    if (!res.ok) throw new Error(body?.error || t('studio_apps_bi.query.preview_failed_status', 'Preview failed ({status})', { status: res.status }));
    return { rows: Array.isArray(body?.rows) ? body.rows : [] };
}

export default function QueryBuilder({ open, onClose, appId, componentType = 'chart', onSave, onOpenTables = null }) {
    const { t } = useTranslation();
    const { tables, isLoading: tablesLoading } = useAppTables(open ? appId : null);
    const { saveDataset, saving } = useDatasets(appId);

    const [tableId, setTableId] = useState('');
    const [groupBy, setGroupBy] = useState([]);
    const [aggregates, setAggregates] = useState([]);
    const [filters, setFilters] = useState([]);
    const [name, setName] = useState('');
    const [chartMapping, setChartMapping] = useState(null);

    const fields = useMemo(() => fieldsForTable(tables, tableId), [tables, tableId]);
    const fieldName = useCallback((key) => (fields.find((f) => f.key === key) || {}).name || key || '', [fields]);
    const fieldType = useCallback((key) => (fields.find((f) => f.key === key) || {}).type, [fields]);

    // Auto-select the first table, and seed a Count measure so the preview and
    // descriptor are valid the moment a table is chosen.
    useEffect(() => {
        if (!open) return;
        if (!tableId && tables.length) setTableId(tables[0].id);
    }, [open, tables, tableId]);
    // Keyed on the table alone, during render: a new table drops the chart
    // mapping and, while nothing is configured yet, seeds the Count measure.
    const [seededTableId, setSeededTableId] = useState(null);
    if (seededTableId !== tableId) {
        setSeededTableId(tableId);
        setChartMapping(null);
        if (tableId && aggregates.length === 0 && groupBy.length === 0) {
            setAggregates([{ agg: 'count', field: '', label: 'Count' }]);
        }
    }

    // Another table means other columns — every row that named a field of the
    // old one is dropped, so nothing keeps pointing at a column that is gone.
    const changeTable = (nextId) => {
        if (nextId === tableId) return;
        setTableId(nextId);
        setGroupBy([]);
        setFilters([]);
        setAggregates([{ agg: 'count', field: '', label: 'Count' }]);
        setChartMapping(null);
    };

    const { descriptor, valid, unknownFields } = useMemo(
        () => buildDescriptor(tableId, fields, groupBy, aggregates, filters),
        [tableId, fields, groupBy, aggregates, filters],
    );

    // Debounced live preview: the key carries the exact payload, so the fetch
    // always matches the key. `enabled` is gated on the DEBOUNCED payload's
    // validity (not the live one) so a mid-debounce empty descriptor can never
    // fire a stale request.
    const previewKey = useMemo(() => JSON.stringify({ tableId, descriptor }), [tableId, descriptor]);
    const debouncedKey = useDebounced(previewKey, 350);
    const debouncedValid = useMemo(() => {
        try {
            const p = JSON.parse(debouncedKey);
            const gb = p?.descriptor?.groupBy;
            const ag = p?.descriptor?.aggregates;
            return !!p?.tableId && ((Array.isArray(gb) && gb.length > 0) || (Array.isArray(ag) && ag.length > 0));
        } catch { return false; }
    }, [debouncedKey]);
    const preview = useQuery({
        queryKey: ['studio-app-query-preview', appId, debouncedKey],
        queryFn: () => runPreview(appId, JSON.parse(debouncedKey), t),
        enabled: !!open && !!appId && debouncedValid,
        retry: false,
        staleTime: 10_000,
    });

    const previewRows = useMemo(() => (Array.isArray(preview.data?.rows) ? preview.data.rows : []), [preview.data]);
    const previewColumns = useMemo(
        () => (previewRows[0] && typeof previewRows[0] === 'object' ? Object.keys(previewRows[0]) : []),
        [previewRows],
    );

    // Both ends of the mapping must still exist in the result — a series key
    // left over from an earlier query would otherwise be saved into the chart.
    const effectiveMapping = useMemo(() => {
        const seriesResolve = (chartMapping?.series || []).every((s) => previewColumns.includes(s.key));
        if (chartMapping && previewColumns.includes(chartMapping.xKey) && seriesResolve) return chartMapping;
        return deriveChartMapping(previewColumns, previewRows, chartMapping?.chartType || 'bar');
    }, [chartMapping, previewColumns, previewRows]);

    const previewChartNode = useMemo(() => ({
        id: 'qb_preview_chart',
        type: 'chart',
        props: {
            chartType: effectiveMapping.chartType,
            source: { kind: 'static', value: previewRows },
            xKey: effectiveMapping.xKey,
            series: effectiveMapping.series,
            showLegend: true,
            showGrid: true,
            valueFormat: 'number',
        },
        style: { height: 'md' },
    }), [effectiveMapping, previewRows]);

    const currentTable = tables.find((tb) => tb.id === tableId) || null;

    // The chart mapping is read off the preview columns, so it is only real
    // once the preview for THIS query has landed — saving mid-refetch would
    // hand the component an empty mapping.
    const previewPending = valid && (previewKey !== debouncedKey || preview.isFetching);

    const handleSave = useCallback(async () => {
        if (!valid || previewPending) return;
        try {
            const res = await saveDataset({
                name: name.trim() || (currentTable?.name ? t('studio_apps_bi.query.view_named', '{table} view', { table: currentTable.name }) : t('studio_apps_bi.query.view', 'View')),
                tableId,
                source: { kind: 'aggregate' },
                descriptor,
                cacheTtlSeconds: 60,
            });
            const dataset = res?.dataset;
            if (!dataset?.id) throw new Error(t('studio_apps_bi.query.save_failed', 'This view could not be saved.'));
            const chart = componentType === 'chart' && effectiveMapping.xKey ? effectiveMapping : null;
            onSave?.({ datasetId: dataset.id, chart });
            toast.success(t('studio_apps_bi.query.saved', 'Saved.'));
            onClose?.();
        } catch (err) {
            toast.error(err?.message || t('studio_apps_bi.query.save_failed_generic', 'Could not save this view.'));
        }
    }, [valid, previewPending, saveDataset, name, currentTable, tableId, descriptor, onSave, componentType, effectiveMapping, onClose, t]);

    return (
        <Modal
            open={open}
            onClose={onClose}
            size="xl"
            title={componentType === 'chart' ? t('studio_apps_bi.query.title_chart', 'What should this chart show?') : t('studio_apps_bi.query.title', 'What should this show?')}
            description={t('studio_apps_bi.query.description', 'Pick a table, then choose what you want to see.')}
            footer={(
                <>
                    <button type="button" onClick={onClose} className="px-3 py-1.5 rounded-md text-sm font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]">{t('studio_apps_bi.common.cancel', 'Cancel')}</button>
                    <button
                        type="button"
                        onClick={handleSave}
                        disabled={!valid || saving || previewPending}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-semibold text-white disabled:opacity-40"
                        style={{ background: 'var(--accent-primary)' }}
                    >
                        {saving || previewPending ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                        {t('studio_apps_bi.query.use_this', 'Use this')}
                    </button>
                </>
            )}
        >
            {tablesLoading ? (
                <div className="flex items-center justify-center py-10 text-[var(--text-muted)]">
                    <Loader2 className="w-5 h-5 animate-spin" />
                </div>
            ) : tables.length === 0 ? (
                <div className="py-10 text-center text-sm text-[var(--text-muted)]">
                    <p className="mb-3">{t('studio_apps_bi.query.no_tables', 'There are no tables in this app yet — a table is where its information lives.')}</p>
                    {onOpenTables ? (
                        <button
                            type="button"
                            onClick={() => { onClose?.(); onOpenTables(); }}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-semibold text-white"
                            style={{ background: 'var(--accent-primary)' }}
                        >
                            <Table2 className="w-4 h-4" aria-hidden="true" /> {t('studio_apps_bi.query.add_table', 'Add a table')}
                        </button>
                    ) : (
                        <p>{t('studio_apps_bi.query.add_table_hint', 'Add one with the Data button in the toolbar first.')}</p>
                    )}
                </div>
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-5 min-w-0">
                    {/* ── LEFT: query configuration ── */}
                    <div className="flex flex-col gap-4 min-w-0">
                        <label className="flex flex-col gap-1">
                            <span className="text-xs font-medium text-[var(--text-secondary)]">{t('studio_apps_bi.query.which_table', 'Which table?')}</span>
                            <select className={inputCls} value={tableId} onChange={(e) => changeTable(e.target.value)} aria-label={t('studio_apps_bi.query.which_table_aria', 'Which table')}>
                                {tables.map((tb) => <option key={tb.id} value={tb.id}>{tb.name || tb.key}</option>)}
                            </select>
                        </label>

                        <fieldset className="min-w-0">
                            <RepeatableList
                                label={t('studio_apps_bi.query.break_down', 'Break it down by')}
                                items={groupBy}
                                onChange={setGroupBy}
                                makeNew={() => ({ field: '', bucket: '' })}
                                addLabel={t('studio_apps_bi.query.add_breakdown', 'Add a breakdown')}
                                itemLabel={(g) => fieldName(g.field) || t('studio_apps_bi.query.pick_column_label', 'Pick a column')}
                                renderItem={(g, update) => (
                                    <div className="flex flex-col gap-2">
                                        <select className={inputCls} value={g.field || ''} onChange={(e) => update({ ...g, field: e.target.value, bucket: '' })} aria-label={t('studio_apps_bi.query.break_down_by', 'Break down by')}>
                                            <option value="">{t('studio_apps_bi.chart.pick_column', 'Pick a column…')}</option>
                                            {fields.map((f) => <option key={f.key} value={f.key}>{f.name || f.key}</option>)}
                                        </select>
                                        {DATE_TYPES.has(fieldType(g.field)) ? (
                                            <select className={inputCls} value={g.bucket || ''} onChange={(e) => update({ ...g, bucket: e.target.value })} aria-label={t('studio_apps_bi.query.group_dates', 'Group dates')}>
                                                {DATE_BUCKETS.map((b) => <option key={b.value} value={b.value}>{t(b.labelKey, b.label)}</option>)}
                                            </select>
                                        ) : null}
                                    </div>
                                )}
                            />
                        </fieldset>

                        <fieldset className="min-w-0">
                            <RepeatableList
                                label={t('studio_apps_bi.query.what_to_see', 'What do you want to see?')}
                                items={aggregates}
                                onChange={setAggregates}
                                makeNew={() => ({ agg: 'sum', field: '', label: '' })}
                                addLabel={t('studio_apps_bi.query.add_number', 'Add a number')}
                                itemLabel={(a) => a.label || measureSentence(a, fieldName, t)}
                                renderItem={(a, update) => (
                                    <div className="flex flex-col gap-2">
                                        <div className="flex items-center gap-2 min-w-0">
                                            <select
                                                className={inputCls}
                                                value={a.agg || 'sum'}
                                                onChange={(e) => update({ ...a, agg: e.target.value, ...(e.target.value === 'count' ? { field: '' } : {}) })}
                                                aria-label={t('studio_apps_bi.query.what_to_work_out', 'What to work out')}
                                            >
                                                {AGGS.map((x) => <option key={x.value} value={x.value}>{t(x.labelKey, x.label)}</option>)}
                                            </select>
                                            <span className="shrink-0 text-xs text-[var(--text-secondary)]">{t('studio_apps_bi.query.of', 'of')}</span>
                                            <select className={inputCls} value={a.field || ''} onChange={(e) => update({ ...a, field: e.target.value })} aria-label={t('studio_apps_bi.query.which_column', 'Which column')} disabled={a.agg === 'count'}>
                                                <option value="">{a.agg === 'count' ? t('studio_apps_bi.query.every_row', 'every row') : t('studio_apps_bi.chart.pick_column', 'Pick a column…')}</option>
                                                {fields.map((f) => <option key={f.key} value={f.key}>{f.name || f.key}</option>)}
                                            </select>
                                        </div>
                                        <input type="text" className={inputCls} value={a.label || ''} onChange={(e) => update({ ...a, label: e.target.value })} placeholder={t('studio_apps_bi.query.call_it', 'Call it something else (optional)')} spellCheck={false} />
                                    </div>
                                )}
                            />
                        </fieldset>

                        <FilterRowsEditor fields={fields} filters={filters} onChange={setFilters} label={t('studio_apps_bi.query.only_count_where', 'Only count rows where')} />


                        <label className="flex flex-col gap-1">
                            <span className="text-xs font-medium text-[var(--text-secondary)]">{t('studio_apps_bi.query.name_view', 'Name this view')}</span>
                            <input type="text" className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder={currentTable?.name ? t('studio_apps_bi.query.view_named', '{table} view', { table: currentTable.name }) : t('studio_apps_bi.query.view', 'View')} />
                        </label>
                    </div>

                    {/* ── RIGHT: live preview ── */}
                    <div className="flex flex-col gap-4 min-w-0">
                        <div className="min-w-0">
                            <div className="text-xs font-medium text-[var(--text-secondary)] mb-1.5">{t('studio_apps_bi.query.preview', 'Preview')}</div>
                            <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-tertiary)] p-3 min-h-[120px]">
                                {unknownFields.length ? (
                                    <p className="text-xs" style={{ color: 'var(--error)' }}>
                                        {t('studio_apps_bi.query.unknown_fields', 'This table has no {fields} column any more. Pick another column above (or remove that row).', { fields: unknownFields.map((k) => fieldName(k)).join(', ') })}
                                    </p>
                                ) : !valid ? (
                                    <p className="text-xs text-[var(--text-muted)]">{t('studio_apps_bi.query.choose_for_preview', 'Choose what you want to see to get a preview.')}</p>
                                ) : preview.isLoading ? (
                                    <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]"><Loader2 className="w-4 h-4 animate-spin" /> {t('studio_apps_bi.query.running', 'Running…')}</div>
                                ) : preview.isError ? (
                                    <p className="text-xs" style={{ color: 'var(--error)' }}>{preview.error?.message || t('studio_apps_bi.query.preview_failed', 'Preview failed.')}</p>
                                ) : previewRows.length === 0 ? (
                                    <p className="text-xs text-[var(--text-muted)]">{t('studio_apps_bi.query.no_rows', 'No rows match this query.')}</p>
                                ) : (
                                    <div className="overflow-x-auto">
                                        <table className="w-full text-xs border-collapse">
                                            <thead>
                                                <tr>
                                                    {previewColumns.map((c) => (
                                                        <th key={c} className="text-left font-medium text-[var(--text-secondary)] px-2 py-1 border-b border-[var(--border-subtle)]">{c}</th>
                                                    ))}
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {previewRows.slice(0, PREVIEW_ROWS).map((row, ri) => (
                                                    <tr key={ri}>
                                                        {previewColumns.map((c) => (
                                                            <td key={c} className="px-2 py-1 border-b border-[var(--border-subtle)] text-[var(--text-primary)] truncate max-w-[160px]">{formatCell(row[c])}</td>
                                                        ))}
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                        {previewRows.length > PREVIEW_ROWS ? (
                                            <p className="text-[11px] text-[var(--text-muted)] mt-1">{t('studio_apps_bi.query.more_rows', '+{n} more rows', { n: previewRows.length - PREVIEW_ROWS })}</p>
                                        ) : null}
                                    </div>
                                )}
                            </div>
                        </div>

                        {componentType === 'chart' && valid && previewRows.length > 0 ? (
                            <>
                                <div className="rounded-lg border border-[var(--border-subtle)] p-3 min-w-0" data-testid="qb-chart-preview">
                                    <RuntimeProvider value={PREVIEW_RUNTIME}>
                                        <AppChart node={previewChartNode} />
                                    </RuntimeProvider>
                                </div>
                                <ChartDataPanel columns={previewColumns} rows={previewRows} value={effectiveMapping} onChange={setChartMapping} />
                            </>
                        ) : null}
                    </div>
                </div>
            )}
        </Modal>
    );
}

function formatCell(v) {
    if (v == null) return '—';
    if (typeof v === 'number') return v.toLocaleString();
    return String(v);
}

/**
 * The inspector affordance: a "Configure data" button that opens the builder
 * and, on save, points the node's data binding at the new dataset (and, for a
 * chart, prefills chartType/xKey/series from the column mapping). `patch` is the
 * inspector's own updateNodeProps→onCommit committer, so a chart lands in ONE
 * history entry. appId comes from the editor-chrome context; the button renders
 * inert (disabled) outside the editor shell, where no appId is in scope — so the
 * per-type inspector smoke tests stay green. (Inspectors also pass node/
 * definition for symmetry; they're unused here and safely ignored.)
 */
export function ConfigureDataButton({ patch, componentType = 'chart', disabled = false }) {
    const { t } = useTranslation();
    const chrome = useEditorChrome();
    const appId = chrome?.appId ?? null;
    const [open, setOpen] = useState(false);

    const handleSave = useCallback(({ datasetId, chart }) => {
        if (!datasetId) return;
        // Point the node's data binding at the saved dataset. `stat` has no
        // `source` prop (its binding is `value`) — writing `source` there would
        // trip validate.js's prop.unknown guard and make the app unsaveable — so
        // it targets `value` instead. Everyone else uses `source`.
        const bindingProp = componentType === 'stat' ? 'value' : 'source';
        const p = { [bindingProp]: { kind: 'dataset', datasetId } };
        if (componentType === 'chart' && chart) {
            if (chart.chartType) p.chartType = chart.chartType;
            if (chart.xKey) p.xKey = chart.xKey;
            if (Array.isArray(chart.series) && chart.series.length) {
                p.series = chart.series.map((s) => ({ key: s.key, label: s.label || s.key, ...(s.color ? { color: s.color } : {}) }));
            }
        }
        patch?.(p);
    }, [componentType, patch]);

    return (
        <div className="flex flex-col gap-1">
            <button
                type="button"
                disabled={disabled || !appId}
                onClick={() => setOpen(true)}
                className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-sm font-medium border border-[var(--border-default)] bg-[var(--bg-tertiary)] text-[var(--text-primary)] hover:border-[var(--accent-primary)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
                <Database className="w-4 h-4" aria-hidden="true" /> {t('studio_apps_bi.query.configure_data', 'Configure data')}
            </button>
            {!appId ? <p className="text-[11px] text-[var(--text-muted)]">{t('studio_apps_bi.query.open_app', 'Open the app to build a dataset.')}</p> : null}
            {open && appId ? (
                <QueryBuilder
                    open={open}
                    onClose={() => setOpen(false)}
                    appId={appId}
                    componentType={componentType}
                    onSave={handleSave}
                    onOpenTables={chrome?.openTables || null}
                />
            ) : null}
        </div>
    );
}
