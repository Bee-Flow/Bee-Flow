import useTranslation from '@/hooks/useTranslation';
import { MAX_INDEXES, MAX_INDEX_FIELDS, indexableColumns, indexesOf, withIndexes } from './linkedFieldsModel';
import type { IndexSpec } from './linkedFieldsModel';
import type { ModelTable } from './tablesManagerModel';

/**
 * App Studio table editor — the declared indexes of a table (`table.indexes`): each one a few
 * stored columns, in the order they are ticked. Adding or removing one never changes a row.
 */

interface TableIndexesEditorProps {
    table: ModelTable;
    onChange: (table: ModelTable) => void;
    disabled: boolean;
}

const BTN_CLS = 'self-start rounded-md border px-2 py-1 text-xs disabled:opacity-50 border-[var(--border-default)] text-[var(--text-secondary)]';

export default function TableIndexesEditor({ table, onChange, disabled }: TableIndexesEditorProps) {
    const { t } = useTranslation();
    const indexes = indexesOf(table);
    const columns = indexableColumns(table);
    const save = (next: IndexSpec[]) => onChange(withIndexes(table, next));
    const toggle = (i: number, key: string, on: boolean) => {
        const fields = on ? [...indexes[i].fields, key] : indexes[i].fields.filter((k) => k !== key);
        save(indexes.map((ix, n) => (n === i ? { fields } : ix)));
    };
    return (
        <div className="flex flex-col gap-2">
            <span className="text-xs font-medium text-[var(--text-secondary)]">{t('studio_apps_di.indexes', 'Indexes')}</span>
            <p className="text-xs text-[var(--text-tertiary)]">{t('studio_apps_di.index_hint', 'Makes filters and sorts on these columns fast on big tables. Adding or removing one never changes a row.')}</p>
            {indexes.map((ix, i) => (
                <fieldset key={i} className="flex flex-col gap-1 rounded-md border p-2 border-[var(--border-default)]">
                    <legend className="text-xs text-[var(--text-secondary)]">{t('studio_apps_di.index_n', 'Index {n}', { n: i + 1 })}</legend>
                    <div className="flex flex-wrap gap-3 text-xs text-[var(--text-secondary)]">
                        {columns.map((c) => {
                            const at = ix.fields.indexOf(c.key);
                            return (
                                <label key={c.key} className="inline-flex items-center gap-1.5 cursor-pointer">
                                    <input type="checkbox" className="accent-[var(--accent-primary)]" checked={at >= 0}
                                        disabled={disabled || (at < 0 && ix.fields.length >= MAX_INDEX_FIELDS)}
                                        onChange={(e) => toggle(i, c.key, e.target.checked)} />
                                    {at >= 0 ? `${at + 1}. ${c.label}` : c.label}
                                </label>
                            );
                        })}
                    </div>
                    <button type="button" className={BTN_CLS} disabled={disabled} onClick={() => save(indexes.filter((_, n) => n !== i))}>
                        {t('studio_apps_di.remove_index', 'Remove index')}
                    </button>
                </fieldset>
            ))}
            {indexes.length < MAX_INDEXES ? (
                <button type="button" className={BTN_CLS} disabled={disabled || !columns.length} onClick={() => save([...indexes, { fields: [columns[0].key] }])}>
                    {t('studio_apps_di.add_index', 'Add index')}
                </button>
            ) : null}
        </div>
    );
}
