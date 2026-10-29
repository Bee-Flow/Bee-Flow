import { useQuery } from '@tanstack/react-query';
import { Database, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type ComponentProps } from 'react';
import ChartDataPanel, { deriveChartMapping } from './ChartDataPanel';
import FilterRowsEditor, { NO_VALUE_OPS, type FilterRow } from './FilterRowsEditor';
import useAppTables, { fieldsForTable } from './useAppTables';
import useDatasets from './useDatasets';
import useTranslation from '@/hooks/useTranslation';
import { runPreview } from './runPreview';
import Modal from '@/components/shared/Modal';
import toast from '@/components/shared/Toast';
import { inputCls } from '@/components/admin/product-website/fields';
import { BreakdownField, DATE_TYPES, MeasuresField, NoTables, PreviewResult, QueryFooter } from './QueryBuilderParts';
import { useEditorChrome } from '../editor/EditorChromeContext';
import AppChart from '../runtime/components/AppChart';
import { DEFAULT_RUNTIME, RuntimeProvider, type RuntimeValue } from '../runtime/RuntimeContext';
import type { QueryBuilderProps, ConfigureDataButtonProps } from './QueryBuilder.types';
import type { BuiltView } from '../inspector/panels/BindingField.types';
import type { DatasetGroup } from './useDatasets';
import type { ChartMapping } from './ChartDataPanel';
import type { TableColumn } from '../inspector/aiFieldMatching';

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

export { AGGS, DATE_BUCKETS } from './QueryBuilderParts';

// A stable run-mode runtime so the preview AppChart draws real rows (not the
// edit-mode placeholder) without needing the editor's providers.
const PREVIEW_RUNTIME: RuntimeValue = { ...DEFAULT_RUNTIME, mode: 'run' };

function useDebounced(value: string, delay: number) {
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
export function parseUserNumber(input: unknown) {
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

/** Constrain a human label to the compiler's alias grammar (ALIAS_RE). */
function sanitizeAlias(label: string | undefined, fallback: string) {
    let s = String(label || '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
    if (!s || !/^[a-z]/.test(s)) s = fallback;
    return s;
}

/** Build the structured aggregate descriptor compileAggregate consumes. */
export function buildDescriptor(tableId: string, fields: TableColumn[], groupBy: DatasetGroup[], aggregates: { agg: string; field?: string; label?: string }[], filters: FilterRow[]) {
    const fieldType = (key: string | undefined) => (fields.find((f) => f.key === key) || {}).type;
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
    const known = new Set<string | undefined>(fields.map((f) => f.key));
    const referenced = [...gb, ...aggs, ...flt].map((x) => x.field).filter(Boolean);
    const unknownFields = [...new Set(referenced.filter((k) => !known.has(k)))];
    return {
        descriptor: { groupBy: gb, aggregates: aggs, filters: flt },
        unknownFields,
        valid: !!tableId && (gb.length > 0 || aggs.length > 0) && unknownFields.length === 0,
    };
}

/** The live preview chart, as a static-source chart node over the preview rows. */
function previewChartNodeFor(effectiveMapping: ChartMapping, previewRows: unknown[]): ComponentProps<typeof AppChart>['node'] {
    return {
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
    };
}

export default function QueryBuilder({ open, onClose, appId, componentType = 'chart', onSave, onOpenTables = null }: QueryBuilderProps) {
    const { t } = useTranslation();
    const { tables, isLoading: tablesLoading } = useAppTables(open ? appId : null);
    const { saveDataset, saving } = useDatasets(appId);

    const [tableId, setTableId] = useState('');
    const [groupBy, setGroupBy] = useState<DatasetGroup[]>([]);
    const [aggregates, setAggregates] = useState<{ agg: string; field: string; label: string; }[]>([]);
    const [filters, setFilters] = useState<FilterRow[]>([]);
    const [name, setName] = useState('');
    const [chartMapping, setChartMapping] = useState<ChartMapping | null>(null);

    const fields = useMemo(() => fieldsForTable(tables, tableId), [tables, tableId]);
    const fieldName = useCallback((key: string | undefined) => (fields.find((f) => f.key === key) || {}).name || key || '', [fields]);
    const fieldType = useCallback((key: string | undefined) => (fields.find((f) => f.key === key) || {}).type, [fields]);

    // Auto-select the first table, and seed a Count measure so the preview and
    // descriptor are valid the moment a table is chosen.
    useEffect(() => {
        if (!open) return;
        if (!tableId && tables.length) setTableId(tables[0].id);
    }, [open, tables, tableId]);
    // Keyed on the table alone, during render: a new table drops the chart
    // mapping and, while nothing is configured yet, seeds the Count measure.
    const [seededTableId, setSeededTableId] = useState<string | null>(null);
    if (seededTableId !== tableId) {
        setSeededTableId(tableId);
        setChartMapping(null);
        if (tableId && aggregates.length === 0 && groupBy.length === 0) {
            setAggregates([{ agg: 'count', field: '', label: 'Count' }]);
        }
    }

    // Another table means other columns — every row that named a field of the
    // old one is dropped, so nothing keeps pointing at a column that is gone.
    const changeTable = (nextId: string) => {
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

    const previewChartNode = useMemo(() => previewChartNodeFor(effectiveMapping, previewRows), [effectiveMapping, previewRows]);

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
            toast.error((err as Error)?.message || t('studio_apps_bi.query.save_failed_generic', 'Could not save this view.'));
        }
    }, [valid, previewPending, saveDataset, name, currentTable, tableId, descriptor, onSave, componentType, effectiveMapping, onClose, t]);

    return (
        <Modal
            open={!!open}
            onClose={onClose}
            size="xl"
            title={componentType === 'chart' ? t('studio_apps_bi.query.title_chart', 'What should this chart show?') : t('studio_apps_bi.query.title', 'What should this show?')}
            description={t('studio_apps_bi.query.description', 'Pick a table, then choose what you want to see.')}
            footer={<QueryFooter t={t} onClose={onClose} onSave={handleSave} disabled={!valid || saving || previewPending} busy={saving || previewPending} />}
        >
            {tablesLoading ? (
                <div className="flex items-center justify-center py-10 text-[var(--text-muted)]">
                    <Loader2 className="w-5 h-5 animate-spin" />
                </div>
            ) : tables.length === 0 ? (
                <NoTables t={t} onClose={onClose} onOpenTables={onOpenTables} />
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

                        <BreakdownField t={t} groupBy={groupBy} setGroupBy={setGroupBy} fields={fields} fieldName={fieldName} fieldType={fieldType} />

                        <MeasuresField t={t} aggregates={aggregates} setAggregates={setAggregates} fields={fields} fieldName={fieldName} />

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
                                <PreviewResult t={t} unknownFields={unknownFields} valid={valid} preview={preview} rows={previewRows} columns={previewColumns} fieldName={fieldName} />
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

/**
 * The inspector affordance: a "Configure data" button that opens the builder
 * and, on save, points the node's data binding at the new dataset (and, for a
 * chart, prefills chartType/xKey/series from the column mapping). `patch` is the
 * inspector's own updateNodeProps→onCommit committer, so a chart lands in ONE
 * history entry. appId comes from the editor-chrome context; the button renders
 * inert (disabled) outside the editor shell, where no appId is in scope — so the
 * per-type inspector smoke tests stay green.
 */
export function ConfigureDataButton({ patch, componentType = 'chart', disabled = false }: ConfigureDataButtonProps) {
    const { t } = useTranslation();
    const chrome = useEditorChrome();
    const appId = chrome?.appId ?? null;
    const [open, setOpen] = useState(false);

    const handleSave = useCallback(({ datasetId, chart }: BuiltView) => {
        if (!datasetId) return;
        // Point the node's data binding at the saved dataset. `stat` has no
        // `source` prop (its binding is `value`) — writing `source` there would
        // trip validate.js's prop.unknown guard and make the app unsaveable — so
        // it targets `value` instead. Everyone else uses `source`.
        const bindingProp = componentType === 'stat' ? 'value' : 'source';
        const p: Record<string, unknown> = { [bindingProp]: { kind: 'dataset', datasetId } };
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
