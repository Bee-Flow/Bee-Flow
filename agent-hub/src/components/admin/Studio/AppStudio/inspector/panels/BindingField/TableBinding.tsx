import { INPUT_CLS } from '../kit';
import useTranslation from '@/hooks/useTranslation';
import FilterRowsEditor from '@/components/admin/Studio/AppStudio/bi/FilterRowsEditor';
import useAppTables, { fieldsForTable } from '@/components/admin/Studio/AppStudio/bi/useAppTables';
import type { BindingDraft, TableBindingProps } from '../BindingField.types';
import { SortLevels } from './SortLevels';
import { PickValueField } from './AggregateBinding';
import { MatchMode, SearchOption } from './ReadOptions';
import { RelatedFields } from './RelatedFields';
import { relationFilterFields } from '@/components/admin/Studio/AppStudio/bi/relationRead';

export function TableBinding({ binding, onChange, appId, disabled, definition, node, singleValue = false }: TableBindingProps) {
    const { t } = useTranslation();
    const { tables, isLoading } = useAppTables(appId);
    const isSingle = binding.kind === 'record';
    const tableId = binding.tableId || '';
    const fields = fieldsForTable(tables, tableId);

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
                        fields={[...fields, ...relationFilterFields(tables, tableId)]}
                        filters={Array.isArray(binding.filter) ? binding.filter : []}
                        onChange={(filter) => patch({ filter: filter.length ? filter : undefined })}
                        allowFormula
                        allowGroups
                        allowIgnoreCase
                        disabled={disabled}
                        definition={definition}
                        node={node}
                    />

                    {Array.isArray(binding.filter) && binding.filter.length > 1 ? (
                        <MatchMode match={binding.match} onChange={(match) => patch({ match })} disabled={disabled} />
                    ) : null}
                    <SearchOption
                        search={binding.search}
                        fields={fields}
                        onChange={(search) => patch({ search })}
                        disabled={disabled}
                        definition={definition}
                        node={node}
                    />

                    <SortLevels
                        binding={binding}
                        fields={fields}
                        disabled={disabled}
                        onPatch={({ sort, orderBy }) => {
                            // `orderBy` exists only on a binding that sorts on several columns.
                            const { orderBy: _dropped, ...rest } = binding;
                            onChange(orderBy === undefined ? { ...rest, sort } : { ...rest, sort, orderBy });
                        }}
                    />

                    <RelatedFields
                        binding={binding}
                        tables={tables}
                        fields={fields}
                        disabled={disabled}
                        onPatch={(p) => {
                            // `expand` and `fields` exist only on a binding that uses them.
                            const next = { ...binding, ...p };
                            if (next.expand === undefined) delete next.expand;
                            if (next.fields === undefined) delete next.fields;
                            onChange(next);
                        }}
                    />

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
