import { Database } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { INPUT_CLS } from '../kit';
import useTranslation from '../../../../../../../hooks/useTranslation';
import QueryBuilder from '../../../bi/QueryBuilder';
import useDatasets from '../../../bi/useDatasets';
import type { Dataset } from '../../../bi/useDatasets';
import type { BindingDraft, DatasetBindingProps } from '../BindingField.types';
import { PickValueField } from './AggregateBinding';

/**
 * The column names a saved view produces — its numbers first, then its
 * breakdowns. Mirrors the aliasing in server/appStudio/queryCompiler.js
 * (compileAggregate): an explicit `as`, else the bucketed `field_bucket`,
 * else the field name.
 */
export function datasetColumns(dataset: Dataset | null) {
    const d = dataset && typeof dataset.descriptor === 'object' ? dataset.descriptor : null;
    if (!d) return [];
    const out: string[] = [];
    const add = (name: string | null | undefined) => { if (typeof name === 'string' && name && !out.includes(name)) out.push(name); };
    for (const a of Array.isArray(d.aggregates) ? d.aggregates : []) {
        if (a && typeof a === 'object') add(a.as || (a.fn ? `${a.fn}_${a.field || 'all'}` : null));
    }
    for (const g of Array.isArray(d.groupBy) ? d.groupBy : []) {
        if (g && typeof g === 'object') add(g.as || (g.bucket ? `${g.field}_${g.bucket}` : g.field));
    }
    return out;
}

export function DatasetBinding({ binding, onChange, onBuild, appId, componentType, singleValue, disabled }: DatasetBindingProps) {
    const { t } = useTranslation();
    const { datasets, isLoading } = useDatasets(appId);
    const [building, setBuilding] = useState(false);
    const autoPicked = useRef<BindingDraft | null>(null);

    const selected = useMemo(
        () => datasets.find((d) => d && d.id === binding.datasetId) || null,
        [datasets, binding.datasetId],
    );
    const columns = useMemo(() => datasetColumns(selected), [selected]);

    // A view built here lands before its columns are known, so the first number
    // it produces is filled in as soon as they arrive — otherwise the tile keeps
    // rendering the whole answer. Only a binding that carries NO pick at all is
    // filled: once the field has been offered, an empty column is the user's own
    // answer. The guard is the binding OBJECT, not its id — one panel instance
    // serves every node of a type, and a fill that the parent drops must not
    // retry on the next render.
    useEffect(() => {
        if (!singleValue || disabled) return;
        if (!binding.datasetId || binding.pick || !columns.length) return;
        if (autoPicked.current === binding) return;
        autoPicked.current = binding;
        onChange({ ...binding, pick: { row: 'first', column: columns[0] } });
    }, [singleValue, disabled, binding, columns, onChange]);

    if (!appId) {
        return <p className="text-xs text-[var(--text-secondary)]">{t('studio_apps_panels.binding.open_app_use_view', 'Open the app to use a saved view.')}</p>;
    }

    // Switching to another view invalidates a column chosen from the old one.
    const selectDataset = (id: string) => onChange({ kind: 'dataset', datasetId: id || null });

    return (
        <div className="flex flex-col gap-2">
            <select
                className={INPUT_CLS}
                value={binding.datasetId || ''}
                onChange={(e) => selectDataset(e.target.value)}
                disabled={disabled}
                aria-label={t('studio_apps_panels.binding.saved_view', 'Saved view')}
            >
                <option value="">{isLoading ? t('studio_apps_panels.binding.loading_views', 'Loading saved views…') : t('studio_apps_panels.binding.pick_view', 'Pick a saved view…')}</option>
                {datasets.map((d) => <option key={d.id} value={d.id}>{d.name || d.id}</option>)}
            </select>
            {singleValue && binding.datasetId ? (
                <PickValueField
                    pick={binding.pick}
                    columns={columns}
                    onChange={(pick) => onChange({ ...binding, pick })}
                    disabled={disabled}
                />
            ) : null}
            <button
                type="button"
                onClick={() => setBuilding(true)}
                disabled={disabled}
                className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-sm font-medium border border-[var(--border-default)] bg-[var(--bg-tertiary)] text-[var(--text-primary)] hover:border-[var(--accent-primary)] disabled:opacity-50 transition-colors"
            >
                <Database className="w-4 h-4" aria-hidden="true" /> {t('studio_apps_panels.binding.build_view', 'Build a new view…')}
            </button>
            {building ? (
                <QueryBuilder
                    open={building}
                    onClose={() => setBuilding(false)}
                    appId={appId}
                    componentType={componentType}
                    onSave={(built: { datasetId: string; }) => {
                        if (!built?.datasetId) return;
                        // onBuild lets the owning inspector land the new view and
                        // whatever it prefills (a chart's mapping) in ONE patch.
                        if (onBuild) onBuild(built); else selectDataset(built.datasetId);
                    }}
                />
            ) : null}
        </div>
    );
}
