import { INPUT_CLS } from '../kit';
import useTranslation from '@/hooks/useTranslation';
import FilterRowsEditor from '@/components/admin/Studio/AppStudio/bi/FilterRowsEditor';
import useAppTables, { fieldsForTable } from '@/components/admin/Studio/AppStudio/bi/useAppTables';
import type { BindingDraft, TableBindingProps } from '../BindingField.types';
import { normSort } from './BindingField.helpers';
import { PickValueField } from './AggregateBinding';

export function TableBinding({ binding, onChange, appId, disabled, definition, node, singleValue = false }: TableBindingProps) {
    const { t } = useTranslation();
    const { tables, isLoading } = useAppTables(appId);
    const isSingle = binding.kind === 'record';
    const tableId = binding.tableId || '';
    const fields = fieldsForTable(tables, tableId);
    const sort = normSort(binding.sort);

    if (!appId) {
        return <p className="text-xs text-[var(--text-secondary)]">{t('studio_apps_panels.binding.open_app_use_table', 'Open the app to use one of its tables.')}</p>;
    }
    if (isLoading) {
        return <p className="text-xs text-[var(--text-secondary)]">{t('studio_apps_panels.binding.loading_tables', 'Loading tables…')}</p>;
    }
    if (!tables.length) {
        return <p className="text-xs text-[var(--text-secondary)]">{t('studio_apps_panels.binding.no_tables', 'This app has no data tables yet. Add one in the data model first.')}</p>;
    }

    const patch = (p: Partial<BindingDraft>) => onChange({ ...binding, ...p });

    return (
        <div className="flex flex-col gap-2">
            <select
                className={INPUT_CLS}
                value={tableId}
                onChange={(e) => patch({ tableId: e.target.value })}
                disabled={disabled}
                aria-label={t('studio_apps_panels.binding.source_table', 'Source table')}
            >
                <option value="">{t('studio_apps_panels.binding.pick_table', 'Pick a table…')}</option>
                {tables.map((tbl) => <option key={tbl.id} value={tbl.id}>{tbl.name || tbl.key}</option>)}
            </select>

            {tableId ? (
                <>
                    <FilterRowsEditor
                        fields={fields}
                        filters={Array.isArray(binding.filter) ? binding.filter : []}
                        onChange={(filter) => patch({ filter: filter.length ? filter : undefined })}
                        allowFormula
                        disabled={disabled}
                        definition={definition}
                        node={node}
                    />

                    <div className="grid grid-cols-2 gap-2">
                        <select
                            className={INPUT_CLS}
                            value={sort?.field || ''}
                            onChange={(e) => patch({ sort: e.target.value ? [{ field: e.target.value, dir: sort?.dir || 'asc' }] : undefined })}
                            disabled={disabled}
                            aria-label={t('studio_apps_panels.binding.sort_field', 'Sort field')}
                        >
                            <option value="">{t('studio_apps_panels.binding.no_sort', 'No sort')}</option>
                            {fields.map((f) => <option key={f.key} value={f.key}>{f.name || f.key}</option>)}
                        </select>
                        <select
                            className={INPUT_CLS}
                            value={sort?.dir || 'asc'}
                            onChange={(e) => patch({ sort: sort?.field ? [{ field: sort.field, dir: e.target.value }] : undefined })}
                            disabled={disabled || !sort?.field}
                            aria-label={t('studio_apps_panels.binding.sort_direction', 'Sort direction')}
                        >
                            <option value="asc">{t('studio_apps_panels.binding.sort_asc', 'Ascending')}</option>
                            <option value="desc">{t('studio_apps_panels.binding.sort_desc', 'Descending')}</option>
                        </select>
                    </div>

                    <div className="flex items-center gap-2">
                        <label className="inline-flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
                            <input
                                type="checkbox"
                                checked={isSingle}
                                onChange={(e) => onChange({ ...binding, kind: e.target.checked ? 'record' : 'records' })}
                                disabled={disabled}
                                className="accent-[var(--accent-primary)]"
                            />
                            {t('studio_apps_panels.binding.single_row', 'Single row')}
                        </label>
                        {!isSingle ? (
                            <input
                                type="number"
                                className={`${INPUT_CLS} flex-1`}
                                value={binding.limit ?? ''}
                                min={1}
                                onChange={(e) => {
                                    const n = Number(e.target.value);
                                    patch({ limit: e.target.value === '' || !Number.isFinite(n) ? undefined : Math.max(1, Math.round(n)) });
                                }}
                                placeholder={t('studio_apps_panels.binding.row_limit_placeholder', 'Row limit (optional)')}
                                disabled={disabled}
                                aria-label={t('studio_apps_panels.binding.row_limit', 'Row limit')}
                            />
                        ) : null}
                    </div>

                    {/* A tile bound to a TABLE had no way to name the column,
                        although the runtime applies `pick` to record/records
                        exactly as it does to a saved view — so the tile was
                        handed the whole row array and showed an object where a
                        number belonged. */}
                    {singleValue ? (
                        <PickValueField
                            pick={binding.pick}
                            columns={fields.map((f) => f.key)}
                            onChange={(pick) => patch({ pick })}
                            disabled={disabled}
                        />
                    ) : null}
                </>
            ) : null}
        </div>
    );
}
