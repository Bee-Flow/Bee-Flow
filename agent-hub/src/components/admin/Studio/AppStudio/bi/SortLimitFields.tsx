import useTranslation from '@/hooks/useTranslation';
import { inputCls } from '@/components/admin/product-website/fields';
import type { DatasetSort } from './datasetShape';

interface SortLimitFieldsProps {
    /** The columns the view's answer has (breakdowns and measures). */
    columns: string[];
    sort: DatasetSort | null;
    limit: number | null;
    onSort: (next: DatasetSort | null) => void;
    onLimit: (next: number | null) => void;
}

/** "Sort by" and "Show at most": the order and size of a view's rows. */
export default function SortLimitFields({ columns, sort, limit, onSort, onLimit }: SortLimitFieldsProps) {
    const { t } = useTranslation();
    const current = sort && columns.includes(sort.field) ? sort : null;
    return (
        <div className="flex flex-col gap-2">
            <div className="flex items-end gap-2">
                <label className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="text-xs font-medium text-[var(--text-secondary)]">
                        {t('studio_apps_surfaces.sort_by', 'Sort by')}
                    </span>
                    <select
                        className={inputCls}
                        value={current?.field || ''}
                        onChange={(e) => onSort(e.target.value ? { field: e.target.value, dir: current?.dir || 'desc' } : null)}
                        aria-label={t('studio_apps_surfaces.sort_by', 'Sort by')}
                    >
                        <option value="">{t('studio_apps_surfaces.sort_none', 'No particular order')}</option>
                        {columns.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                </label>
                <select
                    className={inputCls}
                    value={current?.dir || 'desc'}
                    disabled={!current}
                    onChange={(e) => current && onSort({ field: current.field, dir: e.target.value === 'asc' ? 'asc' : 'desc' })}
                    aria-label={t('studio_apps_surfaces.sort_direction', 'Sort direction')}
                >
                    <option value="desc">{t('studio_apps_surfaces.sort_desc', 'Highest first')}</option>
                    <option value="asc">{t('studio_apps_surfaces.sort_asc', 'Lowest first')}</option>
                </select>
            </div>
            <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-[var(--text-secondary)]">
                    {t('studio_apps_surfaces.limit', 'Show at most')}
                </span>
                <input
                    type="number"
                    min={1}
                    className={inputCls}
                    value={limit ?? ''}
                    placeholder={t('studio_apps_surfaces.limit_none', 'All rows')}
                    onChange={(e) => {
                        const n = Math.floor(Number(e.target.value));
                        onLimit(e.target.value !== '' && Number.isFinite(n) && n > 0 ? n : null);
                    }}
                    aria-label={t('studio_apps_surfaces.limit', 'Show at most')}
                />
            </label>
        </div>
    );
}
