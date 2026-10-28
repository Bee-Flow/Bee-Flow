import { useEffect, useRef, useState } from 'react';
import { INPUT_CLS } from '../kit';
import useTranslation from '@/hooks/useTranslation';
import FilterRowsEditor from '@/components/admin/Studio/AppStudio/bi/FilterRowsEditor';
import { AGGS, DATE_BUCKETS } from '@/components/admin/Studio/AppStudio/bi/QueryBuilder';
import useAppTables, { fieldsForTable } from '@/components/admin/Studio/AppStudio/bi/useAppTables';
import type { BindingDraft, AggregateBindingProps, PickValueFieldProps } from '../BindingField.types';

export function AggregateBinding({ binding, onChange, appId, disabled, definition, node, singleValue = false }: AggregateBindingProps) {
    const { t } = useTranslation();
    const { tables, isLoading } = useAppTables(appId);
    const tableId = binding.tableId || '';
    const fields = fieldsForTable(tables, tableId);
    const aggregates = Array.isArray(binding.aggregates) && binding.aggregates.length
        ? binding.aggregates
        : [{ fn: 'count', as: 'count' }];
    const groupBy = Array.isArray(binding.groupBy) ? binding.groupBy : [];

    const patch = (delta: Partial<BindingDraft>) => onChange({ ...binding, ...delta });

    // The column names this answer table carries — same aliasing the query
    // compiler applies, and the same list datasetColumns builds for a saved view.
    const columns = [
        ...aggregates.map((a) => a?.as || (a?.fn ? `${a.fn}_${a.field || 'all'}` : null)),
        ...groupBy.map((g) => g?.as || (g?.bucket ? `${g.field}_${g.bucket}` : g?.field)),
    ].filter((c): c is string => typeof c === 'string' && !!c);

    // Not split by anything → the answer IS one number, and asking which column
    // it is would be busywork. Split, and the choice is real, so the field below
    // asks. Guarded on the binding object like DatasetBinding's: a fill the
    // parent drops must not retry every render.
    const autoPicked = useRef<BindingDraft | null>(null);
    useEffect(() => {
        if (!singleValue || disabled) return;
        if (!tableId || binding.pick || groupBy.length || !columns.length) return;
        if (autoPicked.current === binding) return;
        autoPicked.current = binding;
        onChange({ ...binding, pick: { row: 'first', column: columns[0] } });
    });

    if (!appId) {
        return <p className="text-xs text-[var(--text-secondary)]">{t('studio_apps_panels.binding.open_app_pick_table', 'Open the app to pick a table.')}</p>;
    }
    if (isLoading) {
        return <p className="text-xs text-[var(--text-secondary)]">{t('studio_apps_panels.binding.loading_the_tables', 'Loading the tables…')}</p>;
    }

    return (
        <div className="flex flex-col gap-2">
            <select
                className={INPUT_CLS}
                value={tableId}
                onChange={(e) => patch({ tableId: e.target.value })}
                disabled={disabled}
                aria-label={t('studio_apps_panels.binding.table_to_count', 'Table to count')}
            >
                <option value="">{t('studio_apps_panels.binding.pick_table', 'Pick a table…')}</option>
                {tables.map((tbl) => <option key={tbl.id} value={tbl.id}>{tbl.name || tbl.key}</option>)}
            </select>

            {tableId ? (
                <>
                    <div className="grid grid-cols-2 gap-2">
                        <select
                            className={INPUT_CLS}
                            value={aggregates[0]?.fn || 'count'}
                            onChange={(e) => {
                                const fn = e.target.value;
                                const field = fn === 'count' ? undefined : (aggregates[0]?.field || fields[0]?.key);
                                patch({ aggregates: [{ fn, ...(field ? { field } : {}), as: fn }] });
                            }}
                            disabled={disabled}
                            aria-label={t('studio_apps_panels.binding.what_to_work_out', 'What to work out')}
                        >
                            {AGGS.map((a) => <option key={a.value} value={a.value}>{t(a.labelKey, a.label)}</option>)}
                        </select>

                        {/* `count` counts rows; everything else needs a column. */}
                        {aggregates[0]?.fn && aggregates[0].fn !== 'count' ? (
                            <select
                                className={INPUT_CLS}
                                value={aggregates[0]?.field || ''}
                                onChange={(e) => patch({ aggregates: [{ ...aggregates[0], field: e.target.value }] })}
                                disabled={disabled}
                                aria-label={t('studio_apps_panels.binding.which_column', 'Which column')}
                            >
                                <option value="">{t('studio_apps_panels.binding.pick_column', 'Pick a column…')}</option>
                                {fields.map((f) => <option key={f.key} value={f.key}>{f.name || f.key}</option>)}
                            </select>
                        ) : <span />}
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                        <select
                            className={INPUT_CLS}
                            value={groupBy[0]?.field || ''}
                            onChange={(e) => {
                                const field = e.target.value;
                                patch({ groupBy: field ? [{ field, ...(groupBy[0]?.bucket ? { bucket: groupBy[0].bucket } : {}) }] : undefined });
                            }}
                            disabled={disabled}
                            aria-label={t('studio_apps_panels.binding.split_by', 'Split by')}
                        >
                            <option value="">{t('studio_apps_panels.binding.one_number', 'One number for everything')}</option>
                            {fields.map((f) => <option key={f.key} value={f.key}>{t('studio_apps_panels.binding.per_field', 'Per {name}', { name: f.name || f.key })}</option>)}
                        </select>

                        {/* A date column split "per day" rather than per exact
                            timestamp is the only useful reading of it. */}
                        {groupBy[0]?.field && ['date', 'datetime'].includes(fields.find((f) => f.key === groupBy[0]?.field)?.type ?? '') ? (
                            <select
                                className={INPUT_CLS}
                                value={groupBy[0]?.bucket || ''}
                                onChange={(e) => patch({ groupBy: [{ ...groupBy[0], ...(e.target.value ? { bucket: e.target.value } : {}) }] })}
                                disabled={disabled}
                                aria-label={t('studio_apps_panels.binding.group_dates', 'Group dates')}
                            >
                                {DATE_BUCKETS.map((b) => <option key={b.value} value={b.value}>{t(b.labelKey, b.label)}</option>)}
                            </select>
                        ) : <span />}
                    </div>

                    <FilterRowsEditor
                        fields={fields}
                        filters={Array.isArray(binding.filter) ? binding.filter : []}
                        onChange={(filter) => patch({ filter: filter.length ? filter : undefined })}
                        allowFormula
                        disabled={disabled}
                        definition={definition}
                        node={node}
                    />

                    {singleValue && groupBy.length ? (
                        <PickValueField
                            pick={binding.pick}
                            columns={columns}
                            onChange={(pick) => patch({ pick })}
                            disabled={disabled}
                        />
                    ) : null}
                </>
            ) : null}
        </div>
    );
}

const TYPE_MY_OWN = '__own';

export function PickValueField({ pick, columns, onChange, disabled }: PickValueFieldProps) {
    const { t } = useTranslation();
    const [typing, setTyping] = useState(false);
    const column = pick?.column || '';
    const row = pick?.row === 'last' ? 'last' : 'first';
    const showText = !columns.length || typing || (!!column && !columns.includes(column));

    const set = (p: { row: string; } | { column: string; }) => onChange({ row, column, ...p });

    return (
        <div className="flex flex-col gap-1.5 rounded-md border border-[var(--border-subtle)] p-2">
            <span className="text-xs font-medium text-[var(--text-secondary)]">{t('studio_apps_panels.binding.which_number', 'Which number should this show?')}</span>
            <div className="flex items-center gap-2 min-w-0">
                <select
                    className={INPUT_CLS}
                    value={row}
                    onChange={(e) => set({ row: e.target.value })}
                    disabled={disabled}
                    aria-label={t('studio_apps_panels.binding.which_row', 'Which row')}
                >
                    <option value="first">{t('studio_apps_panels.binding.first_row', 'First row')}</option>
                    <option value="last">{t('studio_apps_panels.binding.last_row', 'Last row')}</option>
                </select>
                {columns.length ? (
                    <select
                        className={INPUT_CLS}
                        value={showText ? TYPE_MY_OWN : column}
                        onChange={(e) => {
                            if (e.target.value === TYPE_MY_OWN) { setTyping(true); return; }
                            setTyping(false);
                            set({ column: e.target.value });
                        }}
                        disabled={disabled}
                        aria-label={t('studio_apps_panels.binding.which_column', 'Which column')}
                    >
                        <option value="">{t('studio_apps_panels.binding.pick_column', 'Pick a column…')}</option>
                        {columns.map((c) => <option key={c} value={c}>{c}</option>)}
                        <option value={TYPE_MY_OWN}>{t('studio_apps_panels.binding.type_name', 'Type a name myself…')}</option>
                    </select>
                ) : null}
            </div>
            {showText ? (
                <input
                    type="text"
                    className={INPUT_CLS}
                    value={column}
                    onChange={(e) => set({ column: e.target.value })}
                    placeholder={t('studio_apps_panels.binding.column_name', 'Column name')}
                    disabled={disabled}
                    spellCheck={false}
                    aria-label={t('studio_apps_panels.binding.column_name', 'Column name')}
                />
            ) : null}
            {!column ? (
                <p className="text-xs text-[var(--text-secondary)]">{t('studio_apps_panels.binding.until_pick', 'Until you pick one, the tile shows the whole answer instead of a single number.')}</p>
            ) : null}
        </div>
    );
}
