import { Loader2, Table2 } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { inputCls, RepeatableList } from '@/components/admin/product-website/fields';
import type { TranslateFn, TranslateParams } from '@/hooks/useTranslation';
import type { DatasetGroup } from './useDatasets';
import type { TableColumn } from '../inspector/aiFieldMatching';

// The pieces of the Query Builder modal: the measure and date-bucket vocabularies,
// the breakdown and measure lists, the preview result, and the empty and footer rows.

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

export const DATE_TYPES = new Set<string | undefined>(['date', 'datetime']);
export const PREVIEW_ROWS = 8;

/** "Sum of Amount" — the row header for one measure, in plain words. */
function measureSentence(a: { agg: string; field: string; label: string; }, fieldName: (key: string) => string, t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string) {
    const agg = AGGS.find((x) => x.value === a.agg) || AGGS[1];
    if (a.agg === 'count' && !a.field) return t('studio_apps_bi.query.count_every_row', 'Count of every row');
    return t('studio_apps_bi.query.measure_of', '{agg} of {field}', { agg: t(agg.labelKey, agg.label), field: fieldName(a.field) || '…' });
}


function formatCell(v: string | number) {
    if (v == null) return '—';
    if (typeof v === 'number') return v.toLocaleString();
    return String(v);
}


/** Cancel, and Use this (spinning while the save or the preview for this query is in flight). */
export function QueryFooter({ t, onClose, onSave, disabled, busy }: { t: TranslateFn; onClose: (() => void) | undefined; onSave: () => void; disabled: boolean; busy: boolean }) {
    return (
        <>
            <button type="button" onClick={onClose} className="px-3 py-1.5 rounded-md text-sm font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]">{t('studio_apps_bi.common.cancel', 'Cancel')}</button>
            <button
                type="button"
                onClick={onSave}
                disabled={disabled}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-semibold text-white disabled:opacity-40 bg-[var(--accent-primary)]"
            >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                {t('studio_apps_bi.query.use_this', 'Use this')}
            </button>
        </>
    );
}

/** No table in the app yet: offer to add one (when the editor can open Tables) or say where. */
export function NoTables({ t, onClose, onOpenTables }: { t: TranslateFn; onClose: (() => void) | undefined; onOpenTables: (() => void) | null }) {
    return (
    <div className="py-10 text-center text-sm text-[var(--text-muted)]">
        <p className="mb-3">{t('studio_apps_bi.query.no_tables', 'There are no tables in this app yet — a table is where its information lives.')}</p>
        {onOpenTables ? (
            <button
                type="button"
                onClick={() => { onClose?.(); onOpenTables(); }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-semibold text-white bg-[var(--accent-primary)]"
            >
                <Table2 className="w-4 h-4" aria-hidden="true" /> {t('studio_apps_bi.query.add_table', 'Add a table')}
            </button>
        ) : (
            <p>{t('studio_apps_bi.query.add_table_hint', 'Add one with the Data button in the toolbar first.')}</p>
        )}
    </div>
    );
}

type Measure = { agg: string; field: string; label: string };

interface BreakdownFieldProps {
    t: TranslateFn;
    groupBy: DatasetGroup[];
    setGroupBy: Dispatch<SetStateAction<DatasetGroup[]>>;
    fields: TableColumn[];
    fieldName: (key: string | undefined) => string;
    fieldType: (key: string | undefined) => string | undefined;
}

/** Break it down by: a column per row, with a date grouping for date columns. */
export function BreakdownField({ t, groupBy, setGroupBy, fields, fieldName, fieldType }: BreakdownFieldProps) {
    return (
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
    );
}

interface MeasuresFieldProps {
    t: TranslateFn;
    aggregates: Measure[];
    setAggregates: Dispatch<SetStateAction<Measure[]>>;
    fields: TableColumn[];
    fieldName: (key: string | undefined) => string;
}

/** What do you want to see: a measure per row (count, sum, … of a column), optionally renamed. */
export function MeasuresField({ t, aggregates, setAggregates, fields, fieldName }: MeasuresFieldProps) {
    return (
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
    );
}

interface PreviewResultProps {
    t: TranslateFn;
    unknownFields: (string | undefined)[];
    valid: boolean;
    preview: Pick<UseQueryResult<unknown, Error>, 'isLoading' | 'isError' | 'error'>;
    rows: Record<string, string | number>[];
    columns: string[];
    fieldName: (key: string | undefined) => string;
}

/** The preview box's content: a vanished column, nothing chosen, running, failed, no rows, or the first rows. */
export function PreviewResult({ t, unknownFields, valid, preview, rows, columns, fieldName }: PreviewResultProps) {
    return unknownFields.length ? (
        <p className="text-xs text-[var(--error)]">
            {t('studio_apps_bi.query.unknown_fields', 'This table has no {fields} column any more. Pick another column above (or remove that row).', { fields: unknownFields.map((k) => fieldName(k)).join(', ') })}
        </p>
    ) : !valid ? (
        <p className="text-xs text-[var(--text-muted)]">{t('studio_apps_bi.query.choose_for_preview', 'Choose what you want to see to get a preview.')}</p>
    ) : preview.isLoading ? (
        <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]"><Loader2 className="w-4 h-4 animate-spin" /> {t('studio_apps_bi.query.running', 'Running…')}</div>
    ) : preview.isError ? (
        <p className="text-xs text-[var(--error)]">{preview.error?.message || t('studio_apps_bi.query.preview_failed', 'Preview failed.')}</p>
    ) : rows.length === 0 ? (
        <p className="text-xs text-[var(--text-muted)]">{t('studio_apps_bi.query.no_rows', 'No rows match this query.')}</p>
    ) : (
        <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse">
                <thead>
                    <tr>
                        {columns.map((c) => (
                            <th key={c} className="text-left font-medium text-[var(--text-secondary)] px-2 py-1 border-b border-[var(--border-subtle)]">{c}</th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {rows.slice(0, PREVIEW_ROWS).map((row, ri) => (
                        <tr key={ri}>
                            {columns.map((c) => (
                                <td key={c} className="px-2 py-1 border-b border-[var(--border-subtle)] text-[var(--text-primary)] truncate max-w-[160px]">{formatCell(row[c])}</td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
            {rows.length > PREVIEW_ROWS ? (
                <p className="text-[11px] text-[var(--text-muted)] mt-1">{t('studio_apps_bi.query.more_rows', '+{n} more rows', { n: rows.length - PREVIEW_ROWS })}</p>
            ) : null}
        </div>
    );
}
