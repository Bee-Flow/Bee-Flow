import useTranslation from '@/hooks/useTranslation';
import type { ModelField, ModelTable } from './tablesManagerModel';

const SELECT_CLS = 'w-full px-3 py-2 text-sm rounded-md border bg-[var(--bg-secondary)] border-[var(--border-default)] text-[var(--text-primary)] disabled:opacity-50';

interface RelationDisplayFieldProps {
    field: ModelField;
    set: (patch: Partial<ModelField>) => void;
    tables?: ModelTable[] | null;
    disabled?: boolean;
}

/**
 * Which column of the related table names a record (`relation.displayField`, a column key of the target).
 * Empty means the automatic choice, as before. Only columns that hold a plain value are offered: a relation
 * or a file has no readable label.
 */
export default function RelationDisplayField({ field, set, tables, disabled = false }: RelationDisplayFieldProps) {
    const { t } = useTranslation();
    const target = (tables || []).find((tb) => tb.id === field.relation?.table);
    if (!target) return null;
    const columns = (target.fields || []).filter((f) => f.key && f.type !== 'relation' && f.type !== 'file');
    const current = field.relation?.displayField || '';
    return (
        <label className="flex flex-col gap-1 text-xs font-medium text-[var(--text-secondary)]">
            {t('studio_apps_surfaces.relation_display', 'Show this column for each record')}
            <select
                className={SELECT_CLS}
                value={current}
                onChange={(e) => {
                    const { displayField: _drop, ...rest } = field.relation || {};
                    set({ relation: e.target.value ? { ...rest, displayField: e.target.value } : rest });
                }}
                disabled={disabled}
                aria-label={t('studio_apps_surfaces.relation_display', 'Show this column for each record')}
            >
                <option value="">{t('studio_apps_surfaces.relation_display_auto', 'Automatic (first text column)')}</option>
                {columns.map((c) => <option key={c.key} value={c.key}>{c.name || c.key}</option>)}
                {/* A saved value that is no longer a column stays visible instead of silently reading as Automatic. */}
                {current && !columns.some((c) => c.key === current) ? <option value={current}>{current}</option> : null}
            </select>
        </label>
    );
}
